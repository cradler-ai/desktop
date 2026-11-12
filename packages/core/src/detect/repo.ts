import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import type { InputField, McpLocalSpec, McpRemoteSpec, RepoView } from '../types';
import type { CandidateSet } from '../merge';
import type { PackageChecker } from '../registry';
import { buildLocalSpec, buildRemoteSpec } from '../spec';
import { entryToSpec, parseConfigText, findServers } from '../parse/config';
import { scanMarkdown } from '../parse/markdown';
import type { ParsedCommand } from '../parse/command';
import { normalizePyName } from '../util/command';
import { sanitizeName } from '../util/names';
import { t } from '../i18n';

export interface DetectContext {
  checker: PackageChecker;
}

const IGNORED =
  /(^|\/)(node_modules|\.git|vendor|dist|build|out|\.next|__pycache__|\.venv|venv|target|coverage|__tests__|fixtures?|testdata)\//;
/** Example / docs folders: servers in here are demos, not the project's product. */
const NON_PRODUCT = /(^|\/)(examples?|samples?|demos?|docs?|templates?|playground|benchmarks?|tests?|e2e)\//i;
/** Hidden folders like .claude/skills hold the maintainers' own tools, not something to install. */
const HIDDEN_SEGMENT = /(^|\/)\.[^/]+\//;
const depth = (p: string) => p.split('/').length - 1;
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.split('/').pop() ?? p;

const NPM_MCP_DEP = /^(@modelcontextprotocol\/|fastmcp$|mcp-framework$|@mastra\/mcp$|mcp-handler$|xmcp$|@vercel\/mcp-adapter$|tmcp$|@tmcp\/)/;
const NPM_TOOLING = new Set(['fastmcp', 'mcp-framework', 'mcp-handler', 'xmcp', '@mastra/mcp', 'mcp-remote', 'tmcp']);
const PY_MCP_DEP = /^(mcp|fastmcp|mcp-server)(\[[^\]]*\])?\s*([<>=!~;@].*)?$/i;

/** Official marketplace names we know the source of. */
export const KNOWN_MARKETPLACES: Record<string, string> = {
  'claude-plugins-official': 'anthropics/claude-plugins-official',
};

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function safeJson(text: string | null): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const v = parseConfigText(text);
    return v ?? null;
  }
}

export function parseFrontmatter(md: string): Record<string, unknown> {
  const m = md.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try {
    const v = parseYaml(m[1]);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    const out: Record<string, unknown> = {};
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
    return out;
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export interface RepoScan {
  notes: string[];
  /** Marketplace sources mentioned by `/plugin marketplace add` in READMEs. */
  marketplaceSources: string[];
}

export async function detectRepo(view: RepoView, ctx: DetectContext, set: CandidateSet): Promise<RepoScan> {
  const files = view.files.filter((p) => !IGNORED.test(p));
  const notes: string[] = [];
  const slug = `${view.source.owner}/${view.source.repo}`;
  const fullPath = (p: string) => [view.subpath, p].filter(Boolean).join('/');
  const knownPackages = new Set<string>();
  const packageDirs = new Set<string>();
  let frameworkOnly = false;

  // ---- Claude plugins -------------------------------------------------------
  const mkt = files.find((p) => p === '.claude-plugin/marketplace.json');
  let marketplaceName: string | undefined;
  /** Folders that belong to a plugin; skills inside them ship with the plugin. */
  const pluginDirs: string[] = [];
  if (mkt) {
    const j = safeJson(await view.read(mkt));
    if (j && Array.isArray(j.plugins)) {
      marketplaceName = str(j.name) ?? view.source.repo;
      for (const p of j.plugins) {
        if (!p || typeof p.name !== 'string') continue;
        const dir = typeof p.source === 'string' ? p.source.replace(/^\.\//, '').replace(/\/+$/, '') : '';
        if (dir && dir !== '.') pluginDirs.push(dir + '/');
        set.add({
          name: p.name,
          description: str(p.description),
          spec: { kind: 'plugin', plugin: p.name, marketplace: { name: marketplaceName, source: slug } },
          evidence: [{ via: 'marketplace.json', file: mkt }],
          confidence: 'high',
          warnings: [],
        });
      }
    }
  } else {
    const pj = files.find((p) => p === '.claude-plugin/plugin.json');
    if (pj) {
      const j = safeJson(await view.read(pj));
      if (j?.name) {
        set.add({
          name: j.name,
          description: str(j.description),
          spec: { kind: 'plugin', plugin: j.name },
          evidence: [{ via: 'plugin.json', file: pj }],
          confidence: 'medium',
          warnings: [],
        });
      }
    }
  }

  // ---- Skills ----------------------------------------------------------------
  const allSkillFiles = files.filter(
    (p) => baseOf(p).toLowerCase() === 'skill.md' && !HIDDEN_SEGMENT.test(p) && !pluginDirs.some((d) => p.startsWith(d)),
  );
  // Skills under examples/ or tests/ are samples, unless that is all the repo has.
  const productSkills = allSkillFiles.filter((p) => !NON_PRODUCT.test(p));
  const skillFiles = (productSkills.length ? productSkills : allSkillFiles).slice(0, 300);
  await mapLimit(skillFiles, 8, async (file) => {
    const md = await view.read(file);
    if (md == null) return;
    const fm = parseFrontmatter(md);
    const dir = dirOf(file);
    const name = str(fm.name) ?? (dir ? baseOf(dir) : view.source.repo);
    const prefix = dir ? dir + '/' : '';
    const skillFiles = view.files
      .filter((p) => p.startsWith(prefix) && !IGNORED.test(p.slice(prefix.length)) && !/(^|\/)\.(git|DS_Store)/.test(p))
      .map((p) => p.slice(prefix.length))
      .slice(0, 500);
    set.add({
      name,
      description: str(fm.description),
      spec: { kind: 'skill', source: view.source, dir: fullPath(dir), files: skillFiles },
      evidence: [{ via: 'SKILL.md', file }],
      confidence: 'high',
      warnings: [],
    });
  });

  // ---- MCPB (Claude Desktop extension) ---------------------------------------
  const manifests = files.filter((p) => baseOf(p) === 'manifest.json' && depth(p) <= 2 && !NON_PRODUCT.test(p));
  let mcpbFound = false;
  let mcpbId: string | undefined;
  for (const file of manifests) {
    const j = safeJson(await view.read(file));
    if (!j || !(j.manifest_version || j.dxt_version) || !j.server) continue;
    mcpbFound = true;
    const inputs: InputField[] = Object.entries((j.user_config ?? {}) as Record<string, any>).map(([key, v]) => ({
      key,
      target: 'env',
      required: !!v?.required,
      secret: !!v?.sensitive,
      kind: v?.type === 'directory' || v?.type === 'file' ? 'path' : 'text',
      description: str(v?.description) ?? str(v?.title),
      defaultValue: typeof v?.default === 'string' ? v.default : undefined,
    }));
    mcpbId ??= set.add({
      name: str(j.name) ?? view.source.repo,
      title: str(j.display_name),
      description: str(j.description),
      spec: { kind: 'mcpb', source: view.source, manifestPath: fullPath(file), inputs },
      evidence: [{ via: 'manifest.json', file }],
      confidence: 'medium',
      warnings: [],
    }).id;
  }

  // ---- MCP Registry server.json ---------------------------------------------
  const serverJsons = files.filter((p) => baseOf(p) === 'server.json' && depth(p) <= 2);
  for (const file of serverJsons) {
    const j = safeJson(await view.read(file));
    if (!j || (!Array.isArray(j.packages) && !Array.isArray(j.remotes))) continue;
    const regName = str(j.name) ?? '';
    const name = sanitizeName(regName.split('/').pop() || view.source.repo);
    const title = str(j.title);
    const description = str(j.description);
    for (const p of (j.packages ?? []) as any[]) {
      const spec = registryPackageToSpec(p);
      if (spec) set.add({ name, title, description, spec, evidence: [{ via: 'server.json', file }], confidence: 'high', warnings: [] });
    }
    for (const r of (j.remotes ?? []) as any[]) {
      if (typeof r?.url !== 'string') continue;
      const headerList = Array.isArray(r.headers) ? r.headers : [];
      const headers = Object.fromEntries(headerList.map((h: any) => [h.name, h.value ?? '']));
      const spec = buildRemoteSpec(r.url, String(r.type ?? '').includes('sse') ? 'sse' : 'http', headers);
      describeInputs(spec.inputs, headerList);
      set.add({ name, title, description, spec, evidence: [{ via: 'server.json', file }], confidence: 'high', warnings: [] });
    }
  }

  // ---- npm packages -----------------------------------------------------------
  const productFile = (p: string) => !NON_PRODUCT.test(p) && !HIDDEN_SEGMENT.test(p) && (mkt ? depth(p) === 0 : depth(p) <= 3);
  const pkgFiles = files.filter((p) => baseOf(p) === 'package.json' && productFile(p)).slice(0, 80);
  await mapLimit(pkgFiles, 8, async (file) => {
    const pkg = safeJson(await view.read(file));
    if (!pkg || typeof pkg.name !== 'string') return;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    const hasMcp =
      Object.keys(deps).some((d) => NPM_MCP_DEP.test(d)) ||
      (Array.isArray(pkg.keywords) && pkg.keywords.some((k: unknown) => typeof k === 'string' && /^mcp(-server)?$|model-?context-?protocol/i.test(k)));
    if (!hasMcp) return;
    const name: string = pkg.name;
    const binList = typeof pkg.bin === 'string' ? [name] : Object.keys(pkg.bin ?? {});
    const mentionsMcp = [name, pkg.description, ...binList, ...(Array.isArray(pkg.keywords) ? pkg.keywords : [])].some(
      (x) => typeof x === 'string' && /mcp|model.?context.?protocol/i.test(x),
    );
    if (NPM_TOOLING.has(name) || (name.startsWith('@modelcontextprotocol/') && !name.includes('/server-')) || /(^|\/)create-/.test(name)) {
      frameworkOnly = true;
      return;
    }
    const bins: Record<string, string> = typeof pkg.bin === 'string' ? { [name.replace(/^@[^/]+\//, '')]: pkg.bin } : (pkg.bin ?? {});
    const binNames = Object.keys(bins);
    if (!binNames.length || pkg.private || !mentionsMcp) return;
    knownPackages.add(`npm:${name}`);
    packageDirs.add(dirOf(file));
    const unscoped = name.replace(/^@[^/]+\//, '');
    const args =
      binNames.length === 1 || binNames.includes(unscoped)
        ? ['-y', name]
        : ['-y', `--package=${name}`, binNames.find((b) => /mcp/.test(b)) ?? binNames[0]];
    set.add({
      description: str(pkg.description),
      spec: buildLocalSpec('npx', args),
      evidence: [{ via: 'package.json', file }],
      confidence: 'medium',
      warnings: [],
    });
  });

  // ---- Python packages --------------------------------------------------------
  const pyFiles = files.filter((p) => baseOf(p) === 'pyproject.toml' && productFile(p)).slice(0, 80);
  await mapLimit(pyFiles, 8, async (file) => {
    const text = await view.read(file);
    if (!text) return;
    let toml: any;
    try {
      toml = parseToml(text);
    } catch {
      return;
    }
    const project = toml.project ?? {};
    const poetry = toml.tool?.poetry ?? {};
    const name: string | undefined = project.name ?? poetry.name;
    if (!name) return;
    const deps: string[] = [
      ...(Array.isArray(project.dependencies) ? project.dependencies : []),
      ...Object.keys(poetry.dependencies ?? {}),
    ].map((d) => String(d).trim());
    if (!deps.some((d) => PY_MCP_DEP.test(d))) return;
    const norm = normalizePyName(name);
    if (norm === 'mcp' || norm === 'fastmcp') {
      frameworkOnly = true;
      return;
    }
    const scripts = Object.keys({ ...(project.scripts ?? {}), ...(poetry.scripts ?? {}) });
    if (!scripts.length) return;
    const script = scripts.find((s) => normalizePyName(s) === norm) ?? scripts.find((s) => /mcp/i.test(s)) ?? scripts[0];
    packageDirs.add(dirOf(file));
    knownPackages.add(`pypi:${norm}`);
    const published = await ctx.checker(`pypi:${norm}`);
    let args: string[];
    if (published?.exists) {
      args = normalizePyName(script) === norm ? [name] : ['--from', name, script];
    } else {
      const dir = fullPath(dirOf(file));
      const git = `git+https://github.com/${slug}${dir ? `#subdirectory=${dir}` : ''}`;
      args = ['--from', git, script];
      knownPackages.add(`git:${git.replace(/^git\+/, '')}`);
    }
    set.add({
      description: str(project.description ?? poetry.description),
      spec: buildLocalSpec('uvx', args),
      evidence: [{ via: 'pyproject.toml', file }],
      confidence: 'medium',
      warnings: [],
    });
  });

  // ---- READMEs ------------------------------------------------------------------
  const readmes = files.filter(
    (p) => /^readme\.(md|markdown|mdx)$/i.test(baseOf(p)) && (depth(p) === 0 || (!mkt && packageDirs.has(dirOf(p)))),
  );
  const marketplaceSources: string[] = [];
  const pluginInstalls: Extract<ParsedCommand, { type: 'plugin-install' }>[] = [];
  let mentionsMcpb = false;
  await mapLimit(readmes.slice(0, 40), 8, async (file) => {
    const md = await view.read(file);
    if (!md) return;
    if (/\.(mcpb|dxt)\b/.test(md)) mentionsMcpb = true;
    const found = scanMarkdown(md, { knownPackages });
    for (const s of found.servers) {
      set.add({
        name: s.name,
        spec: s.spec,
        evidence: [{ via: s.via, file }],
        confidence: s.via === 'deeplink' ? 'high' : 'medium',
        warnings: [],
      });
    }
    for (const c of found.commands) {
      if (c.type === 'mcp') {
        set.add({ name: c.name, spec: c.spec, evidence: [{ via: 'readme-command', file }], confidence: 'medium', warnings: [] });
      } else if (c.type === 'mcp-json') {
        const obj = parseConfigText(c.json);
        for (const s of findServers(obj)) {
          const spec = entryToSpec(s.entry);
          if (spec) set.add({ name: c.name, spec, evidence: [{ via: 'readme-command', file }], confidence: 'medium', warnings: [] });
        }
      } else if (c.type === 'marketplace-add') {
        marketplaceSources.push(c.source);
      } else if (c.type === 'plugin-install') {
        pluginInstalls.push(c);
      }
    }
  });

  // Plugins installed from a marketplace that lives in another repo (README says so).
  for (const p of pluginInstalls) {
    if (marketplaceName && (!p.marketplace || p.marketplace === marketplaceName)) continue; // already listed
    const source = resolveMarketplaceSource(p.marketplace, marketplaceSources);
    set.add({
      name: p.plugin,
      spec: { kind: 'plugin', plugin: p.plugin, marketplace: { name: p.marketplace, source } },
      evidence: [{ via: 'readme-command' }],
      confidence: source ? 'high' : 'medium',
      warnings: [],
    });
  }

  // Release assets (.mcpb / .dxt) for Claude Desktop.
  if ((mcpbFound || mentionsMcpb) && view.releaseAssets) {
    const assets = (await view.releaseAssets()).filter((a) => /\.(mcpb|dxt)$/i.test(a.name)).slice(0, 8);
    if (assets.length && mcpbId) {
      set.update(mcpbId, (c) =>
        c.spec.kind === 'mcpb'
          ? { ...c, confidence: 'high', spec: { ...c.spec, assets, downloadUrl: assets[0].url }, evidence: [...c.evidence, { via: 'release-asset' }] }
          : c,
      );
    } else if (assets.length) {
      set.add({
        name: view.source.repo,
        spec: { kind: 'mcpb', source: view.source, downloadUrl: assets[0].url, assets, inputs: [] },
        evidence: [{ via: 'release-asset', file: assets[0].name }],
        confidence: 'high',
        warnings: [],
      });
    }
  }

  if (frameworkOnly && !set.values().length) notes.push(t('detect.frameworkOnly'));
  if (view.truncated) notes.push(t('detect.truncated'));
  return { notes, marketplaceSources };
}

export function resolveMarketplaceSource(name: string | undefined, sources: string[]): string | undefined {
  if (name && KNOWN_MARKETPLACES[name]) return KNOWN_MARKETPLACES[name];
  if (!sources.length) return undefined;
  const repoName = (s: string) => s.replace(/\.git$/, '').split('/').pop()?.toLowerCase();
  return sources.find((s) => name && repoName(s) === name.toLowerCase()) ?? (sources.length === 1 ? sources[0] : undefined);
}

function describeInputs(inputs: InputField[], vars: any[]): void {
  for (const input of inputs) {
    const v = vars.find((x) => x?.name === input.key);
    if (!v) continue;
    input.description ??= str(v.description);
    if (v.isSecret === true || v.is_secret === true) input.secret = true;
    if (v.isRequired === false || v.is_required === false) input.required = false;
  }
}

/** One `packages[]` entry of an MCP Registry server.json. */
function registryPackageToSpec(p: any): McpLocalSpec | McpRemoteSpec | null {
  const type = String(p?.registryType ?? p?.registry_type ?? p?.registry_name ?? '').toLowerCase();
  const id: string | undefined = p?.identifier ?? p?.name;
  const transport = String(p?.transport?.type ?? 'stdio');
  if (!id || transport !== 'stdio') return null;
  const vars: any[] = p.environmentVariables ?? p.environment_variables ?? [];
  const env: Record<string, string> = {};
  for (const v of vars) {
    if (!v?.name) continue;
    const required = v.isRequired ?? v.is_required ?? false;
    const secret = v.isSecret ?? v.is_secret ?? false;
    if (required || secret) env[v.name] = '';
    else if (typeof v.default === 'string') env[v.name] = v.default;
  }
  const extraArgs: string[] = [];
  for (const a of (p.packageArguments ?? p.package_arguments ?? []) as any[]) {
    const value = a?.value ?? a?.default ?? (a?.isRequired ? `<${a?.valueHint ?? a?.name ?? 'value'}>` : undefined);
    if (value === undefined) continue;
    if (a.type === 'named' && a.name) extraArgs.push(String(a.name), String(value));
    else extraArgs.push(String(value));
  }
  let spec: McpLocalSpec | McpRemoteSpec;
  if (type === 'npm') spec = buildLocalSpec('npx', ['-y', id, ...extraArgs], env);
  else if (type === 'pypi') spec = buildLocalSpec('uvx', [id, ...extraArgs], env);
  else if (type === 'oci' || type === 'docker') {
    spec = buildLocalSpec('docker', ['run', '-i', '--rm', ...Object.keys(env).flatMap((k) => ['-e', k]), id, ...extraArgs], env);
  } else return null;
  describeInputs(spec.inputs, vars);
  return spec;
}

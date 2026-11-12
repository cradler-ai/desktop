// Reads what is already installed on this machine. Pure logic over an injected IO,
// so it runs in the desktop app (Rust does the file access) and in tests.
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import type { ClientId } from './targets';
import type { McpLocalSpec, McpRemoteSpec } from './types';
import { entryToSpec } from './parse/config';
import { parseFrontmatter } from './detect/repo';
import { sanitizeName } from './util/names';
import { t } from './i18n';

export interface DirEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  target?: string | null;
}

export interface InventoryIO {
  home: string;
  readTexts(paths: string[]): Promise<(string | null)[]>;
  listDir(path: string): Promise<DirEntry[]>;
}

/** The config exactly as the AI app will run it (secrets included; never shown unmasked). */
export interface RawServerConfig {
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  transport?: 'http' | 'sse';
}

export type InstallScope = 'user' | 'project' | 'plugin' | 'extension';

export interface InstalledServer {
  key: string;
  name: string;
  client: ClientId;
  scope: InstallScope;
  /** Project folder name, plugin name, ... */
  scopeLabel?: string;
  /** Full project folder for project-scope servers (Claude Code). */
  projectDir?: string;
  configPath: string;
  disabled: boolean;
  raw: RawServerConfig;
  spec: McpLocalSpec | McpRemoteSpec | null;
}

export interface ServerGroup {
  id: string;
  name: string;
  kind: 'mcp-local' | 'mcp-remote';
  items: InstalledServer[];
  /** false when the same server is configured differently in different places */
  consistent: boolean;
}

export type SkillLocation = 'claude' | 'agents' | 'codex' | 'synced' | 'plugin';

export interface InstalledSkill {
  key: string;
  name: string;
  description?: string;
  location: SkillLocation;
  plugin?: string;
  dir: string;
  isSymlink: boolean;
  linkTarget?: string;
  content: string;
  removable: boolean;
}

export interface SkillGroup {
  name: string;
  description?: string;
  items: InstalledSkill[];
  /** two or more real copies whose SKILL.md differ */
  differs: boolean;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  enabled: boolean;
  scope?: string;
  installPath: string;
  description?: string;
  counts: { skills: number; commands: number; agents: number; mcp: number; hooks: boolean };
}

export interface ConfigFile {
  client: ClientId;
  path: string;
  exists: boolean;
  /** null when it parsed fine */
  error: string | null;
  servers: number;
}

export interface Inventory {
  servers: InstalledServer[];
  serverGroups: ServerGroup[];
  skills: InstalledSkill[];
  skillGroups: SkillGroup[];
  plugins: InstalledPlugin[];
  configFiles: ConfigFile[];
}

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/');
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/** Strict JSON check (what most apps use), with a lenient parse so we can still show contents. */
function parseJsonConfig(text: string): { value: Obj | null; error: string | null } {
  try {
    const v = JSON.parse(text);
    return { value: isObj(v) ? v : null, error: null };
  } catch {
    const errors: ParseError[] = [];
    const v = parseJsonc(text, errors, { allowTrailingComma: true });
    const line = errors.length ? lineOf(text, errors[0].offset) : undefined;
    const lenientOk = !errors.length;
    return {
      value: isObj(v) ? v : null,
      error: lenientOk ? t('config.lenient') : t('config.broken', { where: line ? t('config.line', { line }) : '' }),
    };
  }
}

function toRaw(entry: Obj, subst: (s: string) => string = (s) => s): RawServerConfig {
  let command: unknown = entry.command;
  let args: unknown = entry.args;
  let env: unknown = entry.env ?? entry.environment;
  if (Array.isArray(entry.command)) {
    command = entry.command[0];
    args = entry.command.slice(1);
  }
  const url = str(entry.url) ?? str(entry.serverUrl) ?? str(entry.httpUrl);
  const headers: Record<string, string> = {};
  for (const src of [entry.headers, entry.http_headers]) {
    if (isObj(src)) for (const [k, v] of Object.entries(src)) headers[k] = subst(String(v ?? ''));
  }
  if (typeof entry.bearer_token_env_var === 'string') headers.Authorization = `Bearer \${${entry.bearer_token_env_var}}`;
  const envOut: Record<string, string> = {};
  if (isObj(env)) for (const [k, v] of Object.entries(env)) envOut[k] = subst(String(v ?? ''));
  const declared = String(entry.type ?? entry.transport ?? '').toLowerCase();
  return {
    command: typeof command === 'string' ? subst(command) : undefined,
    args: Array.isArray(args) ? args.map((a) => subst(String(a))) : [],
    env: envOut,
    cwd: str(entry.cwd),
    url: url ? subst(url) : undefined,
    headers,
    transport: url ? (declared.includes('sse') || /\/sse\/?(\?|$)/.test(url) ? 'sse' : 'http') : undefined,
  };
}

function serverEntries(container: unknown): [string, Obj][] {
  if (!isObj(container)) return [];
  return Object.entries(container).filter(([, v]) => isObj(v) && (v.command || v.url || v.serverUrl || v.httpUrl)) as [string, Obj][];
}

function makeServer(
  client: ClientId,
  scope: InstallScope,
  configPath: string,
  name: string,
  entry: Obj,
  opts: { scopeLabel?: string; disabled?: boolean; subst?: (s: string) => string; cwd?: string; projectDir?: string } = {},
): InstalledServer {
  const raw = toRaw(entry, opts.subst);
  // Project servers run inside the project folder (relative paths like .venv/bin/python depend on it).
  if (!raw.cwd && opts.cwd && raw.command) raw.cwd = opts.cwd;
  const specEntry = { ...entry, command: raw.command, args: raw.args, env: raw.env, url: raw.url, headers: raw.headers };
  return {
    key: [client, scope, opts.scopeLabel ?? '', name].join('|'),
    name,
    client,
    scope,
    scopeLabel: opts.scopeLabel,
    projectDir: opts.projectDir,
    configPath,
    disabled: !!opts.disabled || entry.disabled === true || entry.enabled === false,
    raw,
    spec: entryToSpec(specEntry),
  };
}

export function fingerprint(raw: RawServerConfig): string {
  return JSON.stringify([raw.command ?? '', raw.args, raw.env, raw.cwd ?? '', raw.url ?? '', raw.headers]);
}

export async function loadInventory(io: InventoryIO): Promise<Inventory> {
  const H = io.home;
  const P = {
    claudeJson: join(H, '.claude.json'),
    claudeSettings: join(H, '.claude/settings.json'),
    installedPlugins: join(H, '.claude/plugins/installed_plugins.json'),
    desktop: join(H, 'Library/Application Support/Claude/claude_desktop_config.json'),
    cursor: join(H, '.cursor/mcp.json'),
    codex: join(H, '.codex/config.toml'),
    gemini: join(H, '.gemini/settings.json'),
  };
  const [claudeJsonT, settingsT, pluginsT, desktopT, cursorT, codexT, geminiT] = await io.readTexts([
    P.claudeJson,
    P.claudeSettings,
    P.installedPlugins,
    P.desktop,
    P.cursor,
    P.codex,
    P.gemini,
  ]);

  const servers: InstalledServer[] = [];
  const configFiles: ConfigFile[] = [];
  const addFile = (client: ClientId, path: string, text: string | null, count: () => number, error: string | null) =>
    configFiles.push({ client, path, exists: text != null, error, servers: text != null ? count() : 0 });

  // ---- Claude Code: user + per-project (local) + project .mcp.json --------------
  const claudeJson = claudeJsonT ? parseJsonConfig(claudeJsonT) : { value: null, error: null };
  const cj = claudeJson.value ?? {};
  for (const [name, e] of serverEntries(cj.mcpServers)) servers.push(makeServer('claude-code', 'user', P.claudeJson, name, e));
  const projects: Obj = isObj(cj.projects) ? cj.projects : {};
  for (const [dir, p] of Object.entries(projects)) {
    if (!isObj(p)) continue;
    const disabled: string[] = Array.isArray(p.disabledMcpServers) ? p.disabledMcpServers : [];
    for (const [name, e] of serverEntries(p.mcpServers)) {
      servers.push(
        makeServer('claude-code', 'project', P.claudeJson, name, e, { scopeLabel: baseName(dir), disabled: disabled.includes(name), cwd: dir, projectDir: dir }),
      );
    }
  }
  addFile('claude-code', P.claudeJson, claudeJsonT, () => servers.filter((s) => s.client === 'claude-code').length, claudeJson.error);

  const projectDirs = Object.keys(projects);
  const mcpJsonPaths = projectDirs.map((d) => join(d, '.mcp.json'));
  const mcpJsonTexts = projectDirs.length ? await io.readTexts(mcpJsonPaths) : [];
  mcpJsonTexts.forEach((t, i) => {
    if (!t) return;
    const parsed = parseJsonConfig(t);
    const p = projects[projectDirs[i]] ?? {};
    const disabled: string[] = Array.isArray(p.disabledMcpjsonServers) ? p.disabledMcpjsonServers : [];
    const entries = serverEntries(parsed.value?.mcpServers ?? parsed.value);
    for (const [name, e] of entries) {
      servers.push(
        makeServer('claude-code', 'project', mcpJsonPaths[i], name, e, {
          scopeLabel: baseName(projectDirs[i]),
          disabled: disabled.includes(name),
          cwd: projectDirs[i],
          projectDir: projectDirs[i],
        }),
      );
    }
    if (parsed.error) configFiles.push({ client: 'claude-code', path: mcpJsonPaths[i], exists: true, error: parsed.error, servers: entries.length });
  });

  // ---- Claude Desktop, Cursor, Gemini (plain JSON) --------------------------------
  for (const [client, path, text] of [
    ['claude-desktop', P.desktop, desktopT],
    ['cursor', P.cursor, cursorT],
    ['gemini', P.gemini, geminiT],
  ] as const) {
    if (text == null) {
      addFile(client, path, null, () => 0, null);
      continue;
    }
    const parsed = parseJsonConfig(text);
    const entries = serverEntries(parsed.value?.mcpServers);
    for (const [name, e] of entries) servers.push(makeServer(client, 'user', path, name, e));
    addFile(client, path, text, () => entries.length, parsed.error);
  }

  // ---- Codex (TOML) ----------------------------------------------------------------
  if (codexT != null) {
    let error: string | null = null;
    let toml: Obj = {};
    try {
      toml = parseToml(codexT) as Obj;
    } catch (e) {
      const line = /line (\d+)/i.exec(String(e))?.[1];
      error = t('config.brokenCodex', { where: line ? t('config.line', { line }) : '' });
    }
    const entries = serverEntries(toml.mcp_servers);
    for (const [name, e] of entries) servers.push(makeServer('codex', 'user', P.codex, name, e));
    addFile('codex', P.codex, codexT, () => entries.length, error);
  } else addFile('codex', P.codex, null, () => 0, null);

  // ---- Claude Code plugins -------------------------------------------------------------
  const settings = settingsT ? parseJsonConfig(settingsT).value ?? {} : {};
  const enabledMap: Obj = isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const pluginsJson = pluginsT ? parseJsonConfig(pluginsT).value ?? {} : {};
  const pluginRecords = isObj(pluginsJson.plugins) ? pluginsJson.plugins : {};
  const plugins: InstalledPlugin[] = [];
  const pluginSkillDirs: { plugin: string; dir: string }[] = [];

  const pluginIds = Object.keys(pluginRecords);
  const installs = pluginIds.map((id) => {
    const rec = pluginRecords[id];
    const first = Array.isArray(rec) ? rec[0] : rec;
    return isObj(first) ? first : {};
  });
  const pluginFiles = installs.flatMap((ins) =>
    typeof ins.installPath === 'string' ? [join(ins.installPath, '.claude-plugin/plugin.json'), join(ins.installPath, '.mcp.json')] : ['', ''],
  );
  const pluginTexts = pluginFiles.length ? await io.readTexts(pluginFiles) : [];
  const listings = await Promise.all(
    installs.map(async (ins) => {
      const root = typeof ins.installPath === 'string' ? ins.installPath : '';
      if (!root) return { skills: [], commands: [], agents: [], top: [] };
      const [skills, commands, agents, top] = await Promise.all(
        ['skills', 'commands', 'agents', ''].map((d) => io.listDir(d ? join(root, d) : root)),
      );
      return { skills, commands, agents, top };
    }),
  );

  pluginIds.forEach((id, i) => {
    const ins = installs[i];
    const root: string = typeof ins.installPath === 'string' ? ins.installPath : '';
    const [name, marketplace = ''] = id.split('@');
    const enabled = enabledMap[id] === true;
    const manifest = pluginTexts[i * 2] ? parseJsonConfig(pluginTexts[i * 2]!).value ?? {} : {};
    const mcpJson = pluginTexts[i * 2 + 1] ? parseJsonConfig(pluginTexts[i * 2 + 1]!).value ?? {} : {};
    const subst = (s: string) => s.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root);
    const mcpSource = isObj(manifest.mcpServers) ? manifest.mcpServers : (mcpJson.mcpServers ?? mcpJson);
    const mcp = serverEntries(mcpSource);
    for (const [sname, e] of mcp) {
      servers.push(
        makeServer('claude-code', 'plugin', join(root, '.mcp.json'), sname, e, { scopeLabel: name, disabled: !enabled, subst }),
      );
    }
    const l = listings[i];
    const skillDirs = l.skills.filter((d) => d.isDir);
    for (const d of skillDirs) pluginSkillDirs.push({ plugin: name, dir: join(root, 'skills', d.name) });
    plugins.push({
      id,
      name,
      marketplace,
      version: str(ins.version) ?? str(manifest.version),
      enabled,
      scope: str(ins.scope),
      installPath: root,
      description: str(manifest.description),
      counts: {
        skills: skillDirs.length,
        commands: l.commands.filter((f) => f.name.endsWith('.md')).length,
        agents: l.agents.filter((f) => f.name.endsWith('.md')).length,
        mcp: mcp.length,
        hooks: l.top.some((f) => f.name === 'hooks' || f.name === 'hooks.json'),
      },
    });
  });

  // ---- Skills ---------------------------------------------------------------------------
  const skillRoots: { location: SkillLocation; dir: string }[] = [
    { location: 'claude', dir: join(H, '.claude/skills') },
    { location: 'agents', dir: join(H, '.agents/skills') },
    { location: 'codex', dir: join(H, '.codex/skills') },
  ];
  const candidates: { location: SkillLocation; dir: string; entry?: DirEntry; plugin?: string }[] = [];
  for (const root of skillRoots) {
    for (const e of await io.listDir(root.dir)) {
      if (e.name.startsWith('.') || !e.isDir) continue;
      if (root.location === 'claude' && e.name === 'synced' && !e.isSymlink) {
        for (const bucket of await io.listDir(join(root.dir, 'synced'))) {
          if (bucket.name.startsWith('.') || !bucket.isDir) continue;
          for (const s of await io.listDir(join(root.dir, 'synced', bucket.name))) {
            if (s.isDir && !s.name.startsWith('.')) candidates.push({ location: 'synced', dir: join(root.dir, 'synced', bucket.name, s.name), entry: s });
          }
        }
        continue;
      }
      candidates.push({ location: root.location, dir: join(root.dir, e.name), entry: e });
    }
  }
  for (const p of pluginSkillDirs) candidates.push({ location: 'plugin', dir: p.dir, plugin: p.plugin });
  const skillTexts = await io.readTexts(candidates.map((c) => join(c.dir, 'SKILL.md')));
  const skills: InstalledSkill[] = [];
  candidates.forEach((c, i) => {
    const md = skillTexts[i];
    if (md == null) return;
    const fm = parseFrontmatter(md);
    skills.push({
      key: c.dir,
      name: str(fm.name) ?? baseName(c.dir),
      description: str(fm.description),
      location: c.location,
      plugin: c.plugin,
      dir: c.dir,
      isSymlink: !!c.entry?.isSymlink,
      linkTarget: c.entry?.target ?? undefined,
      content: md.replace(/\s+/g, ' ').trim(),
      removable: c.location === 'claude' || c.location === 'agents' || c.location === 'codex',
    });
  });

  return {
    servers,
    serverGroups: groupServers(servers),
    skills,
    skillGroups: groupSkills(skills),
    plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
    configFiles,
  };
}

export function groupServers(servers: InstalledServer[]): ServerGroup[] {
  const map = new Map<string, InstalledServer[]>();
  for (const s of servers) {
    const id = sanitizeName(s.name);
    map.set(id, [...(map.get(id) ?? []), s]);
  }
  return [...map.entries()]
    .map(([id, items]) => ({
      id,
      name: items[0].name,
      kind: (items[0].raw.command ? 'mcp-local' : 'mcp-remote') as ServerGroup['kind'],
      items,
      consistent: new Set(items.map((i) => fingerprint(i.raw))).size <= 1,
    }))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
}

export function groupSkills(skills: InstalledSkill[]): SkillGroup[] {
  const map = new Map<string, InstalledSkill[]>();
  for (const s of skills) map.set(s.name, [...(map.get(s.name) ?? []), s]);
  return [...map.entries()]
    .map(([name, items]) => {
      const real = items.filter((i) => !i.isSymlink);
      return {
        name,
        description: items.find((i) => i.description)?.description,
        items,
        differs: new Set(real.map((i) => i.content)).size > 1,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const skillLocationLabel = (loc: SkillLocation): string => t(`skillLoc.${loc}`);

export function scopeText(s: InstalledServer): string {
  if (s.scope === 'project') return t('scope.project', { name: s.scopeLabel });
  if (s.scope === 'plugin') return t('scope.plugin', { name: s.scopeLabel });
  if (s.scope === 'extension') return t('scope.extension');
  return '';
}

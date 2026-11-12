import type { Candidate, DetectResult, FetchLike, InputKind, RepoMeta, RepoView } from '../types';
import { CandidateSet, groupCandidates } from '../merge';
import { createPackageChecker } from '../registry';
import { GitHubError, openGitHubRepo, parseGitHubInput } from '../github';
import { buildLocalSpec, buildRemoteSpec, guessTransport } from '../spec';
import { entryToSpec, findServers, parseConfigText } from '../parse/config';
import { findDeeplinks } from '../parse/deeplink';
import { parseCommand, type ParsedCommand } from '../parse/command';
import { splitCommands } from '../parse/shell';
import { detectRepo, resolveMarketplaceSource, type DetectContext } from './repo';
import { cleanServerName, inferNameFromPackage, nameTokens } from '../util/names';
import { t } from '../i18n';

export interface DetectOptions {
  fetch?: FetchLike;
  githubToken?: string;
  /** Opens a local folder as a RepoView (provided by the desktop app). */
  openLocal?: (path: string) => Promise<RepoView | null>;
}

interface Ctx extends DetectContext {
  fetch: FetchLike;
  token?: string;
}

export async function detect(raw: string, opts: DetectOptions = {}): Promise<DetectResult> {
  const input = raw.trim();
  if (!input) return { inputKind: 'empty', groups: [], notes: [] };
  const fetch: FetchLike = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const ctx: Ctx = { fetch, checker: createPackageChecker(fetch), token: opts.githubToken };
  const set = new CandidateSet();
  const notes: string[] = [];
  let kind: InputKind = 'unknown';
  let repo: RepoMeta | undefined;
  const single = !/\s/.test(input);

  try {
    const gh = single ? parseGitHubInput(input) : null;
    if (gh) {
      kind = 'github';
      const view = await openGitHubRepo(gh, { fetch, token: ctx.token });
      repo = view.meta;
      const scan = await detectRepo(view, ctx, set);
      notes.push(...scan.notes);
      if (repo?.archived) notes.push(t('detect.archived'));
    } else if (opts.openLocal && /^(\/|~\/|[A-Za-z]:\\)/.test(input) && !input.includes('\n')) {
      const view = await opts.openLocal(input);
      if (view) {
        kind = 'local';
        const scan = await detectRepo(view, ctx, set);
        notes.push(...scan.notes);
      }
    }

    if (kind === 'unknown' && looksLikeConfig(input)) {
      const obj = parseConfigText(input);
      if (obj) {
        kind = 'config';
        for (const s of findServers(obj)) {
          const spec = entryToSpec(s.entry);
          if (spec) set.add({ name: s.name, spec, evidence: [{ via: 'user-input' }], confidence: 'high', warnings: [] });
        }
      }
    }

    if (kind === 'unknown') {
      const links = findDeeplinks(input);
      if (links.length) {
        kind = 'url';
        for (const d of links) {
          const spec = entryToSpec(d.entry);
          if (spec) set.add({ name: d.name, spec, evidence: [{ via: 'user-input' }], confidence: 'high', warnings: [] });
        }
      }
    }

    if (kind === 'unknown' && single && /^https?:\/\/\S+$/.test(input)) {
      kind = 'url';
      set.add({
        spec: buildRemoteSpec(input, guessTransport(input), {}),
        evidence: [{ via: 'user-input' }],
        confidence: 'medium',
        warnings: [],
      });
    }

    if (kind === 'unknown') {
      const parsed = splitCommands(input)
        .map((t) => parseCommand(t))
        .filter((c): c is ParsedCommand => !!c);
      if (parsed.length) {
        kind = 'command';
        await applyUserCommands(parsed, ctx, set, notes);
      }
    }
  } catch (e) {
    if (e instanceof GitHubError) notes.push(e.message);
    else notes.push(t('detect.error', { msg: e instanceof Error ? e.message : String(e) }));
  }

  await verifyPackages(set, ctx);
  prune(set, notes);
  regroupServers(set);
  annotate(set);
  const groups = groupCandidates(set.values());
  if (!groups.length && !notes.length) {
    notes.push(
      kind === 'unknown'
        ? t('detect.unknown')
        : t('detect.nothing'),
    );
  }
  return { inputKind: kind, repo, groups, notes: [...new Set(notes)] };
}

function looksLikeConfig(s: string): boolean {
  return /^[{\[]/.test(s) || /["'](mcpServers|command|url|serverUrl|httpUrl)["']\s*:/.test(s) || /^\s*\[mcp_servers/m.test(s);
}

async function applyUserCommands(parsed: ParsedCommand[], ctx: Ctx, set: CandidateSet, notes: string[]): Promise<void> {
  const marketplaceSources = parsed.flatMap((p) => (p.type === 'marketplace-add' ? [p.source] : []));
  const hasPluginInstall = parsed.some((p) => p.type === 'plugin-install');
  const ev = [{ via: 'user-input' as const }];

  for (const p of parsed) {
    switch (p.type) {
      case 'mcp':
        set.add({ name: p.name, spec: p.spec, evidence: ev, confidence: 'high', warnings: [] });
        break;
      case 'mcp-json': {
        for (const s of findServers(parseConfigText(p.json))) {
          const spec = entryToSpec(s.entry);
          if (spec) set.add({ name: p.name, spec, evidence: ev, confidence: 'high', warnings: [] });
        }
        break;
      }
      case 'package-install': {
        const spec = p.ecosystem === 'npm' ? buildLocalSpec('npx', ['-y', p.pkg]) : buildLocalSpec('uvx', [p.pkg]);
        set.add({ spec, evidence: ev, confidence: 'medium', warnings: [t('detect.globalInstall')] });
        break;
      }
      case 'plugin-install': {
        const source = resolveMarketplaceSource(p.marketplace, marketplaceSources);
        set.add({
          name: p.plugin,
          spec: { kind: 'plugin', plugin: p.plugin, marketplace: { name: p.marketplace, source } },
          evidence: ev,
          confidence: 'high',
          warnings: [],
        });
        break;
      }
      case 'marketplace-add': {
        if (hasPluginInstall) break; // only used to resolve the marketplace source
        await fromGitHubSource(p.source, ctx, notes, (c) => c.spec.kind === 'plugin', set);
        break;
      }
      case 'skills-add': {
        const wanted = new Set(p.skills.map((s) => s.toLowerCase()));
        await fromGitHubSource(
          p.source,
          ctx,
          notes,
          (c) => c.spec.kind === 'skill' && (!wanted.size || wanted.has(c.name.toLowerCase())),
          set,
        );
        break;
      }
    }
  }
}

async function fromGitHubSource(
  source: string,
  ctx: Ctx,
  notes: string[],
  keep: (c: Candidate) => boolean,
  set: CandidateSet,
): Promise<void> {
  const loc = parseGitHubInput(source);
  if (!loc) {
    notes.push(t('detect.badSource', { source }));
    return;
  }
  const view = await openGitHubRepo(loc, { fetch: ctx.fetch, token: ctx.token });
  const tmp = new CandidateSet();
  const scan = await detectRepo(view, ctx, tmp);
  notes.push(...scan.notes);
  for (const c of tmp.values()) if (keep(c)) set.add({ ...c, evidence: [...c.evidence, { via: 'user-input' }] });
}

async function verifyPackages(set: CandidateSet, ctx: Ctx): Promise<void> {
  const locals = set.values().filter((c) => c.spec.kind === 'mcp-local' && c.spec.packageRef && /^(npm|pypi):/.test(c.spec.packageRef));
  await Promise.all(
    locals.slice(0, 30).map(async (c) => {
      if (c.spec.kind !== 'mcp-local' || !c.spec.packageRef) return;
      const info = await ctx.checker(c.spec.packageRef);
      if (!info) return;
      const registry = c.spec.packageRef.startsWith('npm:') ? 'npm' : 'PyPI';
      if (!info.exists) {
        const inferredOnly = c.evidence.every((e) => e.via === 'package.json' || e.via === 'pyproject.toml');
        if (inferredOnly) set.remove(c.id);
        else
          set.update(c.id, (x) => ({
            ...x,
            confidence: 'low',
            warnings: [...x.warnings, t('detect.pkgMissing', { registry })],
          }));
      } else if (info.description && !c.description) {
        set.update(c.id, (x) => ({ ...x, description: info.description }));
      }
    }),
  );
}

const GENERIC_NAMES = /^(mcp|server|mcp-server|my-server|my-mcp|example|test|your-server|server-name|name|local|dev)$/;

/** Drops options an ordinary user can't use when better options exist. */
function prune(set: CandidateSet, notes: string[]): void {
  const all = set.values();
  const installable = (c: Candidate) =>
    !(c.spec.kind === 'mcp-local' && c.spec.needsBuild) &&
    !(c.spec.kind === 'mcp-local' && GENERIC_NAMES.test(c.name) && c.confidence !== 'high') &&
    !(c.spec.kind === 'mcp-remote' && isLocalUrl(c.spec.url));
  const anyInstallable = all.some(installable);
  let dropped = 0;
  for (const c of all) {
    if (installable(c)) continue;
    set.remove(c.id);
    dropped++;
  }
  if (dropped && anyInstallable) notes.push(t('detect.droppedSome', { n: dropped }));
  if (dropped && !anyInstallable) notes.push(t('detect.droppedAll'));
}

function annotate(set: CandidateSet): void {
  for (const c of set.values()) {
    const w: string[] = [];
    const s = c.spec;
    if (s.kind === 'mcp-local') {
      if (s.needsBuild) w.push(t('detect.needsBuild'));
      else if (s.runtime === 'docker') w.push(t('detect.needsDocker'));
    }
    if (s.kind === 'plugin' && !s.marketplace?.source) w.push(t('detect.noMarketplace'));
    if (w.length) set.update(c.id, (x) => ({ ...x, warnings: [...new Set([...x.warnings, ...w])] }));
  }
}

function isLocalUrl(url: string): boolean {
  try {
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Puts npx / docker / remote / extension variants of the same server into one group.
 * Packages are anchors; everything else joins the anchor whose name it matches.
 */
function regroupServers(set: CandidateSet): void {
  const servers = set.values().filter((c) => c.spec.kind === 'mcp-local' || c.spec.kind === 'mcp-remote' || c.spec.kind === 'mcpb');
  const anchorOf = (c: Candidate) =>
    c.spec.kind === 'mcp-local' && c.spec.packageRef ? cleanServerName(inferNameFromPackage(c.spec.packageRef)) : undefined;
  const anchors = new Map<string, string>();
  for (const c of servers) {
    const a = anchorOf(c);
    if (a) anchors.set(norm(a), a);
  }
  const keys = [...anchors.keys()];
  for (const c of servers) {
    let key = anchorOf(c);
    if (!key) {
      const n = norm(c.name);
      const match = keys.find((a) => a === n) ?? keys.find((a) => a.length >= 4 && n.length >= 4 && (n.includes(a) || a.includes(n)));
      if (match) key = anchors.get(match);
      else if (keys.length === 1) {
        const only = anchors.get(keys[0])!;
        const mine = nameTokens(c.name);
        if ([...nameTokens(only)].some((t) => mine.has(t))) key = only;
      }
    }
    const group = `mcp:${norm(key ?? c.name) || c.id}`;
    if (group !== c.group) set.update(c.id, (x) => ({ ...x, group }));
  }
}

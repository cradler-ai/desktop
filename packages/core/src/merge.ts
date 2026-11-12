import type { Candidate, CandidateGroup, Confidence, Evidence, EvidenceVia, InstallSpec } from './types';
import { normalizeGitUrl } from './util/command';
import { cleanServerName, inferNameFromPackage, sanitizeName } from './util/names';

const VIA_PRIORITY: Record<EvidenceVia, number> = {
  'user-input': 100,
  'server.json': 90,
  'marketplace.json': 90,
  'SKILL.md': 90,
  'plugin.json': 85,
  'manifest.json': 85,
  'release-asset': 85,
  deeplink: 80,
  'readme-config': 70,
  'readme-command': 65,
  'package.json': 40,
  'pyproject.toml': 40,
};
const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

const maxPri = (ev: Evidence[]) => Math.max(0, ...ev.map((e) => VIA_PRIORITY[e.via]));

export function candidateId(spec: InstallSpec): string {
  switch (spec.kind) {
    case 'mcp-local':
      if (spec.packageRef) return `local:${spec.packageRef.startsWith('git:') ? 'git:' + normalizeGitUrl(spec.packageRef.slice(4)) : spec.packageRef}`;
      return `local:${spec.command} ${spec.args.join(' ')}`;
    case 'mcp-remote':
      return `remote:${spec.url.replace(/\/+$/, '').replace(/^https?:\/\//, '').toLowerCase()}`;
    case 'skill':
      return `skill:${spec.source.owner}/${spec.source.repo}:${spec.dir}`.toLowerCase();
    case 'plugin':
      return `plugin:${spec.plugin}@${spec.marketplace?.name ?? spec.marketplace?.source ?? ''}`.toLowerCase();
    case 'mcpb':
      return `mcpb:${spec.downloadUrl ?? spec.manifestPath ?? ''}`;
  }
}

/** Name used to group alternatives ("playwright" via npx, docker, remote...). */
export function groupKey(c: Pick<Candidate, 'name' | 'spec'>): string {
  const s = c.spec;
  if (s.kind === 'skill') return `skill:${sanitizeName(c.name)}`;
  if (s.kind === 'plugin') return `plugin:${sanitizeName(c.name)}`;
  return `mcp:${sanitizeName(c.name)}`;
}

export function defaultName(spec: InstallSpec): string {
  if (spec.kind === 'mcp-local' && spec.packageRef) return inferNameFromPackage(spec.packageRef);
  if (spec.kind === 'mcp-remote') {
    try {
      const host = new URL(spec.url).hostname.replace(/^(www|mcp|api)\./, '');
      return sanitizeName(host.split('.')[0] ?? 'remote');
    } catch {
      return 'remote';
    }
  }
  if (spec.kind === 'mcp-local') return inferNameFromPackage(spec.command);
  return 'item';
}

export type NewCandidate = Omit<Candidate, 'id' | 'group' | 'name'> & { name?: string };

const GENERIC = /^(mcp|server|mcp-server|remote|local|default|main|app|my-server|item)$/;
const isMcpKind = (spec: InstallSpec) => spec.kind === 'mcp-local' || spec.kind === 'mcp-remote' || spec.kind === 'mcpb';

export class CandidateSet {
  private map = new Map<string, Candidate>();

  add(input: NewCandidate): Candidate {
    // Plugin and skill names are identifiers and must stay exact; server names are just config keys.
    const raw = input.name || defaultName(input.spec);
    let name = isMcpKind(input.spec) ? cleanServerName(raw) : raw;
    if (isMcpKind(input.spec) && GENERIC.test(name)) name = cleanServerName(defaultName(input.spec));
    const id = candidateId(input.spec);
    const c: Candidate = { ...input, name, id, group: groupKey({ name, spec: input.spec }) };
    const old = this.map.get(id);
    if (!old) {
      this.map.set(id, c);
      return c;
    }
    const newer = maxPri(c.evidence) > maxPri(old.evidence);
    const win = newer ? c : old;
    const merged: Candidate = {
      ...win,
      // names from configs / registry beat names inferred from package names
      name: maxPri(c.evidence) >= 70 && maxPri(old.evidence) < 70 ? c.name : old.name,
      group: old.group,
      title: old.title ?? c.title,
      description: old.description ?? c.description,
      spec: win.spec,
      evidence: dedupeEvidence([...old.evidence, ...c.evidence]),
      confidence: CONF_RANK[c.confidence] > CONF_RANK[old.confidence] ? c.confidence : old.confidence,
      warnings: [...new Set([...old.warnings, ...c.warnings])],
    };
    if (merged.confidence === 'medium' && new Set(merged.evidence.map((e) => e.via)).size >= 2) merged.confidence = 'high';
    merged.group = groupKey(merged);
    this.map.set(id, merged);
    return merged;
  }

  update(id: string, fn: (c: Candidate) => Candidate): void {
    const c = this.map.get(id);
    if (c) this.map.set(id, fn(c));
  }

  remove(id: string): void {
    this.map.delete(id);
  }

  values(): Candidate[] {
    return [...this.map.values()];
  }
}

function dedupeEvidence(ev: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return ev.filter((e) => {
    const k = `${e.via}|${e.file ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Higher = better default choice for an ordinary user. */
export function score(c: Candidate): number {
  const conf = { high: 30, medium: 20, low: 0 }[c.confidence];
  const s = c.spec;
  let k = 40;
  if (s.kind === 'mcp-local') {
    if (s.needsBuild) k = -50;
    else if (s.runtime === 'docker') k = 10;
    else if (s.packageRef?.startsWith('npm:') || s.packageRef?.startsWith('pypi:')) k = 40;
    else if (s.packageRef?.startsWith('git:')) k = 25;
    else k = 5;
  } else if (s.kind === 'mcp-remote') k = 35;
  else if (s.kind === 'mcpb') k = 30;
  else if (s.kind === 'plugin') {
    // the install path the README documents beats a dev marketplace file in the repo
    if (c.evidence.some((e) => e.via === 'readme-command' || e.via === 'user-input')) k += 10;
    if (!s.marketplace?.source) k -= 20;
  }
  return conf + k + Math.min(c.evidence.length, 3) * 3;
}

export function groupCandidates(cands: Candidate[]): CandidateGroup[] {
  const byGroup = new Map<string, Candidate[]>();
  for (const c of cands) {
    const list = byGroup.get(c.group) ?? [];
    list.push(c);
    byGroup.set(c.group, list);
  }
  const kindOrder = (g: string) => (g.startsWith('mcp:') ? 0 : g.startsWith('plugin:') ? 1 : 2);
  return [...byGroup.entries()]
    .map(([group, list]) => {
      const sorted = [...list].sort((a, b) => score(b) - score(a));
      return { group, primary: sorted[0], alternatives: sorted.slice(1) };
    })
    .sort((a, b) => kindOrder(a.group) - kindOrder(b.group) || score(b.primary) - score(a.primary));
}

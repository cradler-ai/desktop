import type { FetchLike, RepoView } from './types';
import { t } from './i18n';

export interface GitHubLocation {
  owner: string;
  repo: string;
  ref?: string;
  /** Directory inside the repo (from /tree/<ref>/<path> or the folder of /blob/<ref>/<file>). */
  subpath?: string;
}

export function parseGitHubInput(input: string): GitHubLocation | null {
  const s = input.trim().replace(/\/+$/, '');
  let m = s.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?(?:[?#].*)?$/i,
  );
  if (m) {
    const [, owner, repo, kind, ref, path] = m;
    let subpath: string | undefined = path;
    if (kind === 'blob' && path) subpath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined;
    return { owner, repo, ref, subpath: subpath || undefined };
  }
  m = s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  m = s.match(/^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

export class GitHubError extends Error {
  constructor(
    public code: 'not-found' | 'rate-limited' | 'network' | 'other',
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubOptions {
  fetch: FetchLike;
  token?: string;
}

export async function openGitHubRepo(loc: GitHubLocation, opts: GitHubOptions): Promise<RepoView> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const api = async (path: string, allow404 = false): Promise<any> => {
    let res;
    try {
      res = await opts.fetch(`https://api.github.com${path}`, { headers });
    } catch {
      throw new GitHubError('network', t('github.network'));
    }
    if (res.status === 404) {
      if (allow404) return null;
      throw new GitHubError('not-found', t('github.notFound'));
    }
    if (res.status === 403 || res.status === 429) throw new GitHubError('rate-limited', t('github.rateLimited'));
    if (!res.ok) throw new GitHubError('other', t('github.other', { status: res.status }));
    return res.json();
  };

  const meta = await api(`/repos/${loc.owner}/${loc.repo}`);
  const owner: string = meta.owner?.login ?? loc.owner;
  const repo: string = meta.name ?? loc.repo;
  const ref: string = loc.ref ?? meta.default_branch;
  const tree = await api(`/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);

  const prefix = loc.subpath ? loc.subpath.replace(/^\/+|\/+$/g, '') + '/' : '';
  let files: string[] = (tree.tree as any[]).filter((e) => e.type === 'blob').map((e) => e.path as string);
  if (prefix) files = files.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));

  const cache = new Map<string, Promise<string | null>>();
  const read = (p: string): Promise<string | null> => {
    let hit = cache.get(p);
    if (!hit) {
      const full = (prefix + p).split('/').map(encodeURIComponent).join('/');
      hit = opts
        .fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${full}`)
        .then((r) => (r.ok ? r.text() : null))
        .catch(() => null);
      cache.set(p, hit);
    }
    return hit;
  };

  return {
    source: { owner, repo, ref },
    subpath: prefix ? prefix.slice(0, -1) : undefined,
    files,
    read,
    truncated: !!tree.truncated,
    meta: {
      owner,
      repo,
      ref,
      url: meta.html_url ?? `https://github.com/${owner}/${repo}`,
      description: meta.description ?? undefined,
      stars: meta.stargazers_count,
      archived: !!meta.archived,
      license: meta.license?.spdx_id ?? undefined,
    },
    releaseAssets: async () => {
      const rel = await api(`/repos/${owner}/${repo}/releases/latest`, true).catch(() => null);
      return ((rel?.assets as any[]) ?? []).map((a) => ({ name: a.name as string, url: a.browser_download_url as string }));
    },
  };
}

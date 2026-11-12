import type { FetchLike } from './types';

export interface PackageInfo {
  /** false only when the registry says 404; network errors count as "unknown" (true). */
  exists: boolean;
  description?: string;
  version?: string;
}

export type PackageChecker = (packageRef: string) => Promise<PackageInfo> | null;

export function createPackageChecker(fetch: FetchLike): PackageChecker {
  const cache = new Map<string, Promise<PackageInfo>>();
  return (ref) => {
    const i = ref.indexOf(':');
    const reg = ref.slice(0, i);
    const name = ref.slice(i + 1);
    if (reg !== 'npm' && reg !== 'pypi') return null;
    let hit = cache.get(ref);
    if (!hit) {
      hit = (async (): Promise<PackageInfo> => {
        try {
          const url =
            reg === 'npm'
              ? `https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`
              : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
          const r = await fetch(url, { headers: { Accept: 'application/json' } });
          if (r.status === 404) return { exists: false };
          if (!r.ok) return { exists: true };
          const j = await r.json();
          return reg === 'npm'
            ? { exists: true, description: j.description, version: j.version }
            : { exists: true, description: j.info?.summary, version: j.info?.version };
        } catch {
          return { exists: true };
        }
      })();
      cache.set(ref, hit);
    }
    return hit;
  };
}

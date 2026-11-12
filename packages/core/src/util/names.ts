export function sanitizeName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'mcp'
  );
}

/** "@playwright/mcp" -> "playwright", "@upstash/context7-mcp" -> "context7", "mcp-server-fetch" -> "fetch". */
export function inferNameFromPackage(pkg: string): string {
  let scope = '';
  let name = pkg;
  // strip registry prefix and URL-ish bits
  name = name.replace(/^(npm|pypi|docker|git):/, '');
  if (/^(https?:\/\/|git\+)/.test(name)) {
    const m = name.match(/github\.com\/[\w.-]+\/([\w.-]+?)(?:\.git)?(?:[#@/?].*)?$/);
    name = m ? m[1] : name;
  }
  if (name.includes('/') && !name.startsWith('@')) {
    // docker image like ghcr.io/github/github-mcp-server or mcp/fetch
    const parts = name.split('/');
    name = parts[parts.length - 1];
    scope = parts.length > 1 ? parts[parts.length - 2] : '';
  }
  if (name.startsWith('@')) {
    const [s, n] = name.slice(1).split('/');
    scope = s;
    name = n ?? '';
  }
  name = name
    .replace(/^(mcp[-_]server[-_]|server[-_]|mcp[-_])/i, '')
    .replace(/([-_]mcp[-_]server|[-_]mcp|[-_]server)$/i, '');
  if (!name || /^(mcp|server|mcp-server|cli)$/i.test(name)) name = scope || pkg;
  return sanitizeName(name);
}

/** "playwright-mcp" -> "playwright", "mcp-server-fetch" -> "fetch", "firecrawl-mcp-server" -> "firecrawl". */
export function cleanServerName(s: string): string {
  const base = sanitizeName(s);
  const cleaned = base
    .replace(/^(mcp[-_]server[-_]|server[-_]|mcp[-_])/, '')
    .replace(/([-_]mcp[-_]server|[-_]mcp|[-_]server)$/, '');
  return cleaned && !/^(mcp|server)$/.test(cleaned) ? cleaned : base;
}

const STOP_TOKENS = new Set(['mcp', 'server', 'servers', 'ai', 'the', 'official', 'tool', 'tools', 'awslabs', 'io', 'com']);

/** Meaningful tokens of a name, used to match alternatives of the same server. */
export function nameTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP_TOKENS.has(t)),
  );
}

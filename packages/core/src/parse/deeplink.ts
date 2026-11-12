// "Add to Cursor" / "Install in VS Code" buttons in READMEs carry a full server config.

export interface DeeplinkServer {
  name: string;
  entry: Record<string, unknown>;
  client: 'cursor' | 'vscode';
}

const CURSOR_RE =
  /(?:cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install|https:\/\/cursor\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?install-mcp)\?([^\s)"'<>\]]+)/gi;
const VSCODE_RE =
  /(?:vscode(?:-insiders)?:\/?\/?mcp\/install\?|https:\/\/(?:insiders\.)?vscode\.dev\/redirect\/mcp\/install\?)([^\s)"'<>\]]+)/gi;

function rawParam(query: string, key: string): string | null {
  const m = query.match(new RegExp(`(?:^|&)${key}=([^&]*)`));
  return m ? m[1] : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function decodeBase64(s: string): string {
  try {
    const norm = safeDecode(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(norm);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function findDeeplinks(text: string): DeeplinkServer[] {
  const src = text.replace(/&amp;/g, '&');
  const out: DeeplinkServer[] = [];
  for (const m of src.matchAll(CURSOR_RE)) {
    const q = m[1];
    const cfg = rawParam(q, 'config');
    if (!cfg) continue;
    const entry = safeJson(decodeBase64(cfg)) ?? safeJson(safeDecode(cfg));
    if (entry) out.push({ name: safeDecode(rawParam(q, 'name') ?? ''), entry, client: 'cursor' });
  }
  for (const m of src.matchAll(VSCODE_RE)) {
    const q = m[1];
    if (q.startsWith('%7B') || q.startsWith('{')) {
      const e = safeJson(safeDecode(q));
      if (e) out.push({ name: String(e.name ?? ''), entry: e, client: 'vscode' });
      continue;
    }
    const cfg = rawParam(q, 'config');
    if (!cfg) continue;
    const e = safeJson(safeDecode(cfg)) ?? safeJson(decodeBase64(cfg));
    if (e) out.push({ name: safeDecode(rawParam(q, 'name') ?? String(e.name ?? '')), entry: e, client: 'vscode' });
  }
  return out;
}

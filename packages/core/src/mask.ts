// Never show secrets on screen: keep a short prefix so people can still tell keys apart.
import type { RawServerConfig } from './inventory';
import { looksSecret } from './util/placeholder';

const TOKENISH = /^[A-Za-z0-9_\-.:+/=]{24,}$/;

export function maskValue(value: string, keyHint = ''): string {
  if (!value) return value;
  const bearer = /^(Bearer|Token|Basic)\s+(.+)$/i.exec(value);
  if (bearer) return `${bearer[1]} ${maskValue(bearer[2], 'token')}`;
  if (value.startsWith('${')) return value; // a reference, not a secret
  if (looksSecret(keyHint) || TOKENISH.test(value)) {
    if (value.length <= 8) return '••••';
    return `${value.slice(0, 4)}••••${value.slice(-2)}`;
  }
  return value;
}

export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams) if (looksSecret(k) || TOKENISH.test(v)) u.searchParams.set(k, maskValue(v, k));
    u.pathname = u.pathname
      .split('/')
      .map((seg) => (TOKENISH.test(seg) && /\d/.test(seg) ? maskValue(seg, 'token') : seg))
      .join('/');
    return decodeURI(u.toString());
  } catch {
    return url;
  }
}

export function maskArgs(args: string[]): string[] {
  return args.map((a, i) => {
    const eq = /^(--?[\w-]+)=(.*)$/.exec(a);
    if (eq) return `${eq[1]}=${maskValue(eq[2], eq[1])}`;
    const prev = args[i - 1];
    if (prev && /^--?[\w-]+$/.test(prev) && looksSecret(prev)) return maskValue(a, 'token');
    return TOKENISH.test(a) && /\d/.test(a) && !a.includes('/') ? maskValue(a, 'token') : a;
  });
}

/** One line for the UI: the command or the URL, with secrets masked. */
export function displayRaw(raw: RawServerConfig): string {
  if (raw.url) return maskUrl(raw.url);
  const parts = [raw.command ?? '', ...maskArgs(raw.args)];
  return parts.map((p) => (/\s/.test(p) ? JSON.stringify(p) : p)).join(' ').trim();
}

/** A masked JSON snippet of the whole config, for the detail view. */
export function displayConfig(raw: RawServerConfig): string {
  const out: Record<string, unknown> = {};
  if (raw.url) {
    out.url = maskUrl(raw.url);
    if (Object.keys(raw.headers).length) out.headers = Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, maskValue(v, k)]));
  } else {
    out.command = raw.command;
    if (raw.args.length) out.args = maskArgs(raw.args);
  }
  if (Object.keys(raw.env).length) out.env = Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, maskValue(v, k)]));
  if (raw.cwd) out.cwd = raw.cwd;
  return JSON.stringify(out, null, 2);
}

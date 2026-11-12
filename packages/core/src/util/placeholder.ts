// Heuristics for spotting values in README snippets that the user must replace.

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^\s*$/, // empty
  /^<[^>]*>$/, // <YOUR_TOKEN>
  /^\[[A-Za-z_][\w\s-]*\]$/, // [YOUR_TOKEN]  (not JSON arrays)
  /^\{[A-Za-z_][\w\s-]*\}$/, // {token}       (not JSON objects)
  /^\$\{[^}]+\}$/, // ${VAR} / ${input:x}
  /^\$[A-Za-z_][A-Za-z0-9_]*$/, // $VAR
  /^%[A-Za-z_][A-Za-z0-9_]*%$/, // %VAR%
  /\byour[_\-\s]?/i,
  /YOUR_/,
  /[-_\s]here$/i,
  /^x{3,}$/i,
  /^\*{3,}$/,
  /\.\.\.|…/,
  /change[_-]?me|replace[_\-\s]?(me|with|this)|placeholder|insert[_\-\s]/i,
  /^(sk|ghp|gho|github_pat|pk|rk|fc|ntn|secret|xox[bp])[-_](x{3,}|\.\.\.)/i,
  /<[^>\s]+>/,
];

export function isPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

const SECRET_TOKENS = new Set(['KEY', 'APIKEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PWD', 'CREDENTIAL', 'CREDENTIALS', 'COOKIE', 'AUTH', 'AUTHORIZATION', 'PAT', 'BEARER']);

export function looksSecret(name: string): boolean {
  const tokens = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  return tokens.some((t) => SECRET_TOKENS.has(t));
}

const PATH_PLACEHOLDER =
  /^(~?\/path\/to\b|\/absolute\/path|\/full\/path|\/Users\/(username|user|you|yourname|your[-_]?\w*|<[^>]+>|\$USER|name)\b|\/home\/(username|user|you|yourname|your[-_]?\w*|<[^>]+>)\b|[A-Z]:\\{1,2}(Users\\{1,2}(username|user|your\w*)|path\\{1,2}to)|<[^>]*(path|dir|folder|directory)[^>]*>|\/path\/)/i;

const EDITOR_PATH_VAR = /^\$\{(workspaceFolder|workspaceRoot|userHome|cwd|fileDirname|HOME)\}/;

export function isPathPlaceholder(value: string): boolean {
  return PATH_PLACEHOLDER.test(value) || EDITOR_PATH_VAR.test(value);
}

export function looksLikePath(value: string): boolean {
  return /^(~|\/|[A-Za-z]:\\|\.\.?\/)/.test(value);
}

/** Finds a placeholder fragment inside a URL, e.g. https://x.com/<id>/sse */
export function findUrlPlaceholder(url: string): string | null {
  const m = url.match(/(<[^>]+>|\{[^}]+\}|\$\{[^}]+\}|YOUR[_-][A-Z0-9_-]+|your[-_][a-z0-9_-]+)/);
  return m ? m[1] : null;
}

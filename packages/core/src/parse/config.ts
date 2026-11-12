import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import type { McpLocalSpec, McpRemoteSpec } from '../types';
import { buildLocalSpec, buildRemoteSpec, guessTransport } from '../spec';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Parses a JSON / JSONC / TOML snippet copied from a README or pasted by the user. */
export function parseConfigText(text: string): unknown | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\s*\[[\w.\-"]+\]\s*$/m.test(t) && /mcp_servers|command\s*=|url\s*=/.test(t)) {
    try {
      return parseToml(t);
    } catch {
      /* fall through */
    }
  }
  const cleaned = t
    .split('\n')
    .filter((l) => !/^\s*(\.\.\.|…|\/\/\s*\.\.\.)\s*,?\s*$/.test(l))
    .join('\n');
  for (const candidate of [cleaned, `{${cleaned}}`]) {
    const errors: ParseError[] = [];
    const v = parseJsonc(candidate, errors, { allowTrailingComma: true, disallowComments: false });
    if (!errors.length && isObj(v)) return v;
  }
  return null;
}

export interface RawServer {
  name: string;
  entry: Obj;
  format: string;
}

/** A URL that can plausibly be an MCP endpoint (not a git repo, not a docs/example page). */
export function isServerUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/.test(url)) return false;
  if (/\.git($|[#?])/.test(url)) return false;
  if (/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+\/?$/.test(url)) return false;
  if (/^https?:\/\/(www\.)?example\.(com|org)\b/.test(url)) return false;
  return true;
}

const hasCommand = (v: Obj) =>
  (typeof v.command === 'string' && v.command.trim() !== '') ||
  (Array.isArray(v.command) && typeof v.command[0] === 'string') ||
  (isObj(v.command) && typeof (v.command as Obj).path === 'string');

const urlOf = (v: Obj) => v.url ?? v.serverUrl ?? v.httpUrl;

/** Inside an explicit container (mcpServers, servers, ...) a command or URL is enough. */
function looksLikeServer(v: Obj): boolean {
  return hasCommand(v) || isServerUrl(urlOf(v));
}

/** Outside a container we need stronger signals, otherwise tool-call examples like {"url": "..."} slip in. */
function looksLikeBareServer(v: Obj): boolean {
  if (hasCommand(v)) return Array.isArray(v.args) || isObj(v.env) || Array.isArray(v.command) || isObj(v.command);
  const url = urlOf(v);
  if (!isServerUrl(url)) return false;
  const declared = String(v.type ?? v.transport ?? '');
  if (/http|sse|stream|remote/i.test(declared) || /\/(mcp|sse)(\/|$|\?)/.test(url)) return true;
  try {
    return /(^|\.)mcp\./.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Finds MCP server entries in configs for Claude, Cursor, VS Code, Zed, Codex, OpenCode, Gemini, ... */
export function findServers(obj: unknown): RawServer[] {
  if (!isObj(obj)) return [];
  const out: RawServer[] = [];
  const take = (container: unknown, format: string, test: (v: Obj) => boolean = looksLikeServer) => {
    if (!isObj(container)) return;
    for (const [k, v] of Object.entries(container)) if (isObj(v) && test(v)) out.push({ name: k, entry: v, format });
  };
  take(obj.mcpServers, 'mcpServers');
  take(obj.servers, 'vscode');
  if (isObj(obj.mcp)) {
    if (isObj(obj.mcp.servers)) take(obj.mcp.servers, 'vscode');
    else take(obj.mcp, 'opencode');
  }
  take(obj.context_servers, 'zed');
  take(obj.mcp_servers, 'codex');
  if (!out.length) take(obj, 'bare', looksLikeBareServer);
  if (!out.length && looksLikeBareServer(obj)) out.push({ name: typeof obj.name === 'string' ? obj.name : '', entry: obj, format: 'single' });
  return out;
}

/** Converts one server entry (any client's format) into a spec. */
export function entryToSpec(entry: Obj): McpLocalSpec | McpRemoteSpec | null {
  let command: unknown;
  let args: unknown;
  let env: unknown;
  if (isObj(entry.command)) {
    command = entry.command.path;
    args = entry.command.args;
    env = entry.command.env;
  } else if (Array.isArray(entry.command)) {
    command = entry.command[0];
    args = entry.command.slice(1);
    env = entry.environment ?? entry.env;
  } else {
    command = entry.command;
    args = entry.args;
    env = entry.env ?? entry.environment;
  }
  const url = entry.url ?? entry.serverUrl ?? entry.httpUrl ?? entry.uri;
  const declared = String(entry.type ?? entry.transport ?? '');
  if (isServerUrl(url) && typeof command !== 'string') {
    const headers: Obj = { ...(isObj(entry.headers) ? entry.headers : {}), ...(isObj(entry.http_headers) ? entry.http_headers : {}) };
    if (typeof entry.bearer_token_env_var === 'string') headers.Authorization = `Bearer \${${entry.bearer_token_env_var}}`;
    return buildRemoteSpec(url, guessTransport(url, declared), headers);
  }
  if (typeof command === 'string' && command.trim()) {
    const argList = Array.isArray(args) ? args.map((a) => String(a)) : [];
    return buildLocalSpec(command, argList, env);
  }
  return null;
}

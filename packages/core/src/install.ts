// Turns "install X into these apps" into concrete, reviewable steps.
// The desktop app executes the steps (Rust backs up every file before writing).
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import type { InputField, McpLocalSpec, McpRemoteSpec, PluginSpec } from './types';
import type { RawServerConfig } from './inventory';
import type { ClientId } from './targets';
import { sanitizeName } from './util/names';
import { t } from './i18n';

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Inputs (API keys, folders...)

export const inputId = (i: InputField) => `${i.target}:${i.key}:${i.argIndex ?? ''}`;

export function missingInputs(spec: McpLocalSpec | McpRemoteSpec, values: Record<string, string>): InputField[] {
  return spec.inputs.filter((i) => i.required && !(values[inputId(i)] ?? '').trim());
}

/** The final config with the user's values filled in. */
export function applyInputs(spec: McpLocalSpec | McpRemoteSpec, values: Record<string, string>): RawServerConfig {
  const val = (i: InputField) => (values[inputId(i)] ?? '').trim();
  if (spec.kind === 'mcp-local') {
    const args = [...spec.args];
    const env = { ...spec.env };
    for (const i of spec.inputs) {
      const v = val(i);
      if (!v) continue;
      if (i.target === 'env') env[i.key] = v;
      else if (i.target === 'arg' && i.argIndex != null) args[i.argIndex] = i.template ? i.template.replace('{value}', v) : v;
    }
    return { command: spec.command, args, env, headers: {} };
  }
  let url = spec.url;
  const headers = { ...spec.headers };
  for (const i of spec.inputs) {
    const v = val(i);
    if (!v) continue;
    if (i.target === 'header') headers[i.key] = (i.template ?? '{value}').replace('{value}', v);
    else if (i.target === 'url' && i.template) url = i.template.replace('{value}', v);
  }
  return { url, headers, transport: spec.transport, args: [], env: {} };
}

// ---------------------------------------------------------------------------
// MCP servers

export type InstallStep =
  | { kind: 'cli'; client: ClientId; program: 'claude'; args: string[] }
  | { kind: 'json'; client: ClientId; path: string; name: string; entry: Obj }
  | { kind: 'toml'; client: ClientId; path: string; name: string; raw: RawServerConfig };

export function configPathFor(client: ClientId, home: string): string | null {
  switch (client) {
    case 'claude-desktop':
      return `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
    case 'cursor':
      return `${home}/.cursor/mcp.json`;
    case 'gemini':
      return `${home}/.gemini/settings.json`;
    case 'codex':
      return `${home}/.codex/config.toml`;
    case 'claude-code':
      return `${home}/.claude.json`;
    default:
      return null;
  }
}

/** The server entry in each app's own format. */
export function mcpEntryFor(client: ClientId, raw: RawServerConfig): Obj | null {
  const env = Object.keys(raw.env).length ? { env: raw.env } : {};
  const headers = Object.keys(raw.headers).length ? { headers: raw.headers } : {};
  if (raw.command) {
    const base = { command: raw.command, args: raw.args, ...env };
    switch (client) {
      case 'claude-code':
        return { type: 'stdio', command: raw.command, args: raw.args, env: raw.env };
      case 'cursor':
      case 'claude-desktop':
      case 'gemini':
        return base;
      default:
        return null;
    }
  }
  if (!raw.url) return null;
  switch (client) {
    case 'claude-code':
      return { type: raw.transport ?? 'http', url: raw.url, ...headers };
    case 'cursor':
      return { url: raw.url, ...headers };
    case 'gemini':
      return raw.transport === 'sse' ? { url: raw.url, ...headers } : { httpUrl: raw.url, ...headers };
    default:
      return null; // Claude Desktop / ChatGPT add remote servers in their own settings
  }
}

export function planMcpInstall(client: ClientId, name: string, raw: RawServerConfig, home: string): InstallStep | null {
  const key = sanitizeName(name);
  if (client === 'codex') return { kind: 'toml', client, path: configPathFor('codex', home)!, name: key, raw };
  const entry = mcpEntryFor(client, raw);
  if (!entry) return null;
  if (client === 'claude-code') return { kind: 'cli', client, program: 'claude', args: ['mcp', 'add-json', key, JSON.stringify(entry), '-s', 'user'] };
  const path = configPathFor(client, home);
  return path ? { kind: 'json', client, path, name: key, entry } : null;
}

function detectIndent(text: string): number {
  const m = /\n( +)"/.exec(text);
  return m ? Math.min(m[1].length, 8) : 2;
}

/** Adds or replaces mcpServers[name] while keeping the rest of the file (comments, order, formatting) intact. */
export function upsertJsonServer(text: string | null, name: string, entry: Obj): { text: string; replaced: boolean } {
  const src = text && text.trim() ? text : '{}\n';
  const errors: ParseError[] = [];
  const current = parseJsonc(src, errors, { allowTrailingComma: true });
  if (errors.length || !isObj(current)) throw new Error(t('install.badJson'));
  const replaced = isObj(current.mcpServers) && name in current.mcpServers;
  const edits = modify(src, ['mcpServers', name], entry, {
    formattingOptions: { insertSpaces: true, tabSize: detectIndent(src), eol: '\n' },
  });
  let out = applyEdits(src, edits);
  if (!out.endsWith('\n')) out += '\n';
  return { text: out, replaced };
}

const tomlStr = (v: string) => JSON.stringify(v); // JSON escapes are valid TOML basic-string escapes
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));
const inlineTable = (o: Record<string, string>) => `{ ${Object.entries(o).map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`).join(', ')} }`;

export function tomlServerBlock(name: string, raw: RawServerConfig): string {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  if (raw.command) {
    lines.push(`command = ${tomlStr(raw.command)}`);
    lines.push(`args = [${raw.args.map(tomlStr).join(', ')}]`);
    if (Object.keys(raw.env).length) lines.push(`env = ${inlineTable(raw.env)}`);
  } else if (raw.url) {
    lines.push(`url = ${tomlStr(raw.url)}`);
    if (Object.keys(raw.headers).length) lines.push(`http_headers = ${inlineTable(raw.headers)}`);
  }
  return lines.join('\n') + '\n';
}

/** Line range of `[mcp_servers.<name>]` plus its sub-tables (`[mcp_servers.<name>.env]` ...), or null. */
export function tomlBlockRange(lines: string[], name: string): { start: number; end: number } | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[\\s*mcp_servers\\.("?)${esc}\\1\\s*\\]\\s*(#.*)?$`);
  const sub = new RegExp(`^\\[\\[?\\s*mcp_servers\\.("?)${esc}\\1\\.`);
  const start = lines.findIndex((l) => header.test(l.trim()));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim().startsWith('[') && !sub.test(lines[end].trim()))) end++;
  // keep blank lines that separated it from the next table
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return { start, end };
}

/** Adds or replaces [mcp_servers.<name>] in Codex's config.toml, leaving everything else untouched. */
export function upsertTomlServer(text: string | null, name: string, raw: RawServerConfig): { text: string; replaced: boolean } {
  const src = text ?? '';
  let parsed: Obj = {};
  try {
    parsed = parseToml(src) as Obj;
  } catch {
    throw new Error(t('install.badJson'));
  }
  const exists = isObj(parsed.mcp_servers) && name in parsed.mcp_servers;
  const block = tomlServerBlock(name, raw);
  const lines = src.split('\n');
  const range = tomlBlockRange(lines, name);
  let out: string;
  if (range) {
    out = [...lines.slice(0, range.start), block.trimEnd(), ...lines.slice(range.end)].join('\n');
  } else if (exists) {
    throw new Error(t('install.oddCodex'));
  } else {
    out = (src.trimEnd() ? src.trimEnd() + '\n\n' : '') + block;
  }
  if (!out.endsWith('\n')) out += '\n';
  try {
    const check = parseToml(out) as Obj;
    if (!isObj(check.mcp_servers?.[name])) throw new Error();
  } catch {
    throw new Error(t('install.validateFailed'));
  }
  return { text: out, replaced: exists };
}

// ---------------------------------------------------------------------------
// Skills and plugins

export function skillFolderName(name: string, dir: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return name;
  const base = dir.split('/').filter(Boolean).pop() ?? '';
  return sanitizeName(base || name);
}

export function skillTargetDir(client: ClientId, home: string, folder: string): string | null {
  if (client === 'claude-code') return `${home}/.claude/skills/${folder}`;
  if (client === 'codex') return `${home}/.codex/skills/${folder}`;
  return null;
}

/** `claude plugin ...` argument lists to run in order. */
export function planPluginInstall(spec: PluginSpec): string[][] | null {
  const m = spec.marketplace;
  if (!m?.name) return null;
  const steps: string[][] = [];
  if (m.source) steps.push(['plugin', 'marketplace', 'add', m.source]);
  steps.push(['plugin', 'install', `${spec.plugin}@${m.name}`]);
  return steps;
}

// ---------------------------------------------------------------------------

export function afterInstallNote(client: ClientId): { text: string; restart?: string } {
  if (client === 'claude-desktop') return { text: t('after.claude-desktop'), restart: 'Claude' };
  if (['claude-code', 'codex', 'cursor', 'gemini'].includes(client)) return { text: t(`after.${client}`) };
  return { text: '' };
}

/** One-step instructions for apps we can't write to directly. */
export function guidedInstructions(client: ClientId, kind: 'local' | 'remote' | 'skill' | 'plugin'): string {
  if (client === 'chatgpt') return t('guide.chatgpt');
  if (client === 'cherry-studio') return t('guide.cherry');
  if (client === 'claude-desktop' && kind === 'remote') return t('guide.desktopRemote');
  if (client === 'claude-desktop' && kind === 'skill') return t('guide.desktopSkill');
  if (client === 'claude-desktop' && kind === 'plugin') return t('guide.desktopPlugin');
  return '';
}

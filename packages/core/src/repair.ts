// Applies a repair from diagnose.ts to the place the server is configured.
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { InstalledServer, RawServerConfig } from './inventory';
import type { RepairField, RepairKind } from './diagnose';
import type { FetchLike } from './types';
import { mcpEntryFor, tomlBlockRange } from './install';
import { createPackageChecker } from './registry';
import { tokenize } from './parse/shell';
import { commandBase } from './util/command';
import { t } from './i18n';

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (raw: RawServerConfig): RawServerConfig => ({ ...raw, args: [...raw.args], env: { ...raw.env }, headers: { ...raw.headers } });

export interface RepairInput {
  /** set-values: values keyed by field key */
  values?: Record<string, string>;
  /** edit-url */
  url?: string;
  /** use-runner: what to run instead (from findRunner) */
  runner?: { command: string; args: string[] };
}

/** The config after the repair (null = remove the entry). */
export function repairedRaw(raw: RawServerConfig, kind: RepairKind, input: RepairInput = {}, fields: RepairField[] = []): RawServerConfig | null {
  if (kind === 'remove') return null;
  const next = clone(raw);
  switch (kind) {
    case 'split-command': {
      const parts = tokenize(raw.command ?? '');
      next.command = parts[0];
      next.args = [...parts.slice(1), ...raw.args];
      return next;
    }
    case 'use-runner':
      if (!input.runner) throw new Error('no runner');
      next.command = input.runner.command;
      next.args = [...input.runner.args, ...raw.args];
      return next;
    case 'edit-url':
      if (!input.url) throw new Error('no url');
      next.url = input.url.trim();
      return next;
    case 'set-values':
      for (const f of fields) {
        const v = input.values?.[f.key]?.trim();
        if (!v) continue;
        const filled = f.template ? f.template.replace('{value}', v) : v;
        if (f.target === 'env') next.env[f.key] = filled;
        else if (f.target === 'header') next.headers[f.key] = filled;
        else if (f.argIndex != null) next.args[f.argIndex] = filled;
      }
      return next;
    default:
      return next; // install-node / install-uv don't touch the config
  }
}

/**
 * For "program not found": a published package that provides it, so it can run via npx / uvx.
 * Official @modelcontextprotocol packages first, then PyPI, then npm by exact name.
 */
export async function findRunner(command: string, fetch: FetchLike): Promise<{ command: string; args: string[] } | null> {
  const base = commandBase(command);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(base)) return null;
  const check = createPackageChecker(fetch);
  const suffix = /^mcp-server-(.+)$/.exec(base)?.[1];
  const candidates: [string, { command: string; args: string[] }][] = [];
  if (suffix) candidates.push([`npm:@modelcontextprotocol/server-${suffix}`, { command: 'npx', args: ['-y', `@modelcontextprotocol/server-${suffix}`] }]);
  candidates.push([`pypi:${base}`, { command: 'uvx', args: [base] }]);
  candidates.push([`npm:${base}`, { command: 'npx', args: ['-y', base] }]);
  for (const [ref, runner] of candidates) {
    const info = await check(ref);
    if (info?.exists) return runner;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writing back

export type RepairWrite =
  | { kind: 'file'; path: string; text: string }
  | { kind: 'cli'; cwd?: string; steps: string[][]; undo: string[][] };

const ENTRY_KEYS_LOCAL = ['command', 'args', 'env'] as const;

function jsonPatch(text: string, base: (string | number)[], raw: RawServerConfig | null, current: Obj): string {
  const fmt = { formattingOptions: { insertSpaces: true, tabSize: /\n( +)"/.exec(text)?.[1].length ?? 2, eol: '\n' } };
  if (!raw) return applyEdits(text, modify(text, base, undefined, fmt));
  let out = text;
  const set = (key: string, value: unknown) => {
    out = applyEdits(out, modify(out, [...base, key], value, fmt));
  };
  if (raw.command) {
    for (const k of ENTRY_KEYS_LOCAL) {
      const v = raw[k];
      if (k === 'env' && !Object.keys(raw.env).length && !('env' in current)) continue;
      set(k, v);
    }
  } else if (raw.url) {
    const urlKey = ['httpUrl', 'serverUrl', 'url'].find((k) => k in current) ?? 'url';
    set(urlKey, raw.url);
    if (Object.keys(raw.headers).length || 'headers' in current) set('headers', raw.headers);
  }
  return out;
}

/** Edits mcpServers[name] in a JSON config (Cursor, Claude Desktop, Gemini, project .mcp.json). */
export function patchJsonServer(text: string, name: string, raw: RawServerConfig | null): string {
  const errors: ParseError[] = [];
  const doc = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length || !isObj(doc)) throw new Error(t('install.badJson'));
  const container = isObj(doc.mcpServers) ? 'mcpServers' : null;
  const current = container ? doc.mcpServers[name] : doc[name];
  if (!isObj(current)) throw new Error(t('install.notFoundInConfig'));
  const base = container ? [container, name] : [name];
  let out = jsonPatch(text, base, raw, current);
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

/** Edits [mcp_servers.<name>] in Codex's config.toml, keeping its other keys (tools, timeouts...). */
export function patchTomlServer(text: string, name: string, raw: RawServerConfig | null): string {
  let doc: Obj;
  try {
    doc = parseToml(text) as Obj;
  } catch {
    throw new Error(t('install.badJson'));
  }
  const current = doc.mcp_servers?.[name];
  if (!isObj(current)) throw new Error(t('install.notFoundInConfig'));
  const lines = text.split('\n');
  const range = tomlBlockRange(lines, name);
  if (!range) throw new Error(t('install.oddCodex'));
  let block = '';
  if (raw) {
    const merged: Obj = { ...current };
    if (raw.command) {
      merged.command = raw.command;
      merged.args = raw.args;
      if (Object.keys(raw.env).length || 'env' in current) merged.env = raw.env;
    } else if (raw.url) {
      merged.url = raw.url;
      if (Object.keys(raw.headers).length || 'http_headers' in current) merged.http_headers = raw.headers;
    }
    block = stringifyToml({ mcp_servers: { [name]: merged } }).trim();
  }
  const out = [...lines.slice(0, range.start), ...(block ? [block] : []), ...lines.slice(range.end)].join('\n').replace(/\n{3,}/g, '\n\n');
  try {
    const check = parseToml(out) as Obj;
    if (raw ? !isObj(check.mcp_servers?.[name]) : isObj(check.mcp_servers?.[name])) throw new Error();
  } catch {
    throw new Error(t('install.validateFailed'));
  }
  return out.endsWith('\n') ? out : out + '\n';
}

/** How to write a repaired server back to where it lives. `currentText` is the config file's content. */
export function planRepairWrite(s: InstalledServer, raw: RawServerConfig | null, currentText: string | null, original?: RawServerConfig): RepairWrite {
  const viaCli = s.client === 'claude-code' && s.configPath.endsWith('/.claude.json');
  if (viaCli) {
    const scope = s.scope === 'project' ? 'local' : 'user';
    const entry = (r: RawServerConfig) => JSON.stringify(mcpEntryFor('claude-code', r));
    const steps = [['mcp', 'remove', s.name, '-s', scope], ...(raw ? [['mcp', 'add-json', s.name, entry(raw), '-s', scope]] : [])];
    const undo = original ? [['mcp', 'remove', s.name, '-s', scope], ['mcp', 'add-json', s.name, entry(original), '-s', scope]] : [];
    return { kind: 'cli', cwd: s.scope === 'project' ? s.projectDir : undefined, steps, undo };
  }
  if (currentText == null) throw new Error(t('install.notFoundInConfig'));
  const text = s.client === 'codex' ? patchTomlServer(currentText, s.name, raw) : patchJsonServer(currentText, s.name, raw);
  return { kind: 'file', path: s.configPath, text };
}

/** Syntax check before saving a whole config file; null when it's fine. Localized message otherwise. */
export function configSyntaxError(text: string, format: 'json' | 'toml'): string | null {
  if (!text.trim()) return null;
  if (format === 'toml') {
    try {
      parseToml(text);
      return null;
    } catch (e) {
      return t('editor.invalidToml', { msg: String(e instanceof Error ? e.message : e).split('\n')[0] });
    }
  }
  const errors: ParseError[] = [];
  parseJsonc(text, errors, { allowTrailingComma: false });
  return errors.length ? t('editor.invalidJson', { line: text.slice(0, errors[0].offset).split('\n').length }) : null;
}

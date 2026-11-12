import type { McpLocalSpec, McpRemoteSpec } from '../types';
import { buildLocalSpec, buildRemoteSpec, guessTransport } from '../spec';
import { analyzeCommand, commandBase, normalizePyName, stripNpmVersion } from '../util/command';

export type ParsedCommand =
  | { type: 'mcp'; name?: string; spec: McpLocalSpec | McpRemoteSpec; tool: string }
  | { type: 'mcp-json'; name: string; json: string }
  | { type: 'skills-add'; source: string; skills: string[] }
  | { type: 'marketplace-add'; source: string }
  | { type: 'plugin-install'; plugin: string; marketplace?: string }
  | { type: 'package-install'; ecosystem: 'npm' | 'pypi'; pkg: string };

export interface ParseCommandOptions {
  /** README mode: only accept bare runner commands that look MCP-related. */
  strict?: boolean;
  /** Package refs known to be MCP servers in this repo (e.g. "npm:foo"). */
  knownPackages?: Set<string>;
}

const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'docker', 'podman', 'pnpm', 'yarn', 'npm', 'bun', 'uv']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function splitKV(s: string): [string, string] {
  const i = s.indexOf('=');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/** `claude mcp add` and `gemini mcp add` share the same shape. */
function claudeLikeAdd(args: string[], tool: string): ParsedCommand | null {
  let transport: string | undefined;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  let rest: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest = args.slice(i + 1); break; }
    // After `<name> <command>` everything belongs to the command; after `<name> <url>` flags still apply.
    if (positional.length >= 2 && !/^https?:\/\//.test(positional[1])) { positional.push(...args.slice(i)); break; }
    if (a === '-t' || a === '--transport') { transport = args[++i]; continue; }
    if (a.startsWith('--transport=')) { transport = a.slice(12); continue; }
    if (a === '-s' || a === '--scope') { i++; continue; }
    if (a === '-e' || a === '--env') {
      while (args[i + 1] && ENV_ASSIGN.test(args[i + 1])) {
        const [k, v] = splitKV(args[++i]);
        env[k] = v;
      }
      continue;
    }
    if (a === '-H' || a === '--header') {
      while (args[i + 1] && /^[^\s:=/]+\s*:/.test(args[i + 1]) && !/^https?:/.test(args[i + 1])) {
        const s = args[++i];
        const idx = s.indexOf(':');
        headers[s.slice(0, idx).trim()] = s.slice(idx + 1).trim();
      }
      continue;
    }
    if (['--client-id', '--client-secret', '--callback-port', '--timeout', '--trust'].includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const name = positional[0];
  let target: string | undefined;
  let targetArgs: string[] = [];
  if (rest && rest.length) {
    target = rest[0];
    targetArgs = rest.slice(1);
  } else {
    target = positional[1];
    targetArgs = positional.slice(2);
  }
  if (!target) return null;
  if (/^https?:\/\//.test(target)) {
    return { type: 'mcp', name, tool, spec: buildRemoteSpec(target, guessTransport(target, transport), headers) };
  }
  return { type: 'mcp', name, tool, spec: buildLocalSpec(target, targetArgs, env) };
}

function codexAdd(args: string[]): ParsedCommand | null {
  let name: string | undefined;
  const env: Record<string, string> = {};
  let url: string | undefined;
  let bearerVar: string | undefined;
  let rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest = args.slice(i + 1); break; }
    if (a === '--env') { const [k, v] = splitKV(args[++i] ?? ''); if (k) env[k] = v; continue; }
    if (a === '--url') { url = args[++i]; continue; }
    if (a === '--bearer-token-env-var') { bearerVar = args[++i]; continue; }
    if (a.startsWith('-')) continue;
    if (!name) { name = a; continue; }
    rest = args.slice(i);
    break;
  }
  if (url) {
    const headers = bearerVar ? { Authorization: `Bearer \${${bearerVar}}` } : {};
    return { type: 'mcp', name, tool: 'codex', spec: buildRemoteSpec(url, guessTransport(url), headers) };
  }
  if (!rest.length) return null;
  return { type: 'mcp', name, tool: 'codex', spec: buildLocalSpec(rest[0], rest.slice(1), env) };
}

function pluginCmd(args: string[]): ParsedCommand | null {
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos[0] === 'marketplace' && pos[1] === 'add' && pos[2]) return { type: 'marketplace-add', source: pos[2] };
  if ((pos[0] === 'install' || pos[0] === 'i') && pos[1]) {
    const [plugin, marketplace] = pos[1].split('@');
    return { type: 'plugin-install', plugin, marketplace };
  }
  return null;
}

function skillsAdd(tokens: string[]): ParsedCommand | null {
  const idx = tokens.findIndex((t) => stripNpmVersion(t) === 'skills');
  const rest = tokens.slice(idx + 1);
  if (rest[0] !== 'add') return null;
  const skills: string[] = [];
  let source: string | undefined;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--skill' || a === '-s') { if (rest[i + 1]) skills.push(rest[++i]); continue; }
    if (a.startsWith('--skill=')) { skills.push(a.slice(8)); continue; }
    if (a === '-a' || a === '--agent') { i++; continue; }
    if (a.startsWith('-')) continue;
    source ??= a;
  }
  return source ? { type: 'skills-add', source, skills } : null;
}

export function parseCommand(tokens: string[], opts: ParseCommandOptions = {}): ParsedCommand | null {
  let t = [...tokens];
  const env: Record<string, string> = {};
  while (t.length && ENV_ASSIGN.test(t[0])) {
    const [k, v] = splitKV(t.shift()!);
    env[k] = v;
  }
  if (t[0] === 'sudo') t.shift();
  if (t[0]?.toLowerCase() === 'cmd' && t[1]?.toLowerCase() === '/c') t = t.slice(2);
  if (!t.length) return null;

  const base = commandBase(t[0]);
  if (base === 'claude' || base === 'gemini' || base === 'qwen') {
    if (t[1] === 'mcp' && t[2] === 'add') return claudeLikeAdd(t.slice(3), base);
    if (t[1] === 'mcp' && t[2] === 'add-json') {
      const pos = t.slice(3).filter((x, i, arr) => !x.startsWith('-') && !['-s', '--scope'].includes(arr[i - 1] ?? ''));
      if (pos[0] && pos[1]) return { type: 'mcp-json', name: pos[0], json: pos[1] };
      return null;
    }
    if (t[1] === 'plugin' || t[1] === 'plugins') return pluginCmd(t.slice(2));
    return null;
  }
  if (t[0] === '/plugin') return pluginCmd(t.slice(1));
  if (base === 'codex' && t[1] === 'mcp' && t[2] === 'add') return codexAdd(t.slice(3));

  if (base === 'npm' && ['i', 'install', 'add'].includes(t[1] ?? '')) {
    const pkg = t.slice(2).find((x) => !x.startsWith('-'));
    if (pkg && (!opts.strict || /mcp/i.test(pkg))) return { type: 'package-install', ecosystem: 'npm', pkg: stripNpmVersion(pkg) };
    return null;
  }
  if (((base === 'pip' || base === 'pip3') && t[1] === 'install') || (base === 'uv' && t[1] === 'pip' && t[2] === 'install')) {
    const pkg = t.slice(base === 'uv' ? 3 : 2).find((x) => !x.startsWith('-'));
    if (pkg && (!opts.strict || /mcp/i.test(pkg))) return { type: 'package-install', ecosystem: 'pypi', pkg: normalizePyName(pkg) };
    return null;
  }

  if (!RUNNERS.has(base)) return null;
  const a = analyzeCommand(t[0], t.slice(1));
  if (!a.packageRef) return null;
  if (a.registry === 'npm' && a.packageName === 'skills') return skillsAdd(t);
  if (a.packageName === '@smithery/cli' || a.packageName === 'create-mcp' || a.packageName?.startsWith('create-')) return null;
  if (a.packageName === '@modelcontextprotocol/inspector') return null;
  if (opts.strict && !/mcp|model-?context/i.test(a.packageRef) && !opts.knownPackages?.has(a.packageRef)) return null;
  return { type: 'mcp', tool: base, spec: buildLocalSpec(t[0], t.slice(1), env) };
}

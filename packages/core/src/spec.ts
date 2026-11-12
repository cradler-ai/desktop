import type { InputField, McpLocalSpec, McpRemoteSpec } from './types';
import { analyzeCommand } from './util/command';
import { findUrlPlaceholder, isPathPlaceholder, isPlaceholder, looksSecret } from './util/placeholder';

const BRIDGE_PACKAGES = new Set(['npm:mcp-remote', 'npm:@modelcontextprotocol/mcp-remote', 'npm:supergateway']);

function toStringRecord(obj: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = v == null ? '' : String(v);
  return out;
}

export function buildRemoteSpec(
  url: string,
  transport: 'http' | 'sse',
  headersIn: unknown = {},
): McpRemoteSpec {
  const inputs: InputField[] = [];
  const headers: Record<string, string> = {};
  for (const [h, v] of Object.entries(toStringRecord(headersIn))) {
    const m = /^(Bearer|Token|Basic)\s+(.*)$/i.exec(v);
    const token = m ? m[2] : v;
    if (isPlaceholder(token)) {
      inputs.push({
        key: h,
        target: 'header',
        template: m ? `${m[1]} {value}` : '{value}',
        required: true,
        secret: true,
        kind: 'text',
      });
    } else headers[h] = v;
  }
  const ph = findUrlPlaceholder(url);
  if (ph) {
    inputs.push({
      key: ph.replace(/[<>{}$]/g, '').replace(/^input:/, ''),
      target: 'url',
      template: url.replace(ph, '{value}'),
      required: true,
      secret: /key|token|secret/i.test(ph),
      kind: 'text',
    });
  }
  return { kind: 'mcp-remote', url, transport, headers, inputs };
}

export function guessTransport(url: string, declared?: string): 'http' | 'sse' {
  const d = (declared ?? '').toLowerCase();
  if (d.includes('sse')) return 'sse';
  if (d.includes('http')) return 'http';
  return /\/sse\/?(\?|$)/.test(url) ? 'sse' : 'http';
}

export function buildLocalSpec(
  command: string,
  args: string[],
  envIn: unknown = {},
): McpLocalSpec | McpRemoteSpec {
  const env = toStringRecord(envIn);
  const a = analyzeCommand(command, args);

  // `npx mcp-remote https://...` is just a bridge to a remote server.
  if (a.packageRef && BRIDGE_PACKAGES.has(a.packageRef)) {
    const url = args.find((x) => /^https?:\/\//.test(x));
    if (url) {
      const headers: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--header' && args[i + 1]) {
          const s = args[i + 1];
          const idx = s.indexOf(':');
          if (idx > 0) headers[s.slice(0, idx).trim()] = s.slice(idx + 1).trim();
        }
      }
      for (const [k, v] of Object.entries(headers)) {
        headers[k] = v.replace(/\$\{(\w+)\}/g, (m, n: string) => (n in env ? env[n] : m));
      }
      return buildRemoteSpec(url, guessTransport(url), headers);
    }
  }

  const inputs: InputField[] = [];
  const fixedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isPlaceholder(v)) inputs.push({ key: k, target: 'env', required: true, secret: looksSecret(k), kind: 'text' });
    else fixedEnv[k] = v;
  }

  if (!a.needsBuild) {
    args.forEach((arg, i) => {
      const eq = arg.match(/^(--?[\w-]+)=(.*)$/);
      if (eq) {
        const [, flag, val] = eq;
        const key = flag.replace(/^-+/, '');
        if (isPathPlaceholder(val)) {
          inputs.push({ key, target: 'arg', argIndex: i, template: `${flag}={value}`, required: true, secret: false, kind: 'path' });
        } else if (isPlaceholder(val)) {
          inputs.push({ key, target: 'arg', argIndex: i, template: `${flag}={value}`, required: true, secret: looksSecret(key), kind: 'text' });
        }
        return;
      }
      if (arg.startsWith('-')) return;
      if (isPathPlaceholder(arg)) {
        const colon = arg.indexOf(':/');
        inputs.push({
          key: `path${i}`,
          target: 'arg',
          argIndex: i,
          template: colon > 0 ? `{value}${arg.slice(colon)}` : undefined,
          required: true,
          secret: false,
          kind: 'path',
        });
        return;
      }
      if (isPlaceholder(arg)) {
        const prev = args[i - 1];
        const key = prev && prev.startsWith('-') ? prev.replace(/^-+/, '') : `arg${i}`;
        inputs.push({ key, target: 'arg', argIndex: i, required: true, secret: looksSecret(key) || looksSecret(arg), kind: 'text' });
      }
    });
  }

  return {
    kind: 'mcp-local',
    runtime: a.runtime,
    command,
    args,
    env: fixedEnv,
    inputs,
    packageRef: a.packageRef,
    needsBuild: a.needsBuild,
  };
}

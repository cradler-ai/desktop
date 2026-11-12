import type { McpLocalSpec, McpRemoteSpec } from '../types';
import { parseCommand, type ParsedCommand } from './command';
import { entryToSpec, findServers, parseConfigText } from './config';
import { findDeeplinks } from './deeplink';
import { splitCommands } from './shell';

export interface MarkdownServer {
  name: string;
  spec: McpLocalSpec | McpRemoteSpec;
  via: 'readme-config' | 'deeplink';
}

export interface MarkdownFindings {
  servers: MarkdownServer[];
  commands: ParsedCommand[];
}

const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([\w+.-]*)[^\n]*\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm;
const SHELL_LANGS = new Set([
  '', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat',
  'text', 'txt', 'fish', 'shellscript', 'sh-session', 'shell-session',
]);
const CONFIG_LANGS = /^(json|jsonc|json5|js|javascript|ts|typescript|toml)?$/;
const CONFIG_HINT = /["']?(command|url|serverUrl|httpUrl|mcpServers|mcp_servers)["']?\s*[:=]/;
const INLINE_RE = /`([^`\n]{6,})`/g;
const CMD_HEAD = /^(\$\s*)?((claude|codex|gemini)\s+(mcp|plugin)\s|\/plugin\s|(npx|pnpx|bunx|uvx|pnpm\s+dlx|docker\s+run)\s)/;

export function scanMarkdown(md: string, opts: { knownPackages?: Set<string> } = {}): MarkdownFindings {
  const servers: MarkdownServer[] = [];
  const commands: ParsedCommand[] = [];
  const cmdOpts = { strict: true, knownPackages: opts.knownPackages };

  for (const m of md.matchAll(FENCE_RE)) {
    const indent = m[1];
    const lang = m[3].toLowerCase();
    let body = m[4];
    if (indent) body = body.split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join('\n');

    if (CONFIG_LANGS.test(lang) && CONFIG_HINT.test(body)) {
      const obj = parseConfigText(body);
      if (obj) {
        for (const s of findServers(obj)) {
          const spec = entryToSpec(s.entry);
          if (spec) servers.push({ name: s.name, spec, via: 'readme-config' });
        }
        continue;
      }
    }
    if (SHELL_LANGS.has(lang)) {
      for (const toks of splitCommands(body)) {
        const c = parseCommand(toks, cmdOpts);
        if (c) commands.push(c);
      }
    }
  }

  const withoutFences = md.replace(FENCE_RE, '');
  for (const m of withoutFences.matchAll(INLINE_RE)) {
    const s = m[1].trim();
    if (!CMD_HEAD.test(s)) continue;
    for (const toks of splitCommands(s)) {
      const c = parseCommand(toks, cmdOpts);
      if (c) commands.push(c);
    }
  }

  for (const d of findDeeplinks(md)) {
    const spec = entryToSpec(d.entry);
    if (spec) servers.push({ name: d.name, spec, via: 'deeplink' });
  }
  return { servers, commands };
}

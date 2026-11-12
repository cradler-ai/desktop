import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  applyInputs,
  inputId,
  missingInputs,
  planMcpInstall,
  planPluginInstall,
  skillFolderName,
  tomlServerBlock,
  upsertJsonServer,
  upsertTomlServer,
} from '../src/install';
import { buildLocalSpec, buildRemoteSpec } from '../src/spec';
import type { McpLocalSpec, McpRemoteSpec } from '../src/types';

const H = '/Users/me';

describe('inputs', () => {
  const local = buildLocalSpec('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/Users/username/Desktop'], { API_KEY: 'YOUR_KEY' }) as McpLocalSpec;
  it('requires every required input', () => {
    expect(missingInputs(local, {}).map((i) => i.key).sort()).toEqual(['API_KEY', 'path2']);
  });
  it('fills env and args', () => {
    const values = Object.fromEntries(local.inputs.map((i) => [inputId(i), i.target === 'env' ? 'sk-real' : '/Users/me/Projects']));
    expect(applyInputs(local, values)).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Projects'],
      env: { API_KEY: 'sk-real' },
      headers: {},
    });
  });
  it('fills header templates on remote servers', () => {
    const remote = buildRemoteSpec('https://api.githubcopilot.com/mcp/', 'http', { Authorization: 'Bearer ${input:pat}' }) as McpRemoteSpec;
    const raw = applyInputs(remote, { [inputId(remote.inputs[0])]: 'ghp_123' });
    expect(raw.headers).toEqual({ Authorization: 'Bearer ghp_123' });
  });
});

describe('planMcpInstall', () => {
  const raw = { command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: 'fc-1' }, headers: {} };
  const remote = { url: 'https://mcp.sentry.dev/mcp', transport: 'http' as const, args: [], env: {}, headers: {} };

  it('claude code uses the official CLI', () => {
    const step = planMcpInstall('claude-code', 'Firecrawl', raw, H);
    expect(step).toMatchObject({ kind: 'cli', program: 'claude' });
    expect(step?.kind === 'cli' && step.args.slice(0, 3)).toEqual(['mcp', 'add-json', 'firecrawl']);
    expect(step?.kind === 'cli' && JSON.parse(step.args[3])).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: 'fc-1' } });
  });
  it('json apps get their own format', () => {
    expect(planMcpInstall('cursor', 'sentry', remote, H)).toMatchObject({ kind: 'json', path: `${H}/.cursor/mcp.json`, entry: { url: remote.url } });
    expect(planMcpInstall('gemini', 'sentry', remote, H)).toMatchObject({ entry: { httpUrl: remote.url } });
    expect(planMcpInstall('claude-desktop', 'sentry', remote, H)).toBeNull(); // added in Claude's settings instead
    expect(planMcpInstall('claude-desktop', 'fc', raw, H)).toMatchObject({ kind: 'json', entry: { command: 'npx', env: { FIRECRAWL_API_KEY: 'fc-1' } } });
    expect(planMcpInstall('codex', 'fc', raw, H)).toMatchObject({ kind: 'toml', path: `${H}/.codex/config.toml` });
  });
});

describe('upsertJsonServer', () => {
  it('creates a new file', () => {
    const r = upsertJsonServer(null, 'pw', { command: 'npx', args: ['@playwright/mcp'] });
    expect(JSON.parse(r.text)).toEqual({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp'] } } });
    expect(r.replaced).toBe(false);
  });
  it('keeps comments, other keys and indentation', () => {
    const src = '{\n    // my servers\n    "theme": "dark",\n    "mcpServers": {\n        "a": { "command": "x" }\n    }\n}\n';
    const r = upsertJsonServer(src, 'b', { url: 'https://y' });
    expect(r.text).toContain('// my servers');
    expect(r.text).toContain('"theme": "dark"');
    expect(r.text).toMatch(/\n {8}"b": \{/);
  });
  it('replaces an existing entry', () => {
    const r = upsertJsonServer('{"mcpServers":{"a":{"command":"old"}}}', 'a', { command: 'new' });
    expect(r.replaced).toBe(true);
    expect(r.text).toContain('"new"');
    expect(r.text).not.toContain('"old"');
  });
  it('refuses to touch a broken file', () => {
    expect(() => upsertJsonServer('{ "mcpServers": { ', 'a', {})).toThrow('格式有错');
  });
});

describe('upsertTomlServer', () => {
  const raw = { command: 'uvx', args: ['mcp-server-fetch'], env: { A: 'say "hi"' }, headers: {} };
  it('writes valid TOML with escaping', () => {
    const block = tomlServerBlock('fetch', raw);
    expect(parseToml(block)).toEqual({ mcp_servers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'], env: { A: 'say "hi"' } } } });
  });
  it('appends without touching the rest', () => {
    const src = 'model = "gpt-5"\n# keep me\n\n[mcp_servers.other]\ncommand = "x"\n';
    const r = upsertTomlServer(src, 'fetch', raw);
    expect(r.text.startsWith(src.trimEnd())).toBe(true);
    expect(parseToml(r.text)).toMatchObject({ model: 'gpt-5', mcp_servers: { other: { command: 'x' }, fetch: { command: 'uvx' } } });
  });
  it('replaces an existing table including its sub-tables', () => {
    const src = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.fetch]',
      'command = "old"',
      '',
      '[mcp_servers.fetch.env]',
      'X = "1"',
      '',
      '[mcp_servers.fetch.tools.get]',
      'approval = "auto"',
      '',
      '[profiles.work]',
      'model = "o3"',
      '',
    ].join('\n');
    const r = upsertTomlServer(src, 'fetch', raw);
    expect(r.replaced).toBe(true);
    const t = parseToml(r.text) as any;
    expect(t.mcp_servers.fetch).toEqual({ command: 'uvx', args: ['mcp-server-fetch'], env: { A: 'say "hi"' } });
    expect(t.profiles.work.model).toBe('o3');
    expect(r.text).not.toContain('old');
  });
  it('refuses to touch a broken file', () => {
    expect(() => upsertTomlServer('[mcp_servers\n', 'a', raw)).toThrow('格式有错');
  });
});

describe('skills & plugins', () => {
  it('folder names', () => {
    expect(skillFolderName('video-case-analyzer-for-seedance', 'skills/x')).toBe('video-case-analyzer-for-seedance');
    expect(skillFolderName('PDF 工具', 'skills/pdf')).toBe('pdf');
  });
  it('plugin steps', () => {
    expect(planPluginInstall({ kind: 'plugin', plugin: 'superpowers', marketplace: { name: 'superpowers-marketplace', source: 'obra/superpowers-marketplace' } })).toEqual([
      ['plugin', 'marketplace', 'add', 'obra/superpowers-marketplace'],
      ['plugin', 'install', 'superpowers@superpowers-marketplace'],
    ]);
    expect(planPluginInstall({ kind: 'plugin', plugin: 'x' })).toBeNull();
  });
});

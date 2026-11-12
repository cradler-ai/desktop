import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { diagnose, isJoinedCommand, precheck, type ProbeResult } from '../src/diagnose';
import { findRunner, patchJsonServer, patchTomlServer, planRepairWrite, repairedRaw } from '../src/repair';
import { pickLocale, setLocale, t } from '../src/i18n';
import { CLIENTS } from '../src/targets';
import type { InstalledServer, RawServerConfig } from '../src/inventory';

const raw = (r: Partial<RawServerConfig>): RawServerConfig => ({ args: [], env: {}, headers: {}, ...r });
const server = (r: Partial<RawServerConfig>, extra: Partial<InstalledServer> = {}): InstalledServer => ({
  key: 'k', name: 'ctx', client: 'cursor', scope: 'user', configPath: '/Users/me/.cursor/mcp.json', disabled: false, raw: raw(r), spec: null, ...extra,
});
const probe = (p: Partial<ProbeResult>): ProbeResult => ({ ok: false, stderr: '', stdoutNoise: [], tools: [], authHeader: false, unresolvedVars: [], elapsedMs: 10, ...p });

describe('repairs offered', () => {
  it('joined command → split', () => {
    const s = server({ command: 'npx @context/mcp-server' });
    expect(isJoinedCommand(s.raw)).toBe(true);
    expect(isJoinedCommand(raw({ command: '/Applications/My App.app/x' }))).toBe(false);
    const d = precheck(s)!;
    expect(d.fixes[0]).toMatchObject({ kind: 'repair', repair: 'split-command', primary: true });
    expect(repairedRaw(s.raw, 'split-command')).toMatchObject({ command: 'npx', args: ['@context/mcp-server'] });
  });
  it('placeholder key → form fields, then filled', () => {
    const s = server({ command: 'npx', args: ['-y', 'figma-developer-mcp', '--figma-api-key=YOUR_FIGMA_API_KEY', '--stdio'] });
    const d = precheck(s)!;
    const fix = d.fixes[0];
    expect(fix).toMatchObject({ repair: 'set-values', fields: [{ key: 'figma-api-key', target: 'arg', argIndex: 2, template: '--figma-api-key={value}' }] });
    expect(repairedRaw(s.raw, 'set-values', { values: { 'figma-api-key': 'fk-123' } }, fix.fields)?.args[2]).toBe('--figma-api-key=fk-123');
  });
  it('missing program → switch to npx/uvx', () => {
    const d = diagnose(server({ command: 'mcp-server-postgres', args: ['postgres://x'] }), probe({ error: 'not-found' }));
    expect(d.fixes[0]).toMatchObject({ repair: 'use-runner', primary: true });
    expect(repairedRaw(raw({ command: 'mcp-server-postgres', args: ['postgres://x'] }), 'use-runner', { runner: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] } })).toMatchObject({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://x'],
    });
  });
  it('404 → edit url; plugin servers get no config repairs', () => {
    const d = diagnose(server({ url: 'https://old.example.dev/mcp', transport: 'http' }), probe({ error: 'http-status', httpStatus: 404 }));
    expect(d.fixes.map((f) => f.repair).filter(Boolean)).toEqual(['edit-url', 'remove']);
    const p = diagnose(server({ url: 'https://x.dev/mcp', transport: 'http' }, { scope: 'plugin', scopeLabel: 'stripe' }), probe({ error: 'http-status', httpStatus: 404 }));
    expect(p.fixes.some((f) => f.kind === 'repair' || f.kind === 'reveal')).toBe(false);
  });
});

describe('findRunner', () => {
  const fake = (existing: string[]) => (async (url: string) => {
    const hit = existing.some((e) => url.includes(e));
    return { ok: hit, status: hit ? 200 : 404, json: async () => ({}), text: async () => '' };
  });
  it('prefers official npm packages, then PyPI', async () => {
    expect(await findRunner('mcp-server-postgres', fake(['%40modelcontextprotocol%2Fserver-postgres', '@modelcontextprotocol%2Fserver-postgres']))).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] });
    expect(await findRunner('mcp-server-fetch', fake(['pypi.org/pypi/mcp-server-fetch']))).toEqual({ command: 'uvx', args: ['mcp-server-fetch'] });
    expect(await findRunner('nothing-here', fake([]))).toBeNull();
  });
});

describe('writing repairs back', () => {
  it('JSON: only the changed fields move, the rest stays', () => {
    const src = '{\n  // keep\n  "mcpServers": {\n    "ctx": { "command": "npx @context/mcp-server", "disabled": false },\n    "other": { "url": "https://a" }\n  }\n}\n';
    const out = patchJsonServer(src, 'ctx', raw({ command: 'npx', args: ['@context/mcp-server'] }));
    expect(out).toContain('// keep');
    expect(out).toContain('"disabled": false');
    expect(out).toMatch(/"args": \[\s*"@context\/mcp-server"\s*\]/);
    expect(patchJsonServer(src, 'ctx', null)).not.toContain('"ctx"');
    expect(() => patchJsonServer(src, 'missing', null)).toThrow();
  });
  it('TOML: keeps sub-tables and other servers', () => {
    const src = 'model = "x"\n\n[mcp_servers.pg]\ncommand = "mcp-server-postgres"\nargs = ["postgres://x"]\nstartup_timeout_sec = 30\n\n[mcp_servers.pg.tools.query]\napproval = "auto"\n\n[mcp_servers.keep]\ncommand = "y"\n';
    const out = patchTomlServer(src, 'pg', raw({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://x'] }));
    const doc = parseToml(out) as any;
    expect(doc.mcp_servers.pg).toMatchObject({ command: 'npx', startup_timeout_sec: 30, tools: { query: { approval: 'auto' } } });
    expect(doc.mcp_servers.keep.command).toBe('y');
    expect(doc.model).toBe('x');
    const removed = parseToml(patchTomlServer(src, 'pg', null)) as any;
    expect(removed.mcp_servers.pg).toBeUndefined();
    expect(removed.mcp_servers.keep.command).toBe('y');
  });
  it('Claude Code goes through its CLI with the right scope and cwd', () => {
    const s = server({ command: 'npx @context/mcp-server' }, { client: 'claude-code', scope: 'project', configPath: '/Users/me/.claude.json', projectDir: '/Users/me/app', scopeLabel: 'app' });
    const w = planRepairWrite(s, raw({ command: 'npx', args: ['@context/mcp-server'] }), null, s.raw);
    expect(w).toMatchObject({ kind: 'cli', cwd: '/Users/me/app' });
    expect(w.kind === 'cli' && w.steps.map((x) => x.slice(0, 2).concat(x.slice(-2)))).toEqual([
      ['mcp', 'remove', '-s', 'local'],
      ['mcp', 'add-json', '-s', 'local'],
    ]);
  });
});

describe('i18n', () => {
  afterEach(() => setLocale('zh'));
  it('picks the system language', () => {
    expect(pickLocale(['zh-CN', 'en-US'])).toBe('zh');
    expect(pickLocale(['zh-Hant-TW'])).toBe('zh');
    expect(pickLocale(['en-GB'])).toBe('en');
    expect(pickLocale(['ja-JP'])).toBe('en');
  });
  it('translates core text', () => {
    setLocale('en');
    expect(t('diag.missingKey')).toBe('Key not filled in');
    expect(CLIENTS.find((c) => c.id === 'claude-desktop')!.name).toBe('Claude Desktop');
    expect(precheck(server({ command: 'npx @context/mcp-server' }))!.title).toBe('Command and arguments are stuck together');
    setLocale('zh');
    expect(CLIENTS.find((c) => c.id === 'claude-desktop')!.name).toBe('Claude 桌面版');
  });
});

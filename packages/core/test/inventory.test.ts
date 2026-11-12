import { describe, expect, it } from 'vitest';
import { loadInventory, type DirEntry, type InventoryIO, type InstalledServer } from '../src/inventory';
import { diagnose, precheck, type ProbeResult } from '../src/diagnose';
import { displayConfig, displayRaw, maskValue } from '../src/mask';

const H = '/Users/me';

function fakeIO(files: Record<string, string>, dirs: Record<string, DirEntry[]> = {}): InventoryIO {
  return {
    home: H,
    readTexts: async (paths) => paths.map((p) => files[p] ?? null),
    listDir: async (p) => dirs[p] ?? [],
  };
}

const skill = (name: string, desc = 'does things') => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`;
const dir = (name: string, extra: Partial<DirEntry> = {}): DirEntry => ({ name, isDir: true, isSymlink: false, ...extra });

const FILES: Record<string, string> = {
  [`${H}/.claude.json`]: JSON.stringify({
    mcpServers: { playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: {} } },
    projects: {
      [`${H}/work/shop`]: { mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz123456' } } }, disabledMcpServers: [] },
      [`${H}/work/blog`]: {},
    },
  }),
  [`${H}/work/blog/.mcp.json`]: JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } } }),
  [`${H}/.claude/settings.json`]: JSON.stringify({ enabledPlugins: { 'stripe@official': true, 'off@official': false } }),
  [`${H}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
    version: 2,
    plugins: {
      'stripe@official': [{ scope: 'user', installPath: `${H}/.claude/plugins/cache/official/stripe/1.0.0`, version: '1.0.0' }],
      'off@official': [{ scope: 'user', installPath: `${H}/.claude/plugins/cache/official/off/0.1.0`, version: '0.1.0' }],
    },
  }),
  [`${H}/.claude/plugins/cache/official/stripe/1.0.0/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'stripe', description: 'Stripe tools' }),
  [`${H}/.claude/plugins/cache/official/stripe/1.0.0/.mcp.json`]: JSON.stringify({ mcpServers: { stripe: { type: 'http', url: 'https://mcp.stripe.com' } } }),
  [`${H}/.claude/plugins/cache/official/off/0.1.0/.mcp.json`]: JSON.stringify({
    local: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server', args: [] },
  }),
  // Claude Desktop config with a trailing comma (strict JSON parsers reject it)
  [`${H}/Library/Application Support/Claude/claude_desktop_config.json`]: '{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }, } }',
  [`${H}/.cursor/mcp.json`]: JSON.stringify({
    mcpServers: {
      playwright: { command: 'npx', args: ['@playwright/mcp@0.0.40'] },
      firecrawl: { command: 'npx', args: ['-y', 'firecrawl-mcp'], env: { FIRECRAWL_API_KEY: 'YOUR-API-KEY' } },
    },
  }),
  [`${H}/.codex/config.toml`]: '[mcp_servers.fetch]\ncommand = "uvx"\nargs = ["mcp-server-fetch"]\nenabled = false\n',
  // skills
  [`${H}/.claude/skills/pdf/SKILL.md`]: skill('pdf'),
  [`${H}/.agents/skills/find-skills/SKILL.md`]: skill('find-skills'),
  [`${H}/.claude/skills/find-skills/SKILL.md`]: skill('find-skills'),
  [`${H}/.codex/skills/pdf/SKILL.md`]: skill('pdf', 'an older copy'),
  [`${H}/.claude/skills/synced/bucket-1/morning/SKILL.md`]: skill('morning'),
  [`${H}/.claude/plugins/cache/official/stripe/1.0.0/skills/stripe-docs/SKILL.md`]: skill('stripe-docs'),
};

const DIRS: Record<string, DirEntry[]> = {
  [`${H}/.claude/skills`]: [dir('pdf'), dir('find-skills', { isSymlink: true, target: `${H}/.agents/skills/find-skills` }), dir('synced'), { name: '.DS_Store', isDir: false, isSymlink: false }],
  [`${H}/.claude/skills/synced`]: [dir('bucket-1'), dir('.bucket-1')],
  [`${H}/.claude/skills/synced/bucket-1`]: [dir('morning')],
  [`${H}/.agents/skills`]: [dir('find-skills')],
  [`${H}/.codex/skills`]: [dir('pdf')],
  [`${H}/.claude/plugins/cache/official/stripe/1.0.0/skills`]: [dir('stripe-docs')],
  [`${H}/.claude/plugins/cache/official/stripe/1.0.0`]: [dir('skills'), dir('hooks')],
};

describe('loadInventory', async () => {
  const inv = await loadInventory(fakeIO(FILES, DIRS));
  const byKey = (k: string) => inv.servers.find((s) => s.key === k)!;

  it('reads servers from every client and scope', () => {
    expect(inv.servers.map((s) => `${s.client}:${s.scope}:${s.name}`).sort()).toEqual(
      [
        'claude-code:plugin:local',
        'claude-code:plugin:stripe',
        'claude-code:project:context7',
        'claude-code:project:github',
        'claude-code:user:playwright',
        'claude-desktop:user:playwright',
        'codex:user:fetch',
        'cursor:user:firecrawl',
        'cursor:user:playwright',
      ].sort(),
    );
  });

  it('marks disabled servers and plugin servers of disabled plugins', () => {
    expect(byKey('codex|user||fetch').disabled).toBe(true);
    expect(byKey('claude-code|plugin|off|local').disabled).toBe(true);
    expect(byKey('claude-code|plugin|stripe|stripe').disabled).toBe(false);
  });

  it('substitutes CLAUDE_PLUGIN_ROOT', () => {
    expect(byKey('claude-code|plugin|off|local').raw.command).toBe(`${H}/.claude/plugins/cache/official/off/0.1.0/bin/server`);
  });

  it('groups the same server across apps and flags differences', () => {
    const pw = inv.serverGroups.find((g) => g.id === 'playwright')!;
    expect(pw.items.map((i) => i.client).sort()).toEqual(['claude-code', 'claude-desktop', 'cursor']);
    expect(pw.consistent).toBe(false); // cursor pins an older version
  });

  it('reports config files, including a strict-JSON problem', () => {
    const desktop = inv.configFiles.find((f) => f.client === 'claude-desktop')!;
    expect(desktop.error).toContain('多余的逗号');
    expect(desktop.servers).toBe(1);
    expect(inv.configFiles.find((f) => f.client === 'gemini')).toMatchObject({ exists: false });
  });

  it('reads plugins with counts and enabled state', () => {
    const stripe = inv.plugins.find((p) => p.name === 'stripe')!;
    expect(stripe).toMatchObject({ enabled: true, marketplace: 'official', version: '1.0.0', description: 'Stripe tools' });
    expect(stripe.counts).toMatchObject({ skills: 1, mcp: 1, hooks: true });
    expect(inv.plugins.find((p) => p.name === 'off')!.enabled).toBe(false);
  });

  it('reads skills from all folders, links and copies', () => {
    expect(inv.skills.map((s) => `${s.location}:${s.name}`).sort()).toEqual(
      ['agents:find-skills', 'claude:find-skills', 'claude:pdf', 'codex:pdf', 'plugin:stripe-docs', 'synced:morning'].sort(),
    );
    const find = inv.skillGroups.find((g) => g.name === 'find-skills')!;
    expect(find.differs).toBe(false); // one is a link to the other
    expect(find.items.find((i) => i.location === 'claude')!.isSymlink).toBe(true);
    expect(inv.skillGroups.find((g) => g.name === 'pdf')!.differs).toBe(true);
    expect(inv.skills.find((s) => s.location === 'synced')!.removable).toBe(false);
  });
});

describe('precheck / diagnose', () => {
  const server = (raw: Partial<InstalledServer['raw']>, extra: Partial<InstalledServer> = {}): InstalledServer => ({
    key: 'k',
    name: 'x',
    client: 'cursor',
    scope: 'user',
    configPath: '/Users/me/.cursor/mcp.json',
    disabled: false,
    raw: { args: [], env: {}, headers: {}, ...raw },
    spec: null,
    ...extra,
  });
  const probe = (p: Partial<ProbeResult>): ProbeResult => ({
    ok: false,
    stderr: '',
    stdoutNoise: [],
    tools: [],
    authHeader: false,
    unresolvedVars: [],
    elapsedMs: 1200,
    ...p,
  });

  it('flags placeholder keys before running', () => {
    const d = precheck(server({ command: 'npx', env: { FIRECRAWL_API_KEY: 'YOUR-API-KEY' } }));
    expect(d).toMatchObject({ status: 'error', title: '密钥还没填' });
    expect(precheck(server({ command: 'npx', env: { TOKEN: '${GITHUB_TOKEN}' } }))).toBeNull();
    expect(precheck(server({ command: 'npx' }, { disabled: true }))).toMatchObject({ status: 'skipped' });
  });

  it('explains common failures in plain language', () => {
    const npx = server({ command: 'npx', args: ['-y', 'nope-mcp'] });
    expect(diagnose(npx, probe({ error: 'not-found' }))).toMatchObject({ title: '没找到 Node.js', fixes: [{ kind: 'repair', repair: 'install-node', primary: true }, { kind: 'retry' }] });
    expect(diagnose(npx, probe({ error: 'exited', stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/nope-mcp' })).title).toBe('找不到这个软件包');
    expect(diagnose(npx, probe({ error: 'exited', stderr: 'Error: FIRECRAWL_API_KEY environment variable is required' })).title).toBe('密钥缺失或不正确');
    expect(diagnose(npx, probe({ error: 'timeout' })).detail).toContain('第一次使用要先下载');
    expect(diagnose(npx, probe({ error: 'timeout', stdoutNoise: ['Server starting...'] })).title).toBe('服务输出了多余内容');
    expect(diagnose(server({ command: 'docker', args: ['run', 'x'] }), probe({ error: 'exited', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' })).title).toBe('Docker 没有打开');
  });

  it('remote: login needed vs bad token', () => {
    const plain = server({ url: 'https://mcp.stripe.com', transport: 'http' });
    expect(diagnose(plain, probe({ error: 'http-status', httpStatus: 401, authHeader: true }))).toMatchObject({ status: 'auth', title: '需要登录' });
    const withToken = server({ url: 'https://x.dev/mcp', transport: 'http', headers: { Authorization: 'Bearer abc' } });
    expect(diagnose(withToken, probe({ error: 'http-status', httpStatus: 401 }))).toMatchObject({ status: 'error', title: '密钥不对或已过期' });
  });

  it('ok', () => {
    const d = diagnose(server({ command: 'npx' }), probe({ ok: true, tools: ['a', 'b'], serverName: 'pw', serverVersion: '1.0' }));
    expect(d).toMatchObject({ status: 'ok', detail: '2 个工具 · 用时 1.2 秒 · pw 1.0' });
  });
});

describe('mask', () => {
  it('hides secrets but keeps a hint', () => {
    expect(maskValue('ghp_abcdefghijklmnopqrstuvwxyz123456', 'Authorization')).toBe('ghp_••••56');
    expect(maskValue('Bearer sk-1234567890abcdefghijkl')).toBe('Bearer sk-1••••kl');
    expect(maskValue('true', 'DEBUG')).toBe('true');
    expect(displayRaw({ command: 'npx', args: ['-y', 'x', '--api-key', 'abcd1234efgh5678'], env: {}, headers: {} })).toBe('npx -y x --api-key abcd••••78');
    expect(displayRaw({ url: 'https://mcp.firecrawl.dev/fc-0123456789abcdef0123456789/v2/mcp', args: [], env: {}, headers: {} })).toBe(
      'https://mcp.firecrawl.dev/fc-0••••89/v2/mcp',
    );
    expect(displayConfig({ command: 'npx', args: [], env: { API_KEY: 'secretsecretsecret' }, headers: {} })).toContain('secr••••et');
  });
});

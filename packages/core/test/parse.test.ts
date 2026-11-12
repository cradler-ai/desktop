import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parse/command';
import { splitCommands, tokenize } from '../src/parse/shell';
import { entryToSpec, findServers, parseConfigText } from '../src/parse/config';
import { findDeeplinks } from '../src/parse/deeplink';
import { scanMarkdown } from '../src/parse/markdown';
import { parseGitHubInput } from '../src/github';
import { inferNameFromPackage } from '../src/util/names';
import { isPlaceholder, isPathPlaceholder } from '../src/util/placeholder';
import { detect } from '../src/detect/index';

const cmd = (s: string) => parseCommand(splitCommands(s)[0]);

describe('shell', () => {
  it('tokenizes quotes and continuations', () => {
    expect(tokenize(`claude mcp add x -H "Authorization: Bearer abc" -- npx 'a b'`)).toEqual([
      'claude', 'mcp', 'add', 'x', '-H', 'Authorization: Bearer abc', '--', 'npx', 'a b',
    ]);
    expect(splitCommands('$ npx -y \\\n  @playwright/mcp@latest && echo ok')).toEqual([
      ['npx', '-y', '@playwright/mcp@latest'],
      ['echo', 'ok'],
    ]);
  });
});

describe('commands', () => {
  it('claude mcp add (http)', () => {
    const c = cmd('claude mcp add --transport http sentry https://mcp.sentry.dev/mcp');
    expect(c).toMatchObject({ type: 'mcp', name: 'sentry', spec: { kind: 'mcp-remote', url: 'https://mcp.sentry.dev/mcp', transport: 'http' } });
  });

  it('claude mcp add (stdio, env, --)', () => {
    const c = cmd('claude mcp add my-server -e API_KEY=YOUR_KEY -- npx -y some-mcp --flag');
    expect(c).toMatchObject({ type: 'mcp', name: 'my-server', spec: { kind: 'mcp-local', command: 'npx', args: ['-y', 'some-mcp', '--flag'], packageRef: 'npm:some-mcp' } });
    if (c?.type === 'mcp' && c.spec.kind === 'mcp-local') expect(c.spec.inputs.map((i) => i.key)).toEqual(['API_KEY']);
  });

  it('claude mcp add with header placeholder', () => {
    const c = cmd('claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: YOUR_API_KEY"');
    expect(c?.type === 'mcp' && c.spec.kind === 'mcp-remote' && c.spec.inputs[0]).toMatchObject({ key: 'CONTEXT7_API_KEY', target: 'header', secret: true });
  });

  it('codex mcp add', () => {
    const c = cmd('codex mcp add fetch --env A=1 -- uvx mcp-server-fetch');
    expect(c).toMatchObject({ type: 'mcp', name: 'fetch', spec: { kind: 'mcp-local', runtime: 'python', packageRef: 'pypi:mcp-server-fetch', env: { A: '1' } } });
  });

  it('bare npx / uvx / docker', () => {
    expect(cmd('npx -y @playwright/mcp@latest')).toMatchObject({ spec: { packageRef: 'npm:@playwright/mcp', runtime: 'node' } });
    expect(cmd('uvx --from git+https://github.com/oraios/serena serena start-mcp-server')).toMatchObject({
      spec: { runtime: 'python', packageRef: 'git:https://github.com/oraios/serena' },
    });
    expect(cmd('docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server')).toMatchObject({
      spec: { runtime: 'docker', packageRef: 'docker:ghcr.io/github/github-mcp-server' },
    });
  });

  it('mcp-remote bridge becomes a remote server', () => {
    expect(cmd('npx -y mcp-remote https://mcp.example.com/sse')).toMatchObject({ spec: { kind: 'mcp-remote', transport: 'sse' } });
  });

  it('skills and plugins', () => {
    expect(cmd('npx skills add vercel-labs/agent-skills --skill frontend-design')).toEqual({
      type: 'skills-add', source: 'vercel-labs/agent-skills', skills: ['frontend-design'],
    });
    expect(cmd('/plugin marketplace add obra/superpowers-marketplace')).toEqual({ type: 'marketplace-add', source: 'obra/superpowers-marketplace' });
    expect(cmd('/plugin install superpowers@superpowers-marketplace')).toEqual({
      type: 'plugin-install', plugin: 'superpowers', marketplace: 'superpowers-marketplace',
    });
  });

  it('strict mode ignores unrelated commands', () => {
    expect(parseCommand(['npx', 'create-react-app', 'x'], { strict: true })).toBeNull();
    expect(parseCommand(['npm', 'run', 'build'], { strict: true })).toBeNull();
  });
});

describe('configs', () => {
  it('claude desktop json with placeholder env', () => {
    const obj = parseConfigText(`{
      // comment
      "mcpServers": {
        "firecrawl": { "command": "npx", "args": ["-y", "firecrawl-mcp"], "env": { "FIRECRAWL_API_KEY": "YOUR-API-KEY" } },
      }
    }`);
    const [s] = findServers(obj);
    expect(s.name).toBe('firecrawl');
    const spec = entryToSpec(s.entry);
    expect(spec).toMatchObject({ kind: 'mcp-local', packageRef: 'npm:firecrawl-mcp', env: {} });
    expect(spec && 'inputs' in spec && spec.inputs[0]).toMatchObject({ key: 'FIRECRAWL_API_KEY', secret: true });
  });

  it('fragment without outer braces', () => {
    const [s] = findServers(parseConfigText(`"playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }`));
    expect(s.name).toBe('playwright');
  });

  it('vscode servers + http with input var', () => {
    const [s] = findServers(parseConfigText(`{ "servers": { "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer \${input:github_mcp_pat}" } } } }`));
    const spec = entryToSpec(s.entry);
    expect(spec).toMatchObject({ kind: 'mcp-remote', transport: 'http', headers: {} });
    expect(spec && 'inputs' in spec && spec.inputs[0]).toMatchObject({ key: 'Authorization', template: 'Bearer {value}' });
  });

  it('codex toml', () => {
    const [s] = findServers(parseConfigText(`[mcp_servers.fetch]\ncommand = "uvx"\nargs = ["mcp-server-fetch"]\n`));
    expect(s.name).toBe('fetch');
    expect(entryToSpec(s.entry)).toMatchObject({ packageRef: 'pypi:mcp-server-fetch' });
  });

  it('opencode command array', () => {
    const [s] = findServers(parseConfigText(`{ "mcp": { "pw": { "type": "local", "command": ["npx", "@playwright/mcp"] } } }`));
    expect(entryToSpec(s.entry)).toMatchObject({ command: 'npx', args: ['@playwright/mcp'] });
  });

  it('path placeholders become folder inputs', () => {
    const spec = entryToSpec({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/username/Desktop', '/path/to/other/allowed/dir'] });
    expect(spec && 'inputs' in spec && spec.inputs.map((i) => i.kind)).toEqual(['path', 'path']);
  });
});

describe('deeplinks', () => {
  it('cursor install link', () => {
    const config = btoa(JSON.stringify({ command: 'npx', args: ['@playwright/mcp@latest'] }));
    const md = `[![Install](badge.svg)](https://cursor.com/en/install-mcp?name=Playwright&amp;config=${config})`;
    const [d] = findDeeplinks(md);
    expect(d).toMatchObject({ name: 'Playwright', client: 'cursor', entry: { command: 'npx' } });
  });

  it('vscode redirect link', () => {
    const cfg = encodeURIComponent(JSON.stringify({ command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] }));
    const [d] = findDeeplinks(`https://insiders.vscode.dev/redirect/mcp/install?name=chrome-devtools&config=${cfg}`);
    expect(d).toMatchObject({ name: 'chrome-devtools', client: 'vscode' });
  });
});

describe('markdown', () => {
  it('finds configs and commands in a README', () => {
    const md = [
      '## Install',
      '```json',
      '{ "mcpServers": { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } } }',
      '```',
      '',
      '```bash',
      'claude mcp add --transport http context7 https://mcp.context7.com/mcp',
      'npm run build',
      '```',
      'Or run `uvx mcp-server-fetch` directly.',
    ].join('\n');
    const f = scanMarkdown(md);
    expect(f.servers.map((s) => s.name)).toEqual(['context7']);
    expect(f.commands.map((c) => c.type)).toEqual(['mcp', 'mcp']);
  });
});

describe('github input', () => {
  it('parses url variants', () => {
    expect(parseGitHubInput('https://github.com/microsoft/playwright-mcp')).toEqual({ owner: 'microsoft', repo: 'playwright-mcp' });
    expect(parseGitHubInput('https://github.com/anthropics/skills/tree/main/skills/pdf')).toMatchObject({ ref: 'main', subpath: 'skills/pdf' });
    expect(parseGitHubInput('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md')).toMatchObject({ subpath: 'skills/pdf' });
    expect(parseGitHubInput('git@github.com:upstash/context7.git')).toEqual({ owner: 'upstash', repo: 'context7' });
    expect(parseGitHubInput('upstash/context7')).toEqual({ owner: 'upstash', repo: 'context7' });
    expect(parseGitHubInput('@playwright/mcp')).toBeNull();
  });
});

describe('names & placeholders', () => {
  it('infers friendly names', () => {
    expect(inferNameFromPackage('npm:@playwright/mcp')).toBe('playwright');
    expect(inferNameFromPackage('npm:@upstash/context7-mcp')).toBe('context7');
    expect(inferNameFromPackage('pypi:mcp-server-fetch')).toBe('fetch');
    expect(inferNameFromPackage('npm:@sentry/mcp-server')).toBe('sentry');
    expect(inferNameFromPackage('docker:ghcr.io/github/github-mcp-server')).toBe('github');
  });
  it('detects placeholders', () => {
    for (const v of ['', '<YOUR_TOKEN>', 'YOUR_API_KEY', 'your-api-key', '${input:x}', 'sk-...', 'xxxx', 'api_key_here']) expect(isPlaceholder(v), v).toBe(true);
    for (const v of ['1', 'true', 'https://mcp.sentry.dev/mcp', '@playwright/mcp@latest', 'stdio']) expect(isPlaceholder(v), v).toBe(false);
    expect(isPathPlaceholder('/Users/username/Desktop')).toBe(true);
    expect(isPathPlaceholder('/tmp')).toBe(false);
  });
});

describe('detect() without network', () => {
  const offline = async () => ({ ok: false, status: 599, json: async () => ({}), text: async () => '' });

  it('pasted JSON config', async () => {
    const r = await detect('{"mcpServers":{"pw":{"command":"npx","args":["@playwright/mcp@latest"]}}}', { fetch: offline });
    expect(r.inputKind).toBe('config');
    expect(r.groups[0].primary).toMatchObject({ name: 'pw', spec: { kind: 'mcp-local' } });
  });

  it('pasted remote URL', async () => {
    const r = await detect('https://mcp.sentry.dev/mcp', { fetch: offline });
    expect(r.inputKind).toBe('url');
    expect(r.groups[0].primary).toMatchObject({ name: 'sentry', spec: { kind: 'mcp-remote' } });
  });

  it('pasted command with global install', async () => {
    const r = await detect('npm install -g firecrawl-mcp', { fetch: offline });
    expect(r.groups[0].primary.spec).toMatchObject({ command: 'npx', args: ['-y', 'firecrawl-mcp'] });
  });

  it('nonsense', async () => {
    const r = await detect('hello world', { fetch: offline });
    expect(r.groups).toHaveLength(0);
    expect(r.notes[0]).toContain('没认出来');
  });
});

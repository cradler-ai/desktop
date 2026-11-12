// Runs detection against real GitHub repos and prints a compact report.
// Usage: GITHUB_TOKEN=$(gh auth token) pnpm eval:repos [owner/repo ...]
import { detect, previewText, kindLabel, type CandidateGroup } from '../src/index';

const DEFAULT_REPOS = [
  // local MCP (npm)
  'microsoft/playwright-mcp',
  'upstash/context7',
  'ChromeDevTools/chrome-devtools-mcp',
  'GLips/Figma-Context-MCP',
  'firecrawl/firecrawl-mcp-server',
  'makenotion/notion-mcp-server',
  'supabase-community/supabase-mcp',
  // remote + docker
  'github/github-mcp-server',
  'getsentry/sentry-mcp',
  // python
  'oraios/serena',
  'blazickjp/arxiv-mcp-server',
  // monorepos
  'modelcontextprotocol/servers',
  'awslabs/mcp',
  // skills / plugins
  'anthropics/skills',
  'obra/superpowers',
  'wshobson/agents',
  'anthropics/claude-plugins-official',
  // things that are NOT installable servers
  'jlowin/fastmcp',
  'modelcontextprotocol/inspector',
  'facebook/react',
  // inputs that are not repos
  'https://github.com/anthropics/skills/tree/main/skills/pdf',
  'claude mcp add --transport http sentry https://mcp.sentry.dev/mcp',
  'npx skills add anthropics/skills --skill pdf',
];

const repos = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_REPOS;
const token = process.env.GITHUB_TOKEN;

function line(g: CandidateGroup): string {
  const c = g.primary;
  const inputs = 'inputs' in c.spec ? c.spec.inputs.map((i) => `${i.key}${i.secret ? '🔑' : ''}`) : [];
  const alts = g.alternatives.map((a) => kindLabel(a.spec) + (a.spec.kind === 'mcp-local' ? `/${a.spec.runtime}` : ''));
  return [
    `  · ${c.name.padEnd(22)} ${kindLabel(c.spec).padEnd(4)} ${c.confidence.padEnd(6)}`,
    previewText(c.spec).slice(0, 90),
    inputs.length ? `需填:[${inputs.join(',')}]` : '',
    alts.length ? `备选:${alts.join(',')}` : '',
    c.warnings.length ? `⚠ ${c.warnings.join('；')}` : '',
  ]
    .filter(Boolean)
    .join('  ');
}

for (const r of repos) {
  const t0 = Date.now();
  const res = await detect(r, { githubToken: token });
  const ms = Date.now() - t0;
  console.log(`\n== ${r}  [${res.inputKind}, ${res.groups.length} 项, ${ms}ms]`);
  const shown = res.groups.slice(0, 12);
  for (const g of shown) console.log(line(g));
  if (res.groups.length > shown.length) console.log(`  … 还有 ${res.groups.length - shown.length} 项`);
  for (const n of res.notes) console.log(`  ℹ ${n}`);
}

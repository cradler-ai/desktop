// Turns a raw probe result into something an ordinary person can act on — including a repair
// the app can carry out (see repair.ts), not just an explanation.
import type { InstalledServer, RawServerConfig } from './inventory';
import { clientLabel } from './targets';
import { commandBase, analyzeCommand } from './util/command';
import { isPlaceholder, looksSecret } from './util/placeholder';
import { t } from './i18n';

/** What the Rust side returns for one connection attempt. */
export interface ProbeResult {
  ok: boolean;
  error?: 'not-found' | 'spawn-failed' | 'exited' | 'timeout' | 'init-error' | 'http-status' | 'network' | 'invalid-response' | null;
  message?: string | null;
  exitCode?: number | null;
  stderr: string;
  stdoutNoise: string[];
  serverName?: string | null;
  serverVersion?: string | null;
  tools: string[];
  httpStatus?: number | null;
  authHeader: boolean;
  unresolvedVars: string[];
  elapsedMs: number;
  resolvedCommand?: string | null;
}

export type HealthStatus = 'ok' | 'error' | 'auth' | 'skipped';

export type RepairKind = 'split-command' | 'use-runner' | 'set-values' | 'edit-url' | 'install-node' | 'install-uv' | 'remove';

/** A value the user types in during a repair (an API key, a token...). */
export interface RepairField {
  key: string;
  target: 'env' | 'header' | 'arg';
  argIndex?: number;
  secret: boolean;
  /** e.g. "Bearer {value}" or "--api-key={value}" */
  template?: string;
}

export interface Fix {
  label: string;
  kind: 'open-url' | 'reveal' | 'retry' | 'repair';
  value?: string;
  repair?: RepairKind;
  fields?: RepairField[];
  /** The main suggested action. */
  primary?: boolean;
}

export interface Diagnosis {
  status: HealthStatus;
  title: string;
  detail?: string;
  fixes: Fix[];
  /** Raw output for "show raw error" */
  raw?: string;
  tools?: string[];
  elapsedMs?: number;
}

const URLS = {
  node: 'https://nodejs.org/download',
  docker: 'https://www.docker.com/products/docker-desktop/',
  python: 'https://www.python.org/downloads/',
};

const RUNNERS = ['npx', 'pnpx', 'bunx', 'uvx', 'pnpm', 'docker', 'pipx', 'uv'];

export function probeTimeoutMs(raw: RawServerConfig): number {
  if (raw.url) return 15000;
  // first run of npx / uvx / docker may download the package
  return RUNNERS.includes(commandBase(raw.command ?? '')) ? 90000 : 30000;
}

// ---- fix builders -----------------------------------------------------------------

const repair = (kind: RepairKind, extra: Partial<Fix> = {}): Fix => ({ label: t(`repair.${kind}`), kind: 'repair', repair: kind, ...extra });
const retry = (): Fix => ({ label: t('fix.retry'), kind: 'retry' });
const reveal = (s: InstalledServer): Fix[] => (s.configPath ? [{ label: t('fix.reveal'), kind: 'reveal', value: s.configPath }] : []);
const link = (key: string, url: string): Fix => ({ label: t(key), kind: 'open-url', value: url });

/** The command and its arguments were written as one string: "npx -y foo". */
export function isJoinedCommand(raw: RawServerConfig): boolean {
  const cmd = (raw.command ?? '').trim();
  if (!cmd || raw.args.length || !/\s/.test(cmd)) return false;
  const first = cmd.split(/\s+/)[0];
  return !first.includes('/'); // "/Applications/My App.app/..." is a path with spaces, not a joined command
}

/** Problems we can spot without starting anything. */
export function precheck(s: InstalledServer): Diagnosis | null {
  if (s.disabled) {
    return s.scope === 'plugin'
      ? { status: 'skipped', title: t('diag.disabledPlugin'), detail: t('diag.disabledPluginDetail', { plugin: s.scopeLabel }), fixes: [] }
      : { status: 'skipped', title: t('diag.disabled'), detail: t('diag.disabledDetail', { app: clientLabel(s.client) }), fixes: [] };
  }
  if (!s.raw.command && !s.raw.url) {
    return finish(s, { status: 'error', title: t('diag.incomplete'), detail: t('diag.incompleteDetail'), fixes: [...reveal(s), repair('remove')] });
  }
  if (isJoinedCommand(s.raw)) {
    return finish(s, {
      status: 'error',
      title: t('diag.joined'),
      detail: t('diag.joinedDetail', { cmd: s.raw.command }),
      fixes: [repair('split-command', { primary: true }), ...reveal(s), repair('remove')],
    });
  }

  const fields: RepairField[] = [];
  s.raw.args.forEach((a, i) => {
    const eq = /^(--?[\w-]+)=(.*)$/.exec(a);
    const value = eq ? eq[2] : a;
    if (value && !value.startsWith('${') && !value.startsWith('-') && /YOUR[_-]|your[-_](api|key|token)|<[^>\s]+>/.test(value)) {
      const prev = s.raw.args[i - 1];
      const key = eq ? eq[1].replace(/^-+/, '') : prev?.startsWith('-') ? prev.replace(/^-+/, '') : value;
      fields.push({ key, target: 'arg', argIndex: i, secret: looksSecret(key) || /key|token/i.test(value), template: eq ? `${eq[1]}={value}` : undefined });
    }
  });
  for (const [k, v] of Object.entries(s.raw.env)) {
    if (v.startsWith('${')) continue; // filled from the environment at run time
    if ((v === '' && looksSecret(k)) || (v !== '' && isPlaceholder(v))) fields.push({ key: k, target: 'env', secret: looksSecret(k) });
  }
  for (const [k, v] of Object.entries(s.raw.headers)) {
    const m = /^(Bearer|Token|Basic)\s+/i.exec(v);
    const token = m ? v.slice(m[0].length) : v;
    if (!token.startsWith('${') && isPlaceholder(token)) fields.push({ key: k, target: 'header', secret: true, template: m ? `${m[1]} {value}` : undefined });
  }
  if (fields.length) {
    return finish(s, {
      status: 'error',
      title: t('diag.missingKey'),
      detail: t('diag.missingKeyDetail', { keys: fields.map((f) => f.key).join(', ') }),
      fixes: [repair('set-values', { primary: true, fields }), ...reveal(s)],
    });
  }
  return null;
}

/** Secret-looking env vars and auth headers the user could re-enter. */
function secretFields(raw: RawServerConfig): RepairField[] {
  const out: RepairField[] = [];
  for (const k of Object.keys(raw.env)) if (looksSecret(k)) out.push({ key: k, target: 'env', secret: true });
  for (const [k, v] of Object.entries(raw.headers)) {
    if (!/authori|token|key/i.test(k)) continue;
    const m = /^(Bearer|Token|Basic)\s+/i.exec(v);
    out.push({ key: k, target: 'header', secret: true, template: m ? `${m[1]} {value}` : undefined });
  }
  return out;
}

/** Plugin servers are managed by their plugin; only machine-level fixes make sense there. */
function finish(s: InstalledServer, d: Diagnosis): Diagnosis {
  if (s.scope !== 'plugin' && s.scope !== 'extension') return d;
  return {
    ...d,
    fixes: d.fixes.filter((f) => f.kind === 'open-url' || f.kind === 'retry' || f.repair === 'install-node' || f.repair === 'install-uv'),
  };
}

export function diagnose(s: InstalledServer, r: ProbeResult): Diagnosis {
  const raw = s.raw;
  const out = (x: Omit<Diagnosis, 'raw' | 'elapsedMs'>): Diagnosis =>
    finish(s, {
      ...x,
      raw:
        [r.message, r.stderr, ...(r.stdoutNoise.length ? [t('diag.rawNoise'), ...r.stdoutNoise] : [])]
          .filter(Boolean)
          .join('\n')
          .trim() || undefined,
      elapsedMs: r.elapsedMs,
    });
  const secs = (r.elapsedMs / 1000).toFixed(1);

  if (r.ok) {
    const name = [r.serverName, r.serverVersion].filter(Boolean).join(' ');
    return out({
      status: 'ok',
      title: t('diag.ok'),
      detail: [r.tools.length ? t('diag.okDetail.tools', { n: r.tools.length }) : t('diag.okDetail.connected'), t('diag.okDetail.time', { s: secs }), name]
        .filter(Boolean)
        .join(' · '),
      fixes: [],
      tools: r.tools,
    });
  }

  const text = `${r.message ?? ''}\n${r.stderr}`.toLowerCase();
  const has = (...needles: (string | RegExp)[]) => needles.some((n) => (typeof n === 'string' ? text.includes(n) : n.test(text)));
  const unresolved = r.unresolvedVars.length ? t('diag.unresolved', { vars: r.unresolvedVars.join(', ') }) : '';
  const removeFix = repair('remove');

  // ---------- remote ----------
  if (raw.url) {
    const editUrl = repair('edit-url', { primary: true });
    if (r.error === 'http-status') {
      const code = r.httpStatus ?? 0;
      if (code === 401 || code === 403) {
        const fields = secretFields(raw);
        return fields.length
          ? out({
              status: 'error',
              title: t('diag.badToken'),
              detail: t('diag.badTokenDetail', { unresolved, code }),
              fixes: [repair('set-values', { primary: true, fields }), ...reveal(s), retry()],
            })
          : out({ status: 'auth', title: t('diag.login'), detail: t('diag.loginDetail', { app: clientLabel(s.client) }), fixes: [retry()] });
      }
      if (code === 404) return out({ status: 'error', title: t('diag.wrongUrl'), detail: t('diag.wrongUrlDetail'), fixes: [editUrl, removeFix, retry()] });
      if (code === 405 && raw.transport === 'http')
        return out({ status: 'error', title: t('diag.useSse'), detail: t('diag.useSseDetail'), fixes: [...reveal(s), editUrl, retry()] });
      if (code === 429) return out({ status: 'error', title: t('diag.rate'), detail: t('diag.rateDetail'), fixes: [retry()] });
      if (code >= 500) return out({ status: 'error', title: t('diag.server5xx'), detail: t('diag.server5xxDetail', { code }), fixes: [retry()] });
      return out({ status: 'error', title: t('diag.httpOther', { code }), detail: t('diag.httpOtherDetail'), fixes: [editUrl, removeFix, retry()] });
    }
    if (r.error === 'network') {
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(raw.url)) {
        const port = /:(\d+)/.exec(raw.url.replace(/^https?:\/\//, ''))?.[1];
        return out({
          status: 'error',
          title: t('diag.localDown'),
          detail: t('diag.localDownDetail', { port: port ? t('diag.port', { port }) : '' }),
          fixes: [retry(), removeFix],
        });
      }
      if (has('dns', 'resolve', 'failed to lookup', 'nodename'))
        return out({ status: 'error', title: t('diag.dns'), detail: t('diag.dnsDetail'), fixes: [editUrl, removeFix, retry()] });
      if (has('certificate', 'tls', 'ssl')) return out({ status: 'error', title: t('diag.tls'), detail: t('diag.tlsDetail'), fixes: [retry()] });
      if (has('timed out', 'timeout')) return out({ status: 'error', title: t('diag.netTimeout'), detail: t('diag.netTimeoutDetail'), fixes: [retry()] });
      return out({ status: 'error', title: t('diag.net'), detail: t('diag.netDetail'), fixes: [retry()] });
    }
    const ct = /^not-event-stream\|(.*)$/.exec(r.message ?? '')?.[1];
    return out({
      status: 'error',
      title: t('diag.badReply'),
      detail: ct != null ? t('diag.notEventStream', { ct }) : t('diag.badReplyDetail'),
      fixes: [editUrl, removeFix, retry()],
    });
  }

  // ---------- local ----------
  const base = commandBase(raw.command ?? '');
  if (r.error === 'not-found') {
    if (['npx', 'node', 'npm'].includes(base))
      return out({ status: 'error', title: t('diag.noNode'), detail: t('diag.noNodeDetail'), fixes: [repair('install-node', { primary: true }), retry()] });
    if (['uvx', 'uv'].includes(base))
      return out({ status: 'error', title: t('diag.noUv'), detail: t('diag.noUvDetail'), fixes: [repair('install-uv', { primary: true }), retry()] });
    if (base === 'docker') return out({ status: 'error', title: t('diag.noDocker'), detail: t('diag.noDockerDetail'), fixes: [link('fix.downloadDocker', URLS.docker), retry()] });
    if (/^python/.test(base)) return out({ status: 'error', title: t('diag.noPython'), detail: t('diag.noPythonDetail'), fixes: [link('fix.downloadPython', URLS.python), retry()] });
    if (isJoinedCommand(raw))
      return out({ status: 'error', title: t('diag.joined'), detail: t('diag.joinedDetail', { cmd: raw.command }), fixes: [repair('split-command', { primary: true }), removeFix] });
    const isPath = (raw.command ?? '').includes('/');
    return out({
      status: 'error',
      title: t('diag.noProgram', { cmd: raw.command }),
      detail: isPath ? t('diag.noProgramPath') : t('diag.noProgramBare'),
      fixes: isPath ? [...reveal(s), removeFix, retry()] : [repair('use-runner', { primary: true }), removeFix, retry()],
    });
  }
  if (r.error === 'spawn-failed') {
    return out({
      status: 'error',
      title: has('permission denied', 'eacces') ? t('diag.noPermission') : t('diag.spawnFailed'),
      detail: r.message ?? t('diag.spawnFailedDetail'),
      fixes: [...reveal(s), removeFix, retry()],
    });
  }

  if (has('cannot connect to the docker daemon', 'is the docker daemon running', 'docker daemon'))
    return out({ status: 'error', title: t('diag.dockerOff'), detail: t('diag.dockerOffDetail'), fixes: [retry()] });
  if (has('e404', '404 not found', 'is not in this registry', 'no matching distribution', 'not found in the package registry', 'no solution found', /package .* not found/)) {
    const pkg = analyzeCommand(raw.command ?? '', raw.args).packageName;
    return out({
      status: 'error',
      title: t('diag.noPackage'),
      detail: t('diag.noPackageDetail', { pkg: pkg ? `${pkg} ` : '' }),
      fixes: [...(pkg ? [link('fix.searchNpm', `https://www.npmjs.com/search?q=${encodeURIComponent(pkg)}`)] : []), removeFix],
    });
  }
  if (has('unsupported engine', 'requires node', /node(\.js)? version/, 'err_require_esm', 'syntaxerror: unexpected token', 'requires-python', 'python version'))
    return out({ status: 'error', title: t('diag.oldRuntime'), detail: t('diag.oldRuntimeDetail'), fixes: [repair('install-node', { primary: true }), retry()] });
  if (has('eaddrinuse', 'address already in use')) return out({ status: 'error', title: t('diag.portBusy'), detail: t('diag.portBusyDetail'), fixes: [retry()] });
  if (has('enotfound', 'etimedout', 'econnrefused', 'getaddrinfo', 'network error', 'fetch failed', 'unable to get local issuer'))
    return out({ status: 'error', title: t('diag.download'), detail: t('diag.downloadDetail'), fixes: [retry()] });
  if (has(/api[_ -]?key/, 'token', 'unauthorized', '401', 'forbidden', 'credential', 'missing required environment', 'environment variable', 'not set')) {
    const fields = secretFields(raw);
    return out({
      status: 'error',
      title: t('diag.keyBad'),
      detail: t('diag.keyBadDetail', { unresolved }),
      fixes: fields.length ? [repair('set-values', { primary: true, fields }), ...reveal(s), retry()] : [...reveal(s), retry()],
    });
  }
  if (has('cannot find module', 'module_not_found', 'modulenotfounderror', 'no such file or directory', 'enoent'))
    return out({ status: 'error', title: t('diag.files'), detail: t('diag.filesDetail'), fixes: [...reveal(s), removeFix, retry()] });
  if (has('eacces', 'permission denied', 'operation not permitted')) return out({ status: 'error', title: t('diag.perm'), detail: t('diag.permDetail'), fixes: [retry()] });

  if (r.stdoutNoise.length && r.error !== 'exited') return out({ status: 'error', title: t('diag.noise'), detail: t('diag.noiseDetail'), fixes: [retry()] });

  if (r.error === 'timeout') {
    return out({
      status: 'error',
      title: t('diag.timeout'),
      detail: RUNNERS.includes(base) ? t('diag.timeoutDownload') : t('diag.timeoutWait'),
      fixes: [retry()],
    });
  }
  if (r.error === 'init-error') return out({ status: 'error', title: t('diag.refused'), detail: r.message ?? t('diag.refusedDetail'), fixes: [retry()] });

  return out({
    status: 'error',
    title: t('diag.exited'),
    detail: t('diag.exitedDetail', { unresolved, code: r.exitCode != null ? t('diag.exitCode', { code: r.exitCode }) : '' }),
    fixes: [...reveal(s), removeFix, retry()],
  });
}

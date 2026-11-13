import { useCallback, useRef, useState } from 'react';
import {
  cliServerName,
  diagnose,
  fingerprint,
  needsSignInCheck,
  precheck,
  probeTimeoutMs,
  type Diagnosis,
  type HealthStatus,
  type InstalledServer,
  type Inventory,
  type ProbeResult,
  t,
} from '@cradler-desktop/core';
import { appSignedIn, probeHttp, probeStdio, runCapture } from './native';

export interface EnvCheck {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'missing';
  version?: string;
  detail?: string;
  url?: string;
}

const RANK: Record<HealthStatus, number> = { error: 3, auth: 2, ok: 1, skipped: 0 };

export function worst(diags: (Diagnosis | undefined)[]): Diagnosis | undefined {
  return diags.filter((d): d is Diagnosis => !!d).sort((a, b) => RANK[b.status] - RANK[a.status])[0];
}

async function probe(s: InstalledServer): Promise<ProbeResult> {
  const timeoutMs = probeTimeoutMs(s.raw);
  if (s.raw.url) return probeHttp({ url: s.raw.url, headers: s.raw.headers, transport: s.raw.transport ?? 'http', timeoutMs });
  return probeStdio({ command: s.raw.command ?? '', args: s.raw.args, env: s.raw.env, cwd: s.raw.cwd, timeoutMs });
}

/** Diagnosis for one place; online servers that sign in with OAuth ask the app whether it is signed in. */
async function diagnoseServer(s: InstalledServer, r: ProbeResult): Promise<Diagnosis> {
  if (!needsSignInCheck(s, r)) return diagnose(s, r);
  const signedIn = await appSignedIn(s.client, cliServerName(s), s.projectDir).catch(() => null);
  return diagnose(s, r, { signedIn });
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const base = (cmd?: string) => (cmd ?? '').split('/').pop() ?? '';

async function checkEnv(inv: Inventory): Promise<EnvCheck[]> {
  const cmds = inv.servers.filter((s) => !s.disabled && s.raw.command).map((s) => base(s.raw.command));
  const checks: Promise<EnvCheck>[] = [
    runCapture('node', ['--version']).then((r) => {
      if (!r.found) return { id: 'node', name: 'Node.js', status: 'missing', detail: t('env.node.missing'), url: 'https://nodejs.org/download' };
      const v = r.stdout.replace(/^v/, '');
      const major = Number(v.split('.')[0]);
      return major && major < 18
        ? { id: 'node', name: 'Node.js', status: 'warn', version: v, detail: t('env.node.old'), url: 'https://nodejs.org/download' }
        : { id: 'node', name: 'Node.js', status: 'ok', version: v };
    }),
  ];
  if (cmds.some((c) => c === 'uvx' || c === 'uv')) {
    checks.push(
      runCapture('uv', ['--version']).then((r) =>
        r.found
          ? { id: 'uv', name: t('env.uv.name'), status: 'ok', version: r.stdout.split(' ')[1] }
          : { id: 'uv', name: t('env.uv.name'), status: 'missing', detail: t('env.uv.missing'), url: 'https://docs.astral.sh/uv/getting-started/installation/' },
      ),
    );
  }
  if (cmds.some((c) => c === 'docker')) {
    checks.push(
      runCapture('docker', ['info', '--format', '{{.ServerVersion}}'], 15000).then((r) =>
        !r.found
          ? { id: 'docker', name: 'Docker', status: 'missing', detail: t('env.docker.missing'), url: 'https://www.docker.com/products/docker-desktop/' }
          : r.code === 0
            ? { id: 'docker', name: 'Docker', status: 'ok', version: r.stdout }
            : { id: 'docker', name: 'Docker', status: 'warn', detail: t('env.docker.off') },
      ),
    );
  }
  if (cmds.some((c) => /^python/.test(c))) {
    checks.push(
      runCapture('python3', ['--version']).then((r) =>
        r.found
          ? { id: 'python', name: 'Python', status: 'ok', version: r.stdout.replace(/^Python\s*/, '') }
          : { id: 'python', name: 'Python', status: 'missing', url: 'https://www.python.org/downloads/' },
      ),
    );
  }
  return Promise.all(checks);
}

export interface HealthState {
  results: Record<string, Diagnosis>;
  running: boolean;
  checking: Set<string>;
  progress: { done: number; total: number; current: string };
  env: EnvCheck[] | null;
  lastRun: number | null;
  runAll: (inv: Inventory) => Promise<void>;
  runOne: (s: InstalledServer) => Promise<void>;
  /** Drop results for servers that no longer exist (removed by a repair). */
  forget: (keys: string[]) => void;
}

export function useHealth(): HealthState {
  const [results, setResults] = useState<Record<string, Diagnosis>>({});
  const [running, setRunning] = useState(false);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [env, setEnv] = useState<EnvCheck[] | null>(null);
  const [lastRun, setLastRun] = useState<number | null>(null);
  const busy = useRef(false);

  const runAll = useCallback(async (inv: Inventory) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setResults({});
    const envPromise = checkEnv(inv).catch(() => []);

    // Same config in several places is started once.
    const pending = new Map<string, InstalledServer[]>();
    const quick: Record<string, Diagnosis> = {};
    for (const s of inv.servers) {
      const pre = precheck(s);
      if (pre) quick[s.key] = pre;
      else {
        const fp = fingerprint(s.raw);
        pending.set(fp, [...(pending.get(fp) ?? []), s]);
      }
    }
    setResults({ ...quick });
    const groups = [...pending.values()];
    let done = 0;
    setProgress({ done: 0, total: groups.length, current: '' });
    await mapLimit(groups, 3, async (group) => {
      setProgress((p) => ({ ...p, current: group[0].name }));
      let r: ProbeResult;
      try {
        r = await probe(group[0]);
      } catch (e) {
        r = { ok: false, error: 'spawn-failed', message: String(e), stderr: '', stdoutNoise: [], tools: [], authHeader: false, unresolvedVars: [], elapsedMs: 0 };
      }
      const add: Record<string, Diagnosis> = {};
      for (const s of group) add[s.key] = await diagnoseServer(s, r);
      setResults((prev) => ({ ...prev, ...add }));
      done++;
      setProgress((p) => ({ ...p, done }));
    });
    setEnv(await envPromise);
    setLastRun(Date.now());
    setRunning(false);
    busy.current = false;
  }, []);

  const runOne = useCallback(async (s: InstalledServer) => {
    setChecking((prev) => new Set(prev).add(s.key));
    const pre = precheck(s);
    let d: Diagnosis;
    if (pre) d = pre;
    else {
      try {
        d = await diagnoseServer(s, await probe(s));
      } catch (e) {
        d = { status: 'error', title: t('health.checkFailed'), detail: String(e), fixes: [] };
      }
    }
    setResults((prev) => ({ ...prev, [s.key]: d }));
    setChecking((prev) => {
      const next = new Set(prev);
      next.delete(s.key);
      return next;
    });
  }, []);

  const forget = useCallback((keys: string[]) => {
    setResults((prev) => {
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }, []);

  return { results, running, checking, progress, env, lastRun, runAll, runOne, forget };
}

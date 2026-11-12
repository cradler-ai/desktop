// Executes an install. Every config file is backed up by Rust before it is written.
import { invoke } from '@tauri-apps/api/core';
import {
  afterInstallNote,
  applyInputs,
  diagnose,
  guidedInstructions,
  mcpEntryFor,
  planMcpInstall,
  planPluginInstall,
  precheck,
  probeTimeoutMs,
  skillFolderName,
  skillTargetDir,
  supportFor,
  upsertJsonServer,
  upsertTomlServer,
  type Candidate,
  type ClientId,
  type Diagnosis,
  type InstalledServer,
  type RawServerConfig,
  t,
  clientLabel,
} from '@cradler-desktop/core';
import { nativeError, nativeIO, probeHttp, probeStdio, runCapture, writeConfig } from './native';

export interface TargetResult {
  client: ClientId;
  status: 'ok' | 'error' | 'guided';
  message: string;
  restart?: string;
  copyText?: string;
}

export interface InstallOutcome {
  results: TargetResult[];
  /** The final MCP config, used for the connection test. */
  raw?: RawServerConfig;
}

const nameOf = (c: ClientId) => clientLabel(c);
const lastLine = (s: string) => s.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';


export async function install(c: Candidate, targets: ClientId[], values: Record<string, string>): Promise<InstallOutcome> {
  const io = await nativeIO();
  const spec = c.spec;
  const support = supportFor(spec);
  const results: TargetResult[] = [];

  if (spec.kind === 'mcp-local' || spec.kind === 'mcp-remote') {
    const raw = applyInputs(spec, values);
    const kind = spec.kind === 'mcp-local' ? 'local' : 'remote';
    for (const client of targets) {
      const mode = support.find((s) => s.client === client)?.mode;
      if (mode === 'guided') {
        results.push({
          client,
          status: 'guided',
          message: guidedInstructions(client, kind),
          copyText: raw.url ?? JSON.stringify({ mcpServers: { [c.name]: mcpEntryFor('cursor', raw) } }, null, 2),
        });
        continue;
      }
      const step = planMcpInstall(client, c.name, raw, io.home);
      if (!step) {
        results.push({ client, status: 'error', message: t('inst.unsupportedWay', { app: nameOf(client) }) });
        continue;
      }
      try {
        let replaced = false;
        if (step.kind === 'cli') {
          await invoke('backup_claude_json');
          let r = await runCapture('claude', step.args, 30000);
          if (!r.found) throw new Error(t('inst.noClaudeCli'));
          if (r.code !== 0 && /already exists/i.test(r.stderr + r.stdout)) {
            await runCapture('claude', ['mcp', 'remove', step.args[2], '-s', 'user'], 30000);
            r = await runCapture('claude', step.args, 30000);
            replaced = true;
          }
          if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || t('inst.cmdFailed'));
        } else {
          const [text] = await io.readTexts([step.path]);
          const next = step.kind === 'json' ? upsertJsonServer(text, step.name, step.entry) : upsertTomlServer(text, step.name, step.raw);
          replaced = next.replaced;
          await writeConfig(step.path, next.text);
        }
        const note = afterInstallNote(client);
        results.push({ client, status: 'ok', message: t(replaced ? 'inst.updated' : 'inst.ok', { note: note.text }), restart: note.restart });
      } catch (e) {
        results.push({ client, status: 'error', message: nativeError(e) });
      }
    }
    return { results, raw };
  }

  if (spec.kind === 'skill') {
    const folder = skillFolderName(c.name, spec.dir);
    const direct = targets.filter((t) => skillTargetDir(t, io.home, folder));
    if (direct.length) {
      try {
        const out = await invoke<{ target: string; ok: boolean; replaced: boolean; message: string | null }[]>('install_skill', {
          req: {
            owner: spec.source.owner,
            repo: spec.source.repo,
            gitRef: spec.source.ref ?? 'HEAD',
            dir: spec.dir,
            files: spec.files?.length ? spec.files : ['SKILL.md'],
            targets: direct.map((t) => skillTargetDir(t, io.home, folder)!),
          },
        });
        direct.forEach((client, i) => {
          const r = out[i];
          const note = afterInstallNote(client).text;
          results.push(
            r?.ok
              ? { client, status: 'ok', message: t(r.replaced ? 'inst.skillUpdated' : 'inst.ok', { note }) }
              : { client, status: 'error', message: r?.message ? nativeError(r.message) : t('inst.failed') },
          );
        });
      } catch (e) {
        for (const client of direct) results.push({ client, status: 'error', message: nativeError(e) });
      }
    }
    for (const client of targets.filter((t) => !direct.includes(t))) {
      results.push({ client, status: 'guided', message: guidedInstructions(client, 'skill') });
    }
    return { results };
  }

  if (spec.kind === 'plugin') {
    const steps = planPluginInstall(spec);
    for (const client of targets) {
      if (client !== 'claude-code') {
        results.push({ client, status: 'guided', message: guidedInstructions(client, 'plugin') });
        continue;
      }
      if (!steps) {
        results.push({ client, status: 'error', message: t('inst.noMarketplace') });
        continue;
      }
      try {
        for (const args of steps) {
          const r = await runCapture('claude', args, 120000);
          if (!r.found) throw new Error(t('inst.noClaudeCli'));
          const out = r.stderr + r.stdout;
          if (r.code !== 0 && !(args[1] === 'marketplace' && /already/i.test(out))) throw new Error(lastLine(out) || t('inst.cmdFailed'));
        }
        results.push({ client, status: 'ok', message: t('inst.pluginOk') });
      } catch (e) {
        results.push({ client, status: 'error', message: nativeError(e) });
      }
    }
    return { results };
  }

  // .mcpb extension: Claude Desktop shows its own install window
  for (const client of targets) {
    if (client !== 'claude-desktop' || !spec.downloadUrl) {
      results.push({ client, status: 'error', message: t('inst.mcpbOnlyDesktop') });
      continue;
    }
    const assets = spec.assets ?? [];
    const arch = navigator.userAgent.includes('ARM') ? 'arm64' : 'x64';
    const pick = assets.find((a) => /darwin|mac/i.test(a.name) && a.name.includes(arch)) ?? assets.find((a) => /darwin|mac/i.test(a.name)) ?? assets[0];
    try {
      await invoke('open_extension', { url: pick?.url ?? spec.downloadUrl });
      results.push({ client, status: 'ok', message: t('inst.mcpbOpened') });
    } catch (e) {
      results.push({ client, status: 'error', message: nativeError(e) });
    }
  }
  return { results };
}

/** Starts / connects to the freshly installed server once, like an AI app would. */
export async function verify(c: Candidate, raw: RawServerConfig, client: ClientId): Promise<Diagnosis> {
  const fake: InstalledServer = { key: 'verify', name: c.name, client, scope: 'user', configPath: '', disabled: false, raw, spec: null };
  const pre = precheck(fake);
  if (pre) return pre;
  const timeoutMs = probeTimeoutMs(raw);
  const r = raw.url
    ? await probeHttp({ url: raw.url, headers: raw.headers, transport: raw.transport ?? 'http', timeoutMs })
    : await probeStdio({ command: raw.command ?? '', args: raw.args, env: raw.env, timeoutMs });
  const d = diagnose(fake, r);
  return { ...d, fixes: d.fixes.filter((f) => f.kind !== 'reveal') };
}

export const restartApp = (name: string) => invoke<void>('restart_app', { name });

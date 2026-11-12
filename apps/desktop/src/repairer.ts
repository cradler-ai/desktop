// Carries out a repair from the health check. Files are backed up by Rust before writing;
// Claude Code configs go through its own CLI (with ~/.claude.json copied aside first).
import {
  findRunner,
  planRepairWrite,
  repairedRaw,
  t,
  type FetchLike,
  type InstalledServer,
  type RawServerConfig,
  type RepairField,
  type RepairInput,
  type RepairKind,
} from '@mcp-manager/core';
import { backupClaudeJson, installNode, installUv, nativeError, nativeIO, runCapture, writeConfig } from './native';

const browserFetch: FetchLike = (u, i) => globalThis.fetch(u, i);

export async function lookupRunner(command: string) {
  return findRunner(command, browserFetch);
}

/** Preview of the new config (for the confirm step). */
export function previewRepair(s: InstalledServer, kind: RepairKind, input: RepairInput, fields: RepairField[]): RawServerConfig | null {
  return repairedRaw(s.raw, kind, input, fields);
}

export interface RepairResult {
  ok: boolean;
  message: string;
}

export async function runRepair(servers: InstalledServer[], kind: RepairKind, input: RepairInput, fields: RepairField[]): Promise<RepairResult> {
  try {
    if (kind === 'install-node') return { ok: true, message: t('repair.nodeOpened', { v: await installNode() }) };
    if (kind === 'install-uv') {
      await installUv();
      return { ok: true, message: t('repair.uvDone') };
    }
    for (const s of servers) await writeServer(s, repairedRaw(s.raw, kind, input, fields));
    return { ok: true, message: t('repair.done') };
  } catch (e) {
    return { ok: false, message: t('repair.failed', { msg: nativeError(e) }) };
  }
}

/**
 * Writes one server's new config where it lives (null removes it).
 * Files: backed up and rewritten by Rust. Claude Code: its own CLI, with ~/.claude.json copied aside first.
 */
export async function writeServer(s: InstalledServer, next: RawServerConfig | null): Promise<void> {
  const isCli = s.client === 'claude-code' && s.configPath.endsWith('/.claude.json');
  const io = await nativeIO();
  const [text] = isCli ? [null] : await io.readTexts([s.configPath]);
  const plan = planRepairWrite(s, next, text, s.raw);
  if (plan.kind === 'file') {
    await writeConfig(plan.path, plan.text);
    return;
  }
  await backupClaudeJson();
  for (const step of plan.steps) {
    const r = await runCapture('claude', step, 30000, plan.cwd);
    if (!r.found) throw new Error(t('inst.noClaudeCli'));
    // "remove" of something already gone is fine; a failed add puts the old entry back.
    if (r.code !== 0 && step[1] === 'add-json') {
      for (const u of plan.undo) await runCapture('claude', u, 30000, plan.cwd);
      throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || t('inst.cmdFailed'));
    }
  }
}

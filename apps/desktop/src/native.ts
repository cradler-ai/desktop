// Thin wrappers around the Rust commands (see src-tauri/src/lib.rs).
import { invoke } from '@tauri-apps/api/core';
import { t, type DirEntry, type InventoryIO, type ProbeResult } from '@cradle/core';
import { inTauri } from './clients';

export interface CaptureResult {
  found: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

let home: string | null = null;

export async function nativeIO(): Promise<InventoryIO> {
  if (!inTauri) throw new Error(t('native.needDesktop'));
  home ??= await invoke<string>('home_dir');
  return {
    home,
    readTexts: (paths) => invoke<(string | null)[]>('read_texts', { paths }),
    listDir: (path) => invoke<DirEntry[]>('list_dir', { path }),
  };
}

/** Rust errors are "code|detail|detail"; turn them into a sentence in the user's language. */
export function nativeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const [code, a = '', b = ''] = raw.split('|');
  const key = `native.${code}`;
  const msg = t(key, { a, b });
  return msg === key ? raw : msg;
}

export const probeStdio = (req: { command: string; args: string[]; env: Record<string, string>; cwd?: string; timeoutMs: number }) =>
  invoke<ProbeResult>('probe_stdio', { req });

export const probeHttp = (req: { url: string; headers: Record<string, string>; transport: string; timeoutMs: number }) =>
  invoke<ProbeResult>('probe_http', { req });

export const runCapture = (program: string, args: string[], timeoutMs = 10000, cwd?: string) =>
  invoke<CaptureResult>('run_capture', { program, args, timeoutMs, cwd: cwd ?? null });

export const writeConfig = (path: string, content: string) => invoke<{ backup: string | null }>('write_config', { path, content });

export const backupClaudeJson = () => invoke<string | null>('backup_claude_json');

export const trashSkill = (path: string) => invoke<void>('trash_skill', { path });

export const installNode = () => invoke<string>('install_node');

export const installUv = () => invoke<string>('install_uv');

export async function reveal(path: string): Promise<void> {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

export function shortPath(p: string): string {
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

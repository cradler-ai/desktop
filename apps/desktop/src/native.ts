// Thin wrappers around the Rust commands (see src-tauri/src/lib.rs).
import { invoke } from '@tauri-apps/api/core';
import { t, type ClientId, type DirEntry, type InventoryIO, type ProbeResult } from '@cradler-desktop/core';
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

export interface SignInResult {
  found: boolean;
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
}

/** Signs in to an online server with the app's own CLI (it opens the browser and waits, up to 10 minutes). */
export const signInMcp = (client: ClientId, name: string, cwd?: string) =>
  invoke<SignInResult>('mcp_sign_in', { client, name, cwd: cwd ?? null });

export const cancelSignIn = () => invoke<void>('cancel_mcp_sign_in');

/**
 * Whether the app itself holds a sign-in for this online server. Only the app has the token, so our own
 * connection test gets "not authorized" either way. null = could not tell.
 */
export async function appSignedIn(client: ClientId, name: string, cwd?: string): Promise<boolean | null> {
  if (client === 'claude-code') {
    // "Status: ✔ Connected" / "Status: ! Needs authentication" / "Status: ✘ Failed to connect"
    const r = await runCapture('claude', ['mcp', 'get', name], 30000, cwd);
    const status = /Status:\s*(.+)/.exec(r.stdout)?.[1] ?? '';
    if (/connected/i.test(status) && !/fail/i.test(status)) return true;
    if (/auth/i.test(status)) return false;
    return null;
  }
  if (client === 'codex') {
    const r = await runCapture('codex', ['mcp', 'list', '--json'], 20000);
    try {
      const entry = (JSON.parse(r.stdout) as { name?: string; auth_status?: string }[]).find((e) => e.name === name);
      const status = entry?.auth_status;
      if (!status || status === 'unsupported') return null;
      return status !== 'not_logged_in';
    } catch {
      return null;
    }
  }
  return null;
}

export async function reveal(path: string): Promise<void> {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

export function shortPath(p: string): string {
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

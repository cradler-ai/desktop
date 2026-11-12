import { invoke } from '@tauri-apps/api/core';
import type { ClientId } from '@cradler-desktop/core';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** AI apps found on this machine (read-only check done in Rust). */
export async function detectClients(): Promise<Set<ClientId>> {
  if (!inTauri) return new Set();
  try {
    const list = await invoke<{ id: ClientId; installed: boolean }[]>('detect_clients');
    return new Set(list.filter((c) => c.installed).map((c) => c.id));
  } catch {
    return new Set();
  }
}

export async function openExternal(url: string): Promise<void> {
  if (inTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

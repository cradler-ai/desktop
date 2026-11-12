import { useCallback, useEffect, useMemo, useState } from 'react';
import { CLIENTS, loadInventory, t, type ClientId, type Inventory, type RepairKind } from '@cradle/core';
import { detectClients, inTauri } from './clients';
import { nativeIO } from './native';
import { useHealth, worst } from './health';
import { InstallPage } from './pages/InstallPage';
import { InstalledPage } from './pages/InstalledPage';
import { HealthPage } from './pages/HealthPage';
import { EditorPage, type EditTarget } from './pages/EditorPage';
import { IconGrid, IconInstall, IconPulse } from './icons';

type Page = 'install' | 'installed' | 'health';

const params = new URLSearchParams(window.location.search);

export default function App() {
  const [page, setPage] = useState<Page>((['install', 'installed', 'health'] as Page[]).find((p) => p === params.get('page')) ?? 'install');
  const [clients, setClients] = useState<Set<ClientId>>(new Set());
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [invError, setInvError] = useState<string | null>(null);
  const [invLoading, setInvLoading] = useState(false);
  const [installCompact, setInstallCompact] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const health = useHealth();

  const reload = useCallback(async (): Promise<Inventory | null> => {
    if (!inTauri) {
      setInvError(t('inv.needDesktop'));
      return null;
    }
    setInvLoading(true);
    try {
      const inv = await loadInventory(await nativeIO());
      setInventory(inv);
      setInvError(null);
      return inv;
    } catch (e) {
      setInvError(t('inv.failed', { msg: e instanceof Error ? e.message : String(e) }));
      return null;
    } finally {
      setInvLoading(false);
    }
  }, []);

  useEffect(() => {
    detectClients().then(setClients);
    reload();
  }, [reload]);

  // ?page=health&run=1 starts a check right away (used for previews).
  useEffect(() => {
    if (inventory && params.get('run') === '1' && !health.lastRun && !health.running) health.runAll(inventory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory]);

  // ?focus=1 (preview/screenshot helper): come to the front when a long task finishes.
  useEffect(() => {
    if (params.get('focus') === '1' && health.lastRun && inTauri) import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().setFocus());
  }, [health.lastRun]);

  /** After a repair or an edit: re-read the configs, then check the touched servers again. */
  const recheck = useCallback(
    async (keys: string[], kind?: RepairKind) => {
      if (kind === 'install-node') return; // the user finishes the installer, then presses "Try again"
      const inv = await reload();
      if (!inv) return;
      const gone: string[] = [];
      for (const key of keys) {
        const s = inv.servers.find((x) => x.key === key);
        if (s) health.runOne(s);
        else gone.push(key);
      }
      if (gone.length) health.forget(gone);
    },
    [reload, health],
  );

  const problems = useMemo(() => {
    if (!inventory) return 0;
    return inventory.serverGroups.filter((g) => worst(g.items.map((i) => health.results[i.key]))?.status === 'error').length;
  }, [inventory, health.results]);

  const nav = (p: Page) => {
    setEditing(null);
    if (p === 'install' && page === 'install') setResetSignal((n) => n + 1);
    setPage(p);
  };

  return (
    <div className="app">
      <aside className="sidebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <div className="brand-mark">
            <IconInstall size={16} />
          </div>
          <span className="brand-name">{t('app.name')}</span>
        </div>
        <nav className="nav">
          <button className={`nav-item ${page === 'install' ? 'is-active' : ''}`} onClick={() => nav('install')}>
            <IconInstall size={16} />
            {t('nav.install')}
          </button>
          <button className={`nav-item ${page === 'installed' ? 'is-active' : ''}`} onClick={() => nav('installed')}>
            <IconGrid size={16} />
            {t('nav.installed')}
            {inventory && <span className="nav-count">{inventory.serverGroups.length + inventory.skillGroups.length + inventory.plugins.length}</span>}
          </button>
          <button className={`nav-item ${page === 'health' ? 'is-active' : ''}`} onClick={() => nav('health')}>
            <IconPulse size={16} />
            {t('nav.health')}
            {health.running ? <span className="spinner spinner--muted nav-spin" /> : problems > 0 && <span className="nav-badge">{problems}</span>}
          </button>
        </nav>
        <div className="side-clients">
          <div className="side-title">{t('side.apps')}</div>
          {CLIENTS.map((c) => (
            <div key={c.id} className={`client-row ${clients.has(c.id) ? '' : 'is-missing'}`}>
              <span className="dot" />
              {c.name}
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        <div className="titlebar" data-tauri-drag-region />
        <div className={`stage ${installCompact ? 'stage--compact' : ''}`} hidden={!!editing || page !== 'install'}>
          <InstallPage clients={clients} initialQuery={params.get('q')} resetSignal={resetSignal} onCompactChange={setInstallCompact} onInstalled={reload} />
        </div>
        <div className="stage stage--compact" hidden={!!editing || page !== 'installed'}>
          <InstalledPage
            inventory={inventory}
            error={invError}
            loading={invLoading}
            onReload={reload}
            health={health}
            onRepaired={recheck}
            onEdit={setEditing}
          />
        </div>
        <div className="stage stage--compact" hidden={!!editing || page !== 'health'}>
          <HealthPage inventory={inventory} health={health} onRepaired={recheck} onEdit={setEditing} />
        </div>
        {editing && (
          <div className="stage stage--compact">
            <EditorPage key={editing.id} target={editing} onBack={() => setEditing(null)} onSaved={recheck} onReload={reload} health={health} onEdit={setEditing} />
          </div>
        )}
      </main>
    </div>
  );
}

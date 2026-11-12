import { useMemo, useState } from 'react';
import {
  displayConfig,
  displayRaw,
  skillLocationLabel,
  t,
  type InstalledPlugin,
  type InstalledSkill,
  type Inventory,
  type RepairKind,
  type ServerGroup,
  type SkillGroup,
} from '@cradler-desktop/core';
import type { HealthState } from '../health';
import { worst } from '../health';
import { nativeError, reveal, runCapture, shortPath, trashSkill } from '../native';
import type { EditTarget } from './EditorPage';
import { IconAlert, IconChevron, IconChip, IconFolder, IconGlobe, IconLink, IconPuzzle, IconRefresh, IconSearch, IconSparkle, IconTrash } from '../icons';
import { Chip, CodeBlock, DiagnosisView, Empty, PageHeader, StatusBadge, Switch, Tabs, placeLabel } from '../ui';

type Tab = 'mcp' | 'skills' | 'plugins';

export function InstalledPage(props: {
  inventory: Inventory | null;
  error: string | null;
  loading: boolean;
  onReload: () => Promise<unknown>;
  health: HealthState;
  onRepaired: (keys: string[], kind?: RepairKind) => void;
  onEdit: (target: EditTarget) => void;
}) {
  const [tab, setTab] = useState<Tab>('mcp');
  const [q, setQ] = useState('');
  const inv = props.inventory;
  const query = q.trim().toLowerCase();
  const hit = (...s: (string | undefined)[]) => !query || s.some((x) => x?.toLowerCase().includes(query));

  const servers = useMemo(() => (inv?.serverGroups ?? []).filter((g) => hit(g.name, ...g.items.map((i) => displayRaw(i.raw)))), [inv, query]);
  const skills = useMemo(() => (inv?.skillGroups ?? []).filter((g) => hit(g.name, g.description)), [inv, query]);
  const plugins = useMemo(() => (inv?.plugins ?? []).filter((p) => hit(p.name, p.description, p.marketplace)), [inv, query]);

  const subtitle = inv
    ? t('installed.subtitle', { mcp: inv.serverGroups.length, skills: inv.skillGroups.length, plugins: inv.plugins.length })
    : props.error ?? t('installed.reading');

  return (
    <div className="page">
      <PageHeader
        title={t('installed.title')}
        subtitle={subtitle}
        actions={
          <button className="btn-quiet" onClick={() => props.onReload()} disabled={props.loading}>
            <IconRefresh size={14} />
            {props.loading ? t('common.loading') : t('common.refresh')}
          </button>
        }
      />
      {inv && (
        <>
          <div className="toolbar">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { id: 'mcp', label: t('tab.mcp'), count: inv.serverGroups.length },
                { id: 'skills', label: t('tab.skills'), count: inv.skillGroups.length },
                { id: 'plugins', label: t('tab.plugins'), count: inv.plugins.length },
              ]}
            />
            <label className="filter filter--inline">
              <IconSearch size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} spellCheck={false} />
            </label>
          </div>

          {tab === 'mcp' &&
            (servers.length ? (
              servers.map((g, i) => <ServerCard key={g.id} group={g} index={i} health={props.health} onRepaired={props.onRepaired} onEdit={props.onEdit} />)
            ) : (
              <Empty title={t('installed.noMcp')} />
            ))}
          {tab === 'skills' &&
            (skills.length ? (
              skills.map((g, i) => <SkillCard key={g.name} group={g} index={i} onChanged={props.onReload} onEdit={props.onEdit} />)
            ) : (
              <Empty title={t('installed.noSkills')} />
            ))}
          {tab === 'plugins' &&
            (plugins.length ? (
              <>
                <div className="hint-line">{t('installed.pluginHint')}</div>
                {plugins.map((p, i) => (
                  <PluginCard key={p.id} plugin={p} index={i} onChanged={props.onReload} />
                ))}
              </>
            ) : (
              <Empty title={t('installed.noPlugins')} />
            ))}
        </>
      )}
    </div>
  );
}

function ServerCard(props: {
  group: ServerGroup;
  index: number;
  health: HealthState;
  onRepaired: (keys: string[], kind?: RepairKind) => void;
  onEdit: (target: EditTarget) => void;
}) {
  const { group, health } = props;
  const [open, setOpen] = useState(false);
  const local = group.kind === 'mcp-local';
  const diag = worst(group.items.map((i) => health.results[i.key]));
  const allDisabled = group.items.every((i) => i.disabled);

  return (
    <article className={`card group ${open ? 'is-open' : ''} ${allDisabled ? 'is-dim' : ''}`} style={{ ['--i' as string]: Math.min(props.index, 12) }}>
      <div className="group-head" onClick={() => setOpen(!open)}>
        <div className="tile">{local ? <IconChip size={20} /> : <IconGlobe size={20} />}</div>
        <div className="group-main">
          <div className="group-title">
            <span className="name">{group.name}</span>
            <span className="badge">{t(local ? 'kind.mcp-local' : 'kind.mcp-remote')}</span>
            {!group.consistent && <span className="badge tone-orange">{t('installed.inconsistent')}</span>}
            {diag && <StatusBadge status={diag.status} />}
          </div>
          <p className="mono-line">{displayRaw(group.items[0].raw)}</p>
          <div className="reqs">
            {group.items.map((i) => (
              <Chip key={i.key} muted={i.disabled}>
                {placeLabel(i)}
                {i.disabled ? t('installed.off') : ''}
              </Chip>
            ))}
          </div>
        </div>
        <button className="chev" aria-label={open ? t('common.collapse') : t('common.expand')}>
          <IconChevron size={16} />
        </button>
      </div>

      {open && (
        <div className="group-body">
          {!group.consistent && (
            <div className="warn">
              <IconAlert size={14} />
              <span>{t('installed.inconsistentNote')}</span>
            </div>
          )}
          {group.items.map((s) => {
            const d = health.results[s.key];
            const busy = health.checking.has(s.key);
            const editable = s.scope !== 'plugin' && s.scope !== 'extension';
            return (
              <div key={s.key} className="inst">
                <div className="inst-head">
                  <span className="inst-name">{placeLabel(s)}</span>
                  <span className="inst-path">{shortPath(s.configPath)}</span>
                  <span className="spacer" />
                  {s.scope !== 'plugin' && (
                    <button className="btn-small" onClick={() => reveal(s.configPath)}>
                      <IconFolder size={13} />
                      {t('installed.showFile')}
                    </button>
                  )}
                  <button className="btn-small" onClick={() => props.onEdit({ id: `server:${s.key}`, kind: 'server', server: s })}>
                    {editable ? t('editor.edit') : t('editor.view')}
                  </button>
                  <button className="btn-small" disabled={busy} onClick={() => health.runOne(s)}>
                    {busy ? <span className="spinner spinner--muted" /> : null}
                    {busy ? t('installed.checking') : t('installed.check')}
                  </button>
                </div>
                <CodeBlock text={displayConfig(s.raw)} />
                {d && <DiagnosisView diag={d} onRetry={() => health.runOne(s)} servers={[s]} onRepaired={props.onRepaired} />}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function locationText(s: InstalledSkill): string {
  const base = s.location === 'plugin' ? t('scope.plugin', { name: s.plugin }) : skillLocationLabel(s.location);
  return s.isSymlink ? t('skills.link', { place: base }) : base;
}

function SkillCard(props: { group: SkillGroup; index: number; onChanged: () => Promise<unknown>; onEdit: (target: EditTarget) => void }) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copies = group.items.filter((i) => !i.isSymlink).length;

  async function remove(s: InstalledSkill) {
    if (confirm !== s.key) {
      setConfirm(s.key);
      return;
    }
    try {
      await trashSkill(s.dir);
      setConfirm(null);
      await props.onChanged();
    } catch (e) {
      setError(t('skills.removeFailed', { msg: nativeError(e) }));
    }
  }

  return (
    <article className={`card group ${open ? 'is-open' : ''}`} style={{ ['--i' as string]: Math.min(props.index, 12) }}>
      <div className="group-head" onClick={() => setOpen(!open)}>
        <div className="tile">
          <IconSparkle size={20} />
        </div>
        <div className="group-main">
          <div className="group-title">
            <span className="name">{group.name}</span>
            {copies > 1 && <span className="badge">{t('skills.copies', { n: copies })}</span>}
            {group.differs && <span className="badge tone-orange">{t('skills.differs')}</span>}
          </div>
          {group.description && <p className="desc">{group.description}</p>}
          <div className="reqs">
            {group.items.map((s) => (
              <Chip key={s.key}>
                {s.isSymlink && <IconLink size={12} />}
                {locationText(s)}
              </Chip>
            ))}
          </div>
        </div>
        <button className="chev" aria-label={open ? t('common.collapse') : t('common.expand')}>
          <IconChevron size={16} />
        </button>
      </div>
      {open && (
        <div className="group-body">
          {group.differs && (
            <div className="warn">
              <IconAlert size={14} />
              <span>{t('skills.differsNote')}</span>
            </div>
          )}
          {group.items.map((s) => (
            <div key={s.key} className="inst">
              <div className="inst-head">
                <span className="inst-name">{locationText(s)}</span>
                <span className="inst-path">{shortPath(s.isSymlink && s.linkTarget ? `${s.dir} → ${s.linkTarget}` : s.dir)}</span>
                <span className="spacer" />
                <button className="btn-small" onClick={() => reveal(s.dir + '/SKILL.md')}>
                  <IconFolder size={13} />
                  {t('installed.showFile')}
                </button>
                <button className="btn-small" onClick={() => props.onEdit({ id: `skill:${s.key}`, kind: 'skill', skill: s })}>
                  {s.removable ? t('editor.edit') : t('editor.view')}
                </button>
                {s.removable && (
                  <button className={`btn-small ${confirm === s.key ? 'is-danger' : ''}`} onClick={() => remove(s)} onBlur={() => setConfirm(null)}>
                    <IconTrash size={13} />
                    {confirm === s.key ? (s.isSymlink ? t('skills.confirmLink') : t('skills.confirmTrash')) : t('skills.remove')}
                  </button>
                )}
              </div>
              {s.location === 'synced' && <div className="hint-line">{t('skills.syncedNote')}</div>}
              {s.location === 'plugin' && <div className="hint-line">{t('skills.pluginNote', { plugin: s.plugin })}</div>}
            </div>
          ))}
          {error && (
            <div className="warn">
              <IconAlert size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function PluginCard({ plugin, index, onChanged }: { plugin: InstalledPlugin; index: number; onChanged: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const c = plugin.counts;
  const parts = [
    c.skills ? t('plugins.skills', { n: c.skills }) : '',
    c.commands ? t('plugins.commands', { n: c.commands }) : '',
    c.agents ? t('plugins.agents', { n: c.agents }) : '',
    c.mcp ? t('plugins.mcp', { n: c.mcp }) : '',
    c.hooks ? t('plugins.hooks') : '',
  ].filter(Boolean);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    const r = await runCapture('claude', ['plugin', next ? 'enable' : 'disable', plugin.id], 30000);
    if (!r.found) setError(t('plugins.noCli'));
    else if (r.code !== 0) setError((r.stderr || r.stdout || t('plugins.toggleFailed')).split('\n').slice(-2).join(' '));
    await onChanged();
    setBusy(false);
  }

  return (
    <article className={`card group ${open ? 'is-open' : ''} ${plugin.enabled ? '' : 'is-dim'}`} style={{ ['--i' as string]: Math.min(index, 12) }}>
      <div className="group-head" onClick={() => setOpen(!open)}>
        <div className="tile">
          <IconPuzzle size={20} />
        </div>
        <div className="group-main">
          <div className="group-title">
            <span className="name">{plugin.name}</span>
            <span className="badge">{plugin.marketplace}</span>
            {plugin.version && <span className="version">v{plugin.version}</span>}
          </div>
          {plugin.description && <p className="desc">{plugin.description}</p>}
          {parts.length > 0 && (
            <div className="reqs">
              {parts.map((p) => (
                <Chip key={p}>{p}</Chip>
              ))}
            </div>
          )}
        </div>
        <Switch on={plugin.enabled} busy={busy} onChange={toggle} label={plugin.enabled ? t('plugins.disable') : t('plugins.enable')} />
      </div>
      {error && (
        <div className="warn warn--inset">
          <IconAlert size={14} />
          <span>{error}</span>
        </div>
      )}
      {open && (
        <div className="group-body">
          <div className="inst">
            <div className="inst-head">
              <span className="inst-name">{t('plugins.location')}</span>
              <span className="inst-path">{shortPath(plugin.installPath)}</span>
              <span className="spacer" />
              <button className="btn-small" onClick={() => reveal(plugin.installPath)}>
                <IconFolder size={13} />
                {t('installed.showFolder')}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

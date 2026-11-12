import { useMemo } from 'react';
import {
  clientLabel,
  getLocale,
  t,
  type Diagnosis,
  type HealthStatus,
  type InstalledServer,
  type Inventory,
  type RepairKind,
  type ServerGroup,
} from '@cradler-desktop/core';
import { worst, type HealthState } from '../health';
import { openExternal } from '../clients';
import { reveal, shortPath } from '../native';
import { IconPulse } from '../icons';
import type { EditTarget } from './EditorPage';
import { DiagnosisView, Empty, PageHeader, STATUS, listJoin, placeLabel } from '../ui';

const ORDER: HealthStatus[] = ['error', 'auth', 'ok', 'skipped'];

function timeText(ts: number): string {
  const d = new Date(ts);
  return t('health.today', { time: d.toLocaleTimeString(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' }) });
}

export function HealthPage(props: {
  inventory: Inventory | null;
  health: HealthState;
  onRepaired: (keys: string[], kind?: RepairKind) => void;
  onEdit: (target: EditTarget) => void;
}) {
  const { inventory: inv, health } = props;

  const rows = useMemo(() => {
    if (!inv) return [];
    return inv.serverGroups
      .map((g) => ({ group: g, diag: worst(g.items.map((i) => health.results[i.key])) }))
      .sort((a, b) => ORDER.indexOf(a.diag?.status ?? 'ok') - ORDER.indexOf(b.diag?.status ?? 'ok') || a.group.name.localeCompare(b.group.name));
  }, [inv, health.results]);

  const counts = useMemo(() => {
    const c: Record<HealthStatus, number> = { ok: 0, error: 0, auth: 0, skipped: 0 };
    for (const r of rows) if (r.diag) c[r.diag.status]++;
    return c;
  }, [rows]);

  const hasResults = Object.keys(health.results).length > 0;
  const files = inv?.configFiles.filter((f) => f.exists) ?? [];
  const fileProblems = files.filter((f) => f.error).length;
  const pct = health.progress.total ? Math.round((health.progress.done / health.progress.total) * 100) : 0;

  return (
    <div className="page">
      <PageHeader
        title={t('health.title')}
        subtitle={health.lastRun ? t('health.last', { time: timeText(health.lastRun) }) : t('health.intro')}
        actions={
          <button className="btn-primary" disabled={!inv || health.running} onClick={() => inv && health.runAll(inv)}>
            {health.running ? t('health.running') : health.lastRun ? t('health.again') : t('health.start')}
          </button>
        }
      />

      {health.running && (
        <div className="card progress-card">
          <div className="progress-text">
            <span className="spinner spinner--muted" />
            {t('health.progress', { done: health.progress.done, total: health.progress.total })}
            {health.progress.current && <span className="progress-current">{health.progress.current}</span>}
          </div>
          <div className="bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="hint-line">{t('health.slowHint')}</div>
        </div>
      )}

      {!hasResults && !health.running && inv && (
        <div className="card intro">
          <div className="tile tile--lg">
            <IconPulse size={26} />
          </div>
          <div>
            <p className="empty-title">{t('health.introTitle', { n: inv.serverGroups.length })}</p>
            <p className="empty-sub">{t('health.introSub')}</p>
          </div>
        </div>
      )}

      {hasResults && (
        <div className="stats">
          {ORDER.map((s) => (
            <div key={s} className={`card stat tone-${STATUS[s].tone}`}>
              <span className="stat-num">{counts[s]}</span>
              <span className="stat-label">{STATUS[s].label}</span>
            </div>
          ))}
        </div>
      )}

      {hasResults && (
        <section className="section">
          <div className="section-head">
            <h2>{t('health.sectionMcp')}</h2>
            <span className="count">{rows.length}</span>
          </div>
          {rows.map((r, i) => (
            <HealthRow key={r.group.id} group={r.group} index={i} health={health} onRepaired={props.onRepaired} onEdit={props.onEdit} />
          ))}
        </section>
      )}

      {health.env && (
        <section className="section">
          <div className="section-head">
            <h2>{t('health.sectionEnv')}</h2>
          </div>
          <div className="env-grid">
            {health.env.map((e) => {
              const tone = e.status === 'ok' ? 'green' : e.status === 'warn' ? 'orange' : 'red';
              return (
                <div key={e.id} className={`card env tone-${tone}`}>
                  <div className="env-top">
                    <span className="env-name">{e.name}</span>
                    <span className={`badge tone-${tone}`}>{t(`env.${e.status}`)}</span>
                  </div>
                  <div className="env-detail">{e.version ? t('env.version', { v: e.version }) : e.detail}</div>
                  {e.version && e.detail && <div className="env-detail">{e.detail}</div>}
                  {e.url && e.status !== 'ok' && (
                    <button className="btn-small" onClick={() => openExternal(e.url!)}>
                      {t('env.download')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {inv && (hasResults || fileProblems > 0) && (
        <section className="section">
          <div className="section-head">
            <h2>{t('health.sectionFiles')}</h2>
            <span className="count">{files.length}</span>
          </div>
          <div className="card list-card">
            {files.map((f) => {
              const editable = !f.path.endsWith('/.claude.json');
              return (
                <div key={f.path} className="file-row">
                  <span className={`dot-status tone-${f.error ? 'red' : 'green'}`} />
                  <span className="file-client">{clientLabel(f.client)}</span>
                  <span className="inst-path">{shortPath(f.path)}</span>
                  <span className="spacer" />
                  <span className={f.error ? 'file-error' : 'file-ok'}>{f.error ?? t('health.fileOk', { n: f.servers })}</span>
                  {editable && (
                    <button className="btn-small" onClick={() => props.onEdit({ id: `file:${f.path}`, kind: 'file', path: f.path, client: f.client })}>
                      {t('editor.edit')}
                    </button>
                  )}
                  <button className="btn-small" onClick={() => reveal(f.path)}>
                    {t('installed.showFile')}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {!inv && <Empty title={t('installed.reading')} />}
    </div>
  );
}

function HealthRow(props: {
  group: ServerGroup;
  index: number;
  health: HealthState;
  onRepaired: (keys: string[], kind?: RepairKind) => void;
  onEdit: (target: EditTarget) => void;
}) {
  const { group, health } = props;
  const diag = worst(group.items.map((i) => health.results[i.key]));
  const meta = diag ? STATUS[diag.status] : null;
  // Distinct diagnoses within the group (e.g. works in Cursor, key missing in Claude Code).
  const distinct = useMemo(() => {
    const map = new Map<string, { diag: Diagnosis; servers: InstalledServer[] }>();
    for (const s of group.items) {
      const d = health.results[s.key];
      if (!d) continue;
      const k = `${d.status}|${d.title}|${d.detail ?? ''}`;
      const cur = map.get(k);
      if (cur) cur.servers.push(s);
      else map.set(k, { diag: d, servers: [s] });
    }
    return [...map.values()];
  }, [group, health.results]);
  const busy = group.items.some((s) => health.checking.has(s.key));
  const editable = group.items.find((s) => s.scope !== 'plugin' && s.scope !== 'extension');

  return (
    <article className="card group" style={{ ['--i' as string]: Math.min(props.index, 12) }}>
      <div className="group-head">
        <div className={`tile tone-${meta?.tone ?? 'gray'}`}>{meta ? <meta.Icon size={20} /> : <span className="spinner spinner--muted" />}</div>
        <div className="group-main">
          <div className="group-title">
            <span className="name">{group.name}</span>
            {busy && <span className="badge">{t('health.checkingBadge')}</span>}
            <span className="spacer" />
            {editable && (
              <button className="btn-small" onClick={() => props.onEdit({ id: `server:${editable.key}`, kind: 'server', server: editable })}>
                {t('editor.edit')}
              </button>
            )}
          </div>
          {distinct.length === 0 && <p className="desc">{health.running ? t('health.waiting') : t('health.notYet')}</p>}
          <div className="diag-stack">
            {distinct.map((d) => (
              <DiagnosisView
                key={d.diag.title + d.servers.map((s) => s.key).join()}
                diag={d.diag}
                affected={group.items.length > 1 || distinct.length > 1 ? listJoin(d.servers.map(placeLabel)) : undefined}
                onRetry={() => d.servers.forEach((s) => health.runOne(s))}
                compact={d.diag.status === 'ok'}
                servers={d.servers}
                onRepaired={props.onRepaired}
              />
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

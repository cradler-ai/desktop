import { useEffect, useState, type ReactNode } from 'react';
import {
  clientLabel,
  displayConfig,
  getLocale,
  scopeText,
  serviceName,
  t,
  type Diagnosis,
  type Fix,
  type HealthStatus,
  type InstalledServer,
  type RepairKind,
} from '@cradler-desktop/core';
import { openExternal } from './clients';
import { cancelSignIn, reveal } from './native';
import { lookupRunner, previewRepair, runRepair } from './repairer';
import { IconCheck, IconCheckCircle, IconCopy, IconKey, IconLock, IconPause, IconXCircle } from './icons';

export const STATUS: Record<HealthStatus, { readonly label: string; tone: string; Icon: (p: { size?: number }) => ReactNode }> = {
  ok: { get label() { return t('status.ok'); }, tone: 'green', Icon: IconCheckCircle },
  error: { get label() { return t('status.error'); }, tone: 'red', Icon: IconXCircle },
  auth: { get label() { return t('status.auth'); }, tone: 'ink', Icon: IconLock },
  skipped: { get label() { return t('status.skipped'); }, tone: 'gray', Icon: IconPause },
};

export function placeLabel(s: InstalledServer): string {
  return [clientLabel(s.client), scopeText(s)].filter(Boolean).join(' · ');
}

export const listJoin = (items: string[]) => items.join(getLocale() === 'zh' ? '、' : ', ');

export function PageHeader(props: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.subtitle && <p>{props.subtitle}</p>}
      </div>
      {props.actions && <div className="page-actions">{props.actions}</div>}
    </header>
  );
}

export function Tabs<T extends string>(props: { value: T; onChange: (v: T) => void; items: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="segmented segmented--lg">
      {props.items.map((it) => (
        <button key={it.id} className={it.id === props.value ? 'is-on' : ''} onClick={() => props.onChange(it.id)}>
          {it.label}
          {it.count != null && <span className="seg-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatusBadge({ status }: { status: HealthStatus }) {
  const s = STATUS[status];
  return <span className={`badge tone-${s.tone}`}>{s.label}</span>;
}

export function Chip({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <span className={`req ${muted ? 'is-muted' : ''}`}>{children}</span>;
}

export function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <pre className="selectable">{text}</pre>
      <button
        className="icon-btn"
        aria-label={t('common.copy')}
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
    </div>
  );
}

export function Switch(props: { on: boolean; busy?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      className={`switch ${props.on ? 'is-on' : ''} ${props.busy ? 'is-busy' : ''}`}
      disabled={props.busy}
      onClick={(e) => {
        e.stopPropagation();
        props.onChange(!props.on);
      }}
    >
      <span className="knob" />
    </button>
  );
}

export function DiagnosisView(props: {
  diag: Diagnosis;
  onRetry?: () => void;
  affected?: string;
  compact?: boolean;
  /** Servers this diagnosis applies to; enables the Fix buttons. */
  servers?: InstalledServer[];
  onRepaired?: (keys: string[], kind: RepairKind) => void;
}) {
  const { diag } = props;
  const s = STATUS[diag.status];
  const [active, setActive] = useState<Fix | null>(null);
  const canRepair = !!props.servers?.length;
  const visible = diag.fixes.filter((f) => (f.kind === 'repair' ? canRepair : f.kind === 'retry' ? !!props.onRetry : true));
  const run = (f: Fix) => {
    if (f.kind === 'open-url' && f.value) openExternal(f.value);
    else if (f.kind === 'reveal' && f.value) reveal(f.value);
    else if (f.kind === 'retry') props.onRetry?.();
    else if (f.kind === 'repair') setActive(active?.label === f.label ? null : f);
  };
  return (
    <div className={`diag tone-${s.tone}`}>
      <span className="diag-icon">
        <s.Icon size={16} />
      </span>
      <div className="diag-main">
        <div className="diag-title">{diag.title}</div>
        {diag.detail && <div className="diag-detail selectable">{diag.detail}</div>}
        {props.affected && <div className="diag-affected">{t('diag.affected', { places: props.affected })}</div>}
        {!props.compact && diag.tools && diag.tools.length > 0 && (
          <div className="tool-list">
            {diag.tools.slice(0, 24).map((x) => (
              <span key={x}>{x}</span>
            ))}
            {diag.tools.length > 24 && <span>…</span>}
          </div>
        )}
        {visible.length > 0 && (
          <div className="diag-actions">
            {visible.map((f) => (
              <button
                key={f.label}
                className={`btn-small ${f.primary ? 'btn-small--ink' : ''} ${active?.label === f.label ? 'is-active' : ''}`}
                onClick={() => run(f)}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        {active && props.servers && (
          <RepairPanel
            key={active.label}
            fix={active}
            servers={props.servers}
            onCancel={() => setActive(null)}
            onDone={(kind) => props.onRepaired?.(props.servers!.map((x) => x.key), kind)}
          />
        )}
        {diag.raw && diag.status !== 'ok' && (
          <details className="raw">
            <summary>{t('diag.showRaw')}</summary>
            <pre className="selectable">{diag.raw}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function RepairPanel(props: { fix: Fix; servers: InstalledServer[]; onCancel: () => void; onDone: (kind: RepairKind) => void }) {
  const kind = props.fix.repair!;
  const fields = props.fix.fields ?? [];
  const first = props.servers[0];
  const [values, setValues] = useState<Record<string, string>>({});
  const [url, setUrl] = useState(first.raw.url ?? '');
  const [runner, setRunner] = useState<{ command: string; args: string[] } | null | 'searching'>(kind === 'use-runner' ? 'searching' : null);
  const [phase, setPhase] = useState<'edit' | 'working' | 'done' | 'error'>('edit');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (kind === 'use-runner') lookupRunner(first.raw.command ?? '').then(setRunner).catch(() => setRunner(null));
  }, [kind, first.raw.command]);

  const input = { values, url, runner: runner && runner !== 'searching' ? runner : undefined };
  const places = listJoin(props.servers.map(placeLabel));
  const changesConfig = !['install-node', 'install-uv', 'sign-in'].includes(kind);

  let preview: string | null = null;
  if (changesConfig && kind !== 'remove' && (kind !== 'use-runner' || input.runner)) {
    try {
      const next = previewRepair(first, kind, input, fields);
      preview = next ? displayConfig(next) : null;
    } catch {
      preview = null;
    }
  }

  const ready =
    phase === 'edit' &&
    (kind !== 'use-runner' || !!input.runner) &&
    (kind !== 'edit-url' || (/^https?:\/\/\S+$/.test(url.trim()) && url.trim() !== first.raw.url)) &&
    (kind !== 'set-values' || fields.every((f) => (values[f.key] ?? '').trim()));

  async function apply() {
    setPhase('working');
    const r = await runRepair(props.servers, kind, input, fields);
    setMsg(r.message);
    setPhase(r.ok ? 'done' : 'error');
    if (r.ok) props.onDone(kind);
  }

  return (
    <div className="repair">
      {kind === 'set-values' && (
        <div className="form">
          {fields.map((f) => (
            <label key={f.key} className="form-row">
              <span className="form-label">
                <IconKey size={13} />
                {f.key}
              </span>
              <span className="form-input">
                <input
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('form.secretPlaceholder')}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              </span>
            </label>
          ))}
        </div>
      )}
      {kind === 'edit-url' && (
        <label className="form-row">
          <span className="form-label">{t('repair.newUrl')}</span>
          <span className="form-input">
            <input value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
          </span>
        </label>
      )}
      {kind === 'use-runner' && runner === 'searching' && (
        <div className="hint-line">
          <span className="spinner spinner--muted" /> {t('repair.searching')}
        </div>
      )}
      {kind === 'use-runner' && runner === null && <div className="hint-line">{t('repair.noRunner')}</div>}
      {kind === 'remove' && <div className="hint-line">{t('repair.removeWarn', { places })}</div>}
      {kind === 'install-node' && <div className="hint-line">{t('repair.nodeWarn')}</div>}
      {kind === 'install-uv' && <div className="hint-line">{t('repair.uvWarn')}</div>}
      {kind === 'sign-in' && phase === 'edit' && <div className="hint-line">{t('repair.signInWarn', { service: serviceName(first) })}</div>}
      {kind === 'sign-in' && phase === 'working' && (
        <div className="hint-line">
          <span className="spinner spinner--muted" /> {t('repair.signInWaiting')}
        </div>
      )}
      {preview && (
        <div>
          <div className="field-label">{t('repair.preview')}</div>
          <CodeBlock text={preview} />
        </div>
      )}
      {changesConfig && kind !== 'remove' && (
        <div className="hint-line">
          {t('repair.willChange', { places })} · {t('repair.backupNote')}
        </div>
      )}
      {phase !== 'edit' && phase !== 'working' && msg && <div className={`repair-msg ${phase === 'error' ? 'is-error' : ''}`}>{msg}</div>}
      {phase !== 'done' && (
        <div className="repair-actions">
          <button className="btn-small" onClick={kind === 'sign-in' && phase === 'working' ? () => void cancelSignIn() : props.onCancel}>
            {t('common.cancel')}
          </button>
          <button className={`btn-small btn-small--ink ${kind === 'remove' ? 'is-danger' : ''}`} disabled={!ready} onClick={apply}>
            {phase === 'working' ? t('repair.working') : kind === 'remove' || !changesConfig ? props.fix.label : t('repair.confirm')}
          </button>
        </div>
      )}
    </div>
  );
}

export function Empty(props: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card empty">
      <p className="empty-title">{props.title}</p>
      {props.sub && <p className="empty-sub">{props.sub}</p>}
      {props.children}
    </div>
  );
}

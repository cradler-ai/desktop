import { useEffect, useMemo, useState } from 'react';
import {
  SIGN_IN_CLIENTS,
  clientLabel,
  signInHint,
  inputId,
  inputsOf,
  missingInputs,
  previewText,
  sourceLabel,
  supportFor,
  getLocale,
  t,
  type Candidate,
  type CandidateGroup,
  type ClientId,
  type DetectResult,
  type Diagnosis,
  type InputField,
  type InstallSpec,
  type RepoMeta,
} from '@cradler-desktop/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { inTauri, openExternal } from './clients';
import { install, restartApp, verify, type TargetResult } from './installer';
import { appSignedIn, cancelSignIn } from './native';
import { signInOnce } from './repairer';
import { DiagnosisView } from './ui';
import {
  IconAlert,
  IconCheck,
  IconCheckCircle,
  IconChevron,
  IconChip,
  IconCopy,
  IconExternal,
  IconFolder,
  IconGithub,
  IconGlobe,
  IconInfo,
  IconKey,
  IconLock,
  IconPackage,
  IconPuzzle,
  IconRuntime,
  IconSearch,
  IconSparkle,
  IconStar,
  IconXCircle,
} from './icons';

const KIND_ICON = { 'mcp-local': IconChip, 'mcp-remote': IconGlobe, skill: IconSparkle, plugin: IconPuzzle, mcpb: IconPackage } as const;

const SECTIONS = [
  { key: 'mcp:', id: 'mcp' },
  { key: 'plugin:', id: 'plugin' },
  { key: 'skill:', id: 'skill' },
];

const PAGE = 6;

export function Results({ result, clients, onInstalled }: { result: DetectResult; clients: Set<ClientId>; onInstalled: () => void }) {
  const [filter, setFilter] = useState('');
  const total = result.groups.length;

  const sections = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (g: CandidateGroup) => !q || [g.primary.name, g.primary.title, g.primary.description].some((s) => s?.toLowerCase().includes(q));
    return SECTIONS.map((s) => ({ ...s, title: t(`results.section.${s.id}`), hint: t(`results.hint.${s.id}`), groups: result.groups.filter((g) => g.group.startsWith(s.key) && match(g)) })).filter((s) => s.groups.length);
  }, [result, filter]);

  const counts = SECTIONS.map((s) => ({ id: s.id, n: result.groups.filter((g) => g.group.startsWith(s.key)).length })).filter((c) => c.n);

  return (
    <div className="results">
      {result.repo && (
        <RepoCard repo={result.repo} summary={counts.map((c) => t(`results.count.${c.id}`, { n: c.n })).join(' · ')} />
      )}

      {result.notes.map((n) => (
        <div key={n} className="note">
          <IconInfo size={15} />
          <span>{n}</span>
        </div>
      ))}

      {total === 0 && (
        <div className="card empty">
          <p className="empty-title">{t('results.empty.title')}</p>
          <p className="empty-sub">{t('results.empty.sub')}</p>
        </div>
      )}

      {total > 12 && (
        <label className="filter">
          <IconSearch size={14} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('results.filter', { n: total })} spellCheck={false} />
        </label>
      )}

      {sections.map((s) => (
        <Section key={s.key} title={s.title} hint={s.hint} groups={s.groups} clients={clients} single={total === 1} onInstalled={onInstalled} />
      ))}
    </div>
  );
}

function RepoCard({ repo, summary }: { repo: RepoMeta; summary: string }) {
  return (
    <section className="card repo">
      <div className="tile">
        <IconGithub size={20} />
      </div>
      <div className="repo-main">
        <div className="repo-name">
          <span className="repo-owner">{repo.owner} /</span> {repo.repo}
        </div>
        {repo.description && <p className="desc selectable">{repo.description}</p>}
        <div className="meta">
          {repo.stars != null && (
            <span>
              <IconStar size={13} />
              {formatCount(repo.stars)}
            </span>
          )}
          {repo.license && repo.license !== 'NOASSERTION' && <span>{repo.license}</span>}
          {summary && <span>{t('results.found', { list: summary })}</span>}
        </div>
      </div>
      <button className="btn-quiet" onClick={() => openExternal(repo.url)}>
        <IconExternal size={14} />
        GitHub
      </button>
    </section>
  );
}

function Section(props: { title: string; hint: string; groups: CandidateGroup[]; clients: Set<ClientId>; single: boolean; onInstalled: () => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? props.groups : props.groups.slice(0, PAGE);
  return (
    <section className="section">
      <div className="section-head">
        <h2>{props.title}</h2>
        <span className="count">{props.groups.length}</span>
        <span className="section-hint">{props.hint}</span>
      </div>
      {shown.map((g, i) => (
        <GroupCard key={g.group} group={g} clients={props.clients} index={i} defaultOpen={props.single} onInstalled={props.onInstalled} />
      ))}
      {props.groups.length > PAGE && (
        <button className="more" onClick={() => setAll(!all)}>
          {all ? t('common.collapse') : t('results.showAll', { n: props.groups.length })}
        </button>
      )}
    </section>
  );
}

function methodLabels(options: Candidate[]): string[] {
  const raw = options.map((c) => {
    const s = c.spec;
    if (s.kind === 'mcp-local') return ({ node: 'Node', python: 'Python', docker: 'Docker', binary: t('method.program'), other: t('method.other') } as const)[s.runtime];
    if (s.kind === 'mcp-remote') return t('kind.mcp-remote');
    if (s.kind === 'mcpb') return t('kind.mcpb');
    if (s.kind === 'plugin') return s.marketplace?.name ?? t('kind.plugin');
    return s.dir.split('/').slice(-2).join('/') || t('kind.skill');
  });
  const seen = new Map<string, number>();
  return raw.map((l, i) => {
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    const label = n > 1 ? `${l} ${n}` : l;
    return i === 0 ? t('card.recommended', { label }) : label;
  });
}

function defaultTargets(spec: InstallSpec, clients: Set<ClientId>): Set<ClientId> {
  return new Set(supportFor(spec).filter((s) => s.mode === 'direct' && clients.has(s.client)).map((s) => s.client));
}

type Phase = { step: 'idle' } | { step: 'installing' } | { step: 'done'; results: TargetResult[]; check?: Diagnosis | 'running' };

function GroupCard(props: { group: CandidateGroup; clients: Set<ClientId>; index: number; defaultOpen: boolean; onInstalled: () => void }) {
  const options = [props.group.primary, ...props.group.alternatives];
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(props.defaultOpen);
  const c = options[sel];
  const KindIcon = KIND_ICON[c.spec.kind];
  const [targets, setTargets] = useState<Set<ClientId>>(() => defaultTargets(c.spec, props.clients));
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });

  const choose = (i: number) => {
    setSel(i);
    setTargets(defaultTargets(options[i].spec, props.clients));
    setPhase({ step: 'idle' });
  };

  const isMcp = c.spec.kind === 'mcp-local' || c.spec.kind === 'mcp-remote';
  const missing = isMcp ? missingInputs(c.spec as never, values) : [];
  const buildOnly = c.spec.kind === 'mcp-local' && c.spec.needsBuild;
  const canInstall = inTauri && targets.size > 0 && missing.length === 0 && !buildOnly && phase.step !== 'installing';

  async function run() {
    setPhase({ step: 'installing' });
    const outcome = await install(c, [...targets], values);
    setPhase({ step: 'done', results: outcome.results });
    props.onInstalled();
    const firstOk = outcome.results.find((r) => r.status === 'ok');
    if (outcome.raw && firstOk) {
      setPhase({ step: 'done', results: outcome.results, check: 'running' });
      const d = await verify(c, outcome.raw, firstOk.client);
      setPhase({ step: 'done', results: outcome.results, check: d });
    }
  }

  return (
    <article className={`card group ${open ? 'is-open' : ''}`} style={{ ['--i' as string]: props.index }}>
      <div className="group-head" onClick={() => setOpen(!open)}>
        <div className="tile">
          <KindIcon size={20} />
        </div>
        <div className="group-main">
          <div className="group-title">
            <span className="name">{c.title ?? c.name}</span>
            <span className="badge">{t(`kind.${c.spec.kind}`)}</span>
            {c.confidence === 'low' && <span className="badge">{t('card.unsure')}</span>}
            {phase.step === 'done' && phase.results.some((r) => r.status === 'ok') && <span className="badge badge--ink">{t('card.installed')}</span>}
          </div>
          {c.description && <p className="desc">{c.description}</p>}
          <Requirements spec={c.spec} />
        </div>
        <button className="chev" aria-expanded={open} aria-label={open ? t('common.collapse') : t('common.expand')}>
          <IconChevron size={16} />
        </button>
      </div>

      {open && (
        <div className="group-body">
          {options.length > 1 && (
            <div>
              <div className="field-label">{t('card.method')}</div>
              <div className="segmented">
                {methodLabels(options).map((l, i) => (
                  <button key={l} className={i === sel ? 'is-on' : ''} onClick={() => choose(i)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          )}

          {inputsOf(c.spec).length > 0 && (
            <div>
              <div className="field-label">{t('card.inputs')}</div>
              <div className="form">
                {inputsOf(c.spec).map((f) => (
                  <InputRow key={inputId(f)} field={f} value={values[inputId(f)] ?? ''} onChange={(v) => setValues({ ...values, [inputId(f)]: v })} />
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="field-label">{t('card.targets')}</div>
            <Targets spec={c.spec} clients={props.clients} value={targets} onChange={setTargets} />
          </div>

          <div>
            <div className="field-label">{c.spec.kind === 'mcp-remote' ? t('card.address') : c.spec.kind === 'mcp-local' ? t('card.command') : t('card.source')}</div>
            <CodeLine text={previewText(c.spec)} />
          </div>

          {c.warnings.map((w) => (
            <div key={w} className="warn">
              <IconAlert size={14} />
              <span>{w}</span>
            </div>
          ))}

          {phase.step === 'done' && <InstallReport results={phase.results} check={phase.check} />}

          <div className="foot">
            <span className="source">
              {!inTauri
                ? t('card.foot.needDesktop')
                : buildOnly
                  ? t('card.foot.build')
                  : missing.length
                    ? t('card.foot.missing', { n: missing.length })
                    : targets.size === 0
                      ? t('card.foot.noTarget')
                      : sourceLabel(c)}
            </span>
            <button className="btn-primary" disabled={!canInstall} onClick={run}>
              {phase.step === 'installing' ? (
                <>
                  <span className="spinner" /> {t('card.btn.installing')}
                </>
              ) : phase.step === 'done' ? (
                t('card.btn.reinstall')
              ) : (
                t('card.btn.install', { n: targets.size })
              )}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function InputRow({ field, value, onChange }: { field: InputField; value: string; onChange: (v: string) => void }) {
  const label = field.kind === 'path' ? t('form.pathLabel') : field.key;
  return (
    <label className="form-row">
      <span className="form-label">
        {field.secret ? <IconKey size={13} /> : field.kind === 'path' ? <IconFolder size={13} /> : <IconInfo size={13} />}
        {label}
        {field.required && <span className="req-star">{t('form.required')}</span>}
      </span>
      {field.description && <span className="form-help">{field.description}</span>}
      <span className="form-input">
        <input
          type={field.secret ? 'password' : 'text'}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={field.kind === 'path' ? t('form.pathPlaceholder') : field.secret ? t('form.secretPlaceholder') : ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {field.kind === 'path' && inTauri && (
          <button
            type="button"
            className="btn-small"
            onClick={async (e) => {
              e.preventDefault();
              const dir = await openDialog({ directory: true, multiple: false });
              if (typeof dir === 'string') onChange(dir);
            }}
          >
            {t('form.choose')}
          </button>
        )}
      </span>
    </label>
  );
}

function InstallReport({ results, check }: { results: TargetResult[]; check?: Diagnosis | 'running' }) {
  return (
    <div className="report">
      {results.map((r) => (
        <ReportRow key={r.client} r={r} />
      ))}
      {check === 'running' && (
        <div className="report-check">
          <span className="spinner spinner--muted" />
          {t('report.testing')}
        </div>
      )}
      {check && check !== 'running' && check.status === 'auth' && <SignInSteps results={results} service={check.service ?? ''} />}
      {check && check !== 'running' && check.status !== 'auth' && (
        <DiagnosisView diag={{ ...check, title: check.status === 'ok' ? t('report.testOk') : t('report.testBad', { title: check.title }) }} />
      )}
    </div>
  );
}

/** An online server that signs in with OAuth: one row per app it went into. */
function SignInSteps({ results, service }: { results: TargetResult[]; service: string }) {
  const rows = results.filter((r) => r.status === 'ok' && r.serverName);
  return (
    <div className="signin">
      <div className="signin-head">
        <div className="signin-title">
          <IconLock size={16} />
          {t('report.signInTitle', { service })}
        </div>
        <p className="signin-note">{t('diag.loginWhose', { service })}</p>
      </div>
      {rows.map((r) => (
        <SignInRow key={r.client} client={r.client} name={r.serverName!} service={service} />
      ))}
    </div>
  );
}

function SignInRow({ client, name, service }: { client: ClientId; name: string; service: string }) {
  const fromHere = SIGN_IN_CLIENTS.includes(client);
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const [msg, setMsg] = useState<string | null>(null);

  // Already signed in (e.g. installed again)?
  useEffect(() => {
    if (fromHere) appSignedIn(client, name).then((v) => v && setState('done'), () => {});
  }, [fromHere, client, name]);

  async function go() {
    setState('working');
    setMsg(null);
    const r = await signInOnce(client, name);
    if (!r.ok) {
      setState('idle');
      setMsg(r.message);
      return;
    }
    const signedIn = await appSignedIn(client, name).catch(() => null);
    if (signedIn === false) {
      setState('idle');
      setMsg(t('repair.signInNotYet'));
    } else setState('done');
  }

  return (
    <div className={`signin-row ${state === 'done' ? 'is-done' : ''}`}>
      <span className="signin-icon">{state === 'done' ? <IconCheckCircle size={16} /> : <IconLock size={16} />}</span>
      <div className="signin-main">
        <span className="signin-app">{clientLabel(client)}</span>
        <span className="signin-text">
          {state === 'done' ? t('diag.signedIn', { service }) : state === 'working' ? t('repair.signInWaiting') : (msg ?? signInHint(client, name, service))}
        </span>
      </div>
      {fromHere && state === 'idle' && (
        <button className="btn-small btn-small--ink" onClick={go}>
          {t('repair.signInTo', { service })}
        </button>
      )}
      {state === 'working' && (
        <button className="btn-small" onClick={() => void cancelSignIn()}>
          {t('common.cancel')}
        </button>
      )}
    </div>
  );
}

function ReportRow({ r }: { r: TargetResult }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const name = clientLabel(r.client);
  return (
    <div className={`report-row is-${r.status}`}>
      <span className="report-icon">{r.status === 'ok' ? <IconCheckCircle size={16} /> : r.status === 'error' ? <IconXCircle size={16} /> : <IconInfo size={16} />}</span>
      <div className="report-main">
        <div className="report-title">
          {name}
          <span className="report-msg">{r.message}</span>
        </div>
        {r.copyText && <CodeLine text={r.copyText} />}
        {msg && <div className="report-msg">{msg}</div>}
      </div>
      {r.restart && (
        <button
          className="btn-small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await restartApp(r.restart!);
              setMsg(t('report.restarted'));
            } catch (e) {
              setMsg(String(e));
            }
            setBusy(false);
          }}
        >
          {busy ? t('report.restarting') : t('report.restart')}
        </button>
      )}
    </div>
  );
}

function Requirements({ spec }: { spec: InstallSpec }) {
  const items: { icon: React.ReactNode; text: string }[] = [];
  if (spec.kind === 'mcp-local') {
    if (spec.runtime === 'node') items.push({ icon: <IconRuntime size={13} />, text: t('req.node') });
    if (spec.runtime === 'python') items.push({ icon: <IconRuntime size={13} />, text: t('req.python') });
    if (spec.runtime === 'docker') items.push({ icon: <IconPackage size={13} />, text: t('req.docker') });
  }
  for (const i of inputsOf(spec)) {
    if (i.kind === 'path') items.push({ icon: <IconFolder size={13} />, text: t('input.path') });
    else if (i.secret) items.push({ icon: <IconKey size={13} />, text: i.key });
    else items.push({ icon: <IconInfo size={13} />, text: i.key });
  }
  if (!items.length) return null;
  return (
    <div className="reqs">
      {items.map((it, i) => (
        <span key={i} className="req">
          {it.icon}
          {it.text}
        </span>
      ))}
    </div>
  );
}

function Targets(props: { spec: InstallSpec; clients: Set<ClientId>; value: Set<ClientId>; onChange: (v: Set<ClientId>) => void }) {
  const rows = supportFor(props.spec).filter((s) => s.mode !== 'unsupported' || props.clients.has(s.client));
  return (
    <div className="targets">
      {rows.map((s) => {
        const installed = props.clients.has(s.client);
        const usable = installed && s.mode !== 'unsupported';
        const on = props.value.has(s.client);
        const note = s.mode === 'unsupported' ? s.note : !installed ? t('target.missing') : s.mode === 'guided' ? t('target.guided') : t('target.direct');
        return (
          <button
            key={s.client}
            className={`target ${on ? 'is-on' : ''}`}
            disabled={!usable}
            title={s.note}
            onClick={() => {
              const next = new Set(props.value);
              if (on) next.delete(s.client);
              else next.add(s.client);
              props.onChange(next);
            }}
          >
            <span className="check">{on && <IconCheck size={11} />}</span>
            <span className="t-text">
              <span className="t-name">{clientLabel(s.client)}</span>
              <span className="t-note">{note}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CodeLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <code>{text}</code>
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

function formatCount(n: number): string {
  if (getLocale() !== 'zh') return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万`;
  return n.toLocaleString('zh-CN');
}

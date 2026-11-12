import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  afterInstallNote,
  clientLabel,
  configSyntaxError,
  looksSecret,
  skillLocationLabel,
  t,
  type ClientId,
  type InstalledServer,
  type InstalledSkill,
  type RawServerConfig,
  type RepairKind,
} from '@cradle/core';
import { nativeError, nativeIO, reveal, shortPath, writeConfig } from '../native';
import { writeServer } from '../repairer';
import type { HealthState } from '../health';
import { DiagnosisView, placeLabel } from '../ui';
import { IconChevron, IconFolder } from '../icons';

export type EditTarget =
  | { id: string; kind: 'skill'; skill: InstalledSkill }
  | { id: string; kind: 'server'; server: InstalledServer }
  | { id: string; kind: 'file'; path: string; client: ClientId };

const TEXT_EXT = /\.(md|markdown|txt|json|jsonc|ya?ml|toml|ini|cfg|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|rb|go|rs|html?|css|csv|xml|sql|env|example)$/i;

export const canEditConfigFile = (s: InstalledServer) => s.scope !== 'plugin' && !s.configPath.endsWith('/.claude.json');

export function EditorPage(props: {
  target: EditTarget;
  onBack: () => void;
  onSaved: (keys: string[], kind?: RepairKind) => void;
  onReload: () => Promise<unknown>;
  health?: HealthState;
  onEdit?: (t: EditTarget) => void;
}) {
  const { target } = props;
  if (target.kind === 'server') return <ServerEditor {...props} server={target.server} />;
  if (target.kind === 'skill') return <SkillEditor {...props} skill={target.skill} />;
  return <FileEditor {...props} path={target.path} client={target.client} />;
}

function Header(props: { title: string; subtitle?: string; dirty: boolean; onBack: () => void; actions?: React.ReactNode }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <header className="editor-head">
      <button
        className={`back ${confirm ? 'is-danger' : ''}`}
        onClick={() => (props.dirty && !confirm ? setConfirm(true) : props.onBack())}
        onBlur={() => setConfirm(false)}
      >
        <IconChevron size={16} />
        {confirm ? t('editor.discard') : t('editor.back')}
      </button>
      <div className="editor-title">
        <h1>
          {props.title}
          {props.dirty && <span className="dirty-dot" title={t('editor.unsaved')} />}
        </h1>
        {props.subtitle && <p className="selectable">{props.subtitle}</p>}
      </div>
      <div className="page-actions">{props.actions}</div>
    </header>
  );
}

function Status({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <div className={`repair-msg ${msg.ok ? '' : 'is-error'}`}>{msg.text}</div>;
}

/** Plain-text editor: Tab inserts spaces, ⌘S saves. */
function TextArea(props: { value: string; onChange: (v: string) => void; onSave: () => void; readOnly?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lines = props.value.split('\n').length;
  return (
    <div className="text-editor">
      <textarea
        ref={ref}
        className="selectable"
        spellCheck={false}
        readOnly={props.readOnly}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            props.onSave();
          } else if (e.key === 'Tab' && !props.readOnly) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            const next = props.value.slice(0, a) + '  ' + props.value.slice(b);
            props.onChange(next);
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
          }
        }}
      />
      <div className="editor-foot">
        <span>{t('editor.lines', { n: lines })}</span>
        {!props.readOnly && <span>{t('editor.shortcut')}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills

interface SkillFile {
  path: string;
  rel: string;
}

async function listSkillFiles(dir: string): Promise<SkillFile[]> {
  const io = await nativeIO();
  const out: SkillFile[] = [];
  const walk = async (path: string, rel: string, depth: number) => {
    if (depth > 3 || out.length > 200) return;
    for (const e of await io.listDir(path)) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDir) await walk(`${path}/${e.name}`, childRel, depth + 1);
      else if (TEXT_EXT.test(e.name) || !e.name.includes('.')) out.push({ path: `${path}/${e.name}`, rel: childRel });
    }
  };
  await walk(dir, '', 0);
  return out.sort((a, b) => (a.rel === 'SKILL.md' ? -1 : b.rel === 'SKILL.md' ? 1 : a.rel.localeCompare(b.rel)));
}

function SkillEditor(props: { skill: InstalledSkill; onBack: () => void; onReload: () => Promise<unknown> }) {
  const { skill } = props;
  const readOnly = !skill.removable; // account-synced or plugin skills
  const [files, setFiles] = useState<SkillFile[] | null>(null);
  const [current, setCurrent] = useState<string>(`${skill.dir}/SKILL.md`);
  const [text, setText] = useState('');
  const [original, setOriginal] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = text !== original;

  useEffect(() => {
    listSkillFiles(skill.dir).then(setFiles).catch(() => setFiles([]));
  }, [skill.dir]);

  useEffect(() => {
    let alive = true;
    nativeIO()
      .then((io) => io.readTexts([current]))
      .then(([c]) => {
        if (!alive) return;
        setText(c ?? '');
        setOriginal(c ?? '');
        setMsg(c == null ? { ok: false, text: t('editor.binary') } : null);
      });
    return () => {
      alive = false;
    };
  }, [current]);

  async function save() {
    if (!dirty || readOnly || saving) return;
    setSaving(true);
    try {
      await invoke('write_skill_file', { path: current, content: text });
      setOriginal(text);
      setMsg({ ok: true, text: t('editor.skillSaved') });
      props.onReload();
    } catch (e) {
      setMsg({ ok: false, text: nativeError(e) });
    }
    setSaving(false);
  }

  return (
    <div className="page page--wide">
      <Header
        title={skill.name}
        subtitle={shortPath(skill.isSymlink && skill.linkTarget ? skill.linkTarget : skill.dir)}
        dirty={dirty}
        onBack={props.onBack}
        actions={
          <>
            <button className="btn-quiet" onClick={() => reveal(current)}>
              <IconFolder size={14} />
              {t('installed.showFile')}
            </button>
            {!readOnly && (
              <>
                <button className="btn-quiet" disabled={!dirty} onClick={() => setText(original)}>
                  {t('editor.revert')}
                </button>
                <button className="btn-primary" disabled={!dirty || saving} onClick={save}>
                  {saving ? t('editor.saving') : t('editor.save')}
                </button>
              </>
            )}
          </>
        }
      />
      {readOnly && <div className="note">{skill.location === 'synced' ? t('editor.readOnlySynced') : t('editor.readOnlyPlugin')}</div>}
      {skill.isSymlink && <div className="note">{t('editor.linkNote', { place: skillLocationLabel(skill.location) })}</div>}
      {files && files.length > 1 && (
        <div className="file-tabs">
          {files.map((f) => (
            <button
              key={f.path}
              className={f.path === current ? 'is-on' : ''}
              onClick={() => {
                if (dirty) {
                  setMsg({ ok: false, text: t('editor.unsavedSwitch') });
                  return;
                }
                setCurrent(f.path);
              }}
            >
              {f.rel}
            </button>
          ))}
        </div>
      )}
      <Status msg={msg} />
      <TextArea value={text} onChange={setText} onSave={save} readOnly={readOnly} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP server (form)

type Row = { key: string; value: string; show: boolean };
const toRows = (o: Record<string, string>): Row[] => Object.entries(o).map(([key, value]) => ({ key, value, show: false }));
const fromRows = (rows: Row[]) => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

function Rows(props: { rows: Row[]; onChange: (r: Row[]) => void; readOnly?: boolean }) {
  const set = (i: number, patch: Partial<Row>) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv">
      {props.rows.map((r, i) => {
        const secret = looksSecret(r.key) || /^(Bearer|Token|Basic)\s/i.test(r.value);
        return (
          <div key={i} className="kv-row">
            <span className="form-input kv-key">
              <input value={r.key} placeholder={t('editor.key')} spellCheck={false} readOnly={props.readOnly} onChange={(e) => set(i, { key: e.target.value })} />
            </span>
            <span className="form-input kv-value">
              <input
                type={secret && !r.show ? 'password' : 'text'}
                value={r.value}
                placeholder={t('editor.value')}
                spellCheck={false}
                autoComplete="off"
                readOnly={props.readOnly}
                onChange={(e) => set(i, { value: e.target.value })}
              />
              {secret && (
                <button type="button" className="btn-small" onClick={() => set(i, { show: !r.show })}>
                  {r.show ? t('editor.hide') : t('editor.show')}
                </button>
              )}
            </span>
            {!props.readOnly && (
              <button type="button" className="btn-small" onClick={() => props.onChange(props.rows.filter((_, j) => j !== i))}>
                {t('editor.remove')}
              </button>
            )}
          </div>
        );
      })}
      {!props.readOnly && (
        <button type="button" className="btn-small kv-add" onClick={() => props.onChange([...props.rows, { key: '', value: '', show: true }])}>
          {t('editor.addRow')}
        </button>
      )}
    </div>
  );
}

function ServerEditor(props: {
  server: InstalledServer;
  onBack: () => void;
  onSaved: (keys: string[], kind?: RepairKind) => void;
  health?: HealthState;
  onEdit?: (t: EditTarget) => void;
}) {
  const s = props.server;
  const readOnly = s.scope === 'plugin' || s.scope === 'extension';
  const remote = !s.raw.command && !!s.raw.url;
  const [command, setCommand] = useState(s.raw.command ?? '');
  const [args, setArgs] = useState(s.raw.args.join('\n'));
  const [env, setEnv] = useState<Row[]>(toRows(s.raw.env));
  const [url, setUrl] = useState(s.raw.url ?? '');
  const [headers, setHeaders] = useState<Row[]>(toRows(s.raw.headers));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  const next: RawServerConfig = useMemo(
    () =>
      remote
        ? { ...s.raw, url: url.trim(), headers: fromRows(headers) }
        : { ...s.raw, command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean), env: fromRows(env) },
    [remote, s.raw, url, headers, command, args, env],
  );
  const dirty = JSON.stringify(next) !== JSON.stringify(s.raw);
  const invalid = remote ? (!/^https?:\/\/\S+$/.test(next.url ?? '') ? t('editor.needUrl') : null) : !next.command ? t('editor.needCommand') : null;
  const diag = props.health?.results[s.key];

  async function save() {
    if (!dirty || invalid || readOnly || saving) return;
    setSaving(true);
    try {
      await writeServer(s, next);
      const note = afterInstallNote(s.client).text;
      setMsg({ ok: true, text: `${t('editor.serverSaved')}${note ? ' · ' + note : ''}` });
      setSavedOnce(true);
      props.onSaved([s.key]);
    } catch (e) {
      setMsg({ ok: false, text: nativeError(e) });
    }
    setSaving(false);
  }

  return (
    <div className="page">
      <Header
        title={s.name}
        subtitle={`${placeLabel(s)} · ${shortPath(s.configPath)}`}
        dirty={dirty && !savedOnce}
        onBack={props.onBack}
        actions={
          <>
            {canEditConfigFile(s) && props.onEdit && (
              <button className="btn-quiet" onClick={() => props.onEdit!({ id: `file:${s.configPath}`, kind: 'file', path: s.configPath, client: s.client })}>
                {t('editor.wholeFile')}
              </button>
            )}
            {!readOnly && (
              <button className="btn-primary" disabled={!dirty || !!invalid || saving} onClick={save}>
                {saving ? t('editor.saving') : t('editor.save')}
              </button>
            )}
          </>
        }
      />
      {readOnly && <div className="note">{t('editor.readOnlyPluginServer')}</div>}
      {s.configPath.endsWith('/.claude.json') && <div className="note">{t('editor.claudeJsonNote')}</div>}
      <Status msg={msg} />
      {diag && savedOnce && <DiagnosisView diag={diag} onRetry={() => props.health?.runOne(s)} />}

      <div className="card form-card">
        {remote ? (
          <>
            <label className="form-row">
              <span className="form-label">{t('editor.url')}</span>
              <span className="form-input">
                <input value={url} spellCheck={false} readOnly={readOnly} onChange={(e) => setUrl(e.target.value)} />
              </span>
            </label>
            <div className="form-row">
              <span className="form-label">{t('editor.headers')}</span>
              <Rows rows={headers} onChange={setHeaders} readOnly={readOnly} />
            </div>
          </>
        ) : (
          <>
            <label className="form-row">
              <span className="form-label">{t('editor.command')}</span>
              <span className="form-input">
                <input value={command} spellCheck={false} readOnly={readOnly} onChange={(e) => setCommand(e.target.value)} />
              </span>
            </label>
            <label className="form-row">
              <span className="form-label">{t('editor.args')}</span>
              <textarea className="form-area selectable" rows={Math.max(3, args.split('\n').length)} value={args} spellCheck={false} readOnly={readOnly} onChange={(e) => setArgs(e.target.value)} />
            </label>
            <div className="form-row">
              <span className="form-label">{t('editor.env')}</span>
              <Rows rows={env} onChange={setEnv} readOnly={readOnly} />
            </div>
          </>
        )}
        {invalid && dirty && <div className="hint-line is-error">{invalid}</div>}
        {!readOnly && <div className="hint-line">{t('editor.saveNote', { app: clientLabel(s.client) })}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Whole config file

function FileEditor(props: { path: string; client: ClientId; onBack: () => void; onReload: () => Promise<unknown> }) {
  const [text, setText] = useState('');
  const [original, setOriginal] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = text !== original;
  const toml = props.path.endsWith('.toml');

  useEffect(() => {
    nativeIO()
      .then((io) => io.readTexts([props.path]))
      .then(([c]) => {
        setText(c ?? '');
        setOriginal(c ?? '');
        setLoaded(true);
      });
  }, [props.path]);

  const error = useMemo(() => configSyntaxError(text, toml ? 'toml' : 'json'), [text, toml]);

  async function save() {
    if (!dirty || error || saving) return;
    setSaving(true);
    try {
      await writeConfig(props.path, text);
      setOriginal(text);
      const note = afterInstallNote(props.client).text;
      setMsg({ ok: true, text: `${t('editor.saved')}${note ? ' · ' + note : ''}` });
      props.onReload();
    } catch (e) {
      setMsg({ ok: false, text: nativeError(e) });
    }
    setSaving(false);
  }

  return (
    <div className="page page--wide">
      <Header
        title={props.path.split('/').pop() ?? props.path}
        subtitle={`${clientLabel(props.client)} · ${shortPath(props.path)}`}
        dirty={dirty}
        onBack={props.onBack}
        actions={
          <>
            <button className="btn-quiet" disabled={!dirty} onClick={() => setText(original)}>
              {t('editor.revert')}
            </button>
            <button className="btn-primary" disabled={!dirty || !!error || saving} onClick={save}>
              {saving ? t('editor.saving') : t('editor.save')}
            </button>
          </>
        }
      />
      {error && <div className="warn">{error}</div>}
      <Status msg={msg} />
      {loaded ? <TextArea value={text} onChange={setText} onSave={save} /> : <div className="hint-line">{t('editor.loading')}</div>}
    </div>
  );
}

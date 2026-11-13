import { useEffect, useRef, useState } from 'react';
import { detect, t, type ClientId, type DetectResult } from '@cradler-desktop/core';
import { Results } from '../Results';
import { IconArrowUp } from '../icons';

/**
 * Recommended extensions, installed through the same detection as a pasted link. Each value is the
 * input that detects to exactly one clean item. `ours` = made by the people behind this app, and the
 * card says so.
 */
const PICKS: { id: string; name?: string; value: string; ours?: boolean }[] = [
  { id: 'apimodels', name: 'apimodels', value: 'https://api.apimodels.app/mcp', ours: true },
  { id: 'cradler', name: 'Cradler', value: 'https://github.com/cradler-ai/mcp', ours: true },
  { id: 'playwright', name: 'Playwright', value: 'https://github.com/microsoft/playwright-mcp' },
  { id: 'context7', name: 'Context7', value: 'https://mcp.context7.com/mcp' },
  { id: 'notion', name: 'Notion', value: 'https://mcp.notion.com/mcp' },
  { id: 'pptx', value: 'https://github.com/anthropics/skills/tree/main/skills/pptx' },
];

type State =
  | { status: 'idle' }
  | { status: 'loading'; input: string }
  | { status: 'done'; input: string; result: DetectResult };

export function InstallPage(props: {
  clients: Set<ClientId>;
  initialQuery?: string | null;
  resetSignal: number;
  onCompactChange: (c: boolean) => void;
  onInstalled: () => void;
}) {
  const [text, setText] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const runId = useRef(0);

  async function run(value = text) {
    const input = value.trim();
    if (!input) return;
    const id = ++runId.current;
    setText(input);
    setState({ status: 'loading', input });
    const result = await detect(input);
    if (id === runId.current) setState({ status: 'done', input, result });
    if (new URLSearchParams(window.location.search).get('focus') === '1' && '__TAURI_INTERNALS__' in window)
      import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().setFocus());
  }

  useEffect(() => {
    if (props.initialQuery) run(props.initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clicking "Install" in the sidebar again goes back to the empty box.
  useEffect(() => {
    if (!props.resetSignal) return;
    runId.current++;
    setText('');
    setState({ status: 'idle' });
  }, [props.resetSignal]);

  const compact = state.status !== 'idle';
  useEffect(() => props.onCompactChange(compact), [compact]);

  return (
    <>
      {!compact && (
        <header className="hero">
          <h1>{t('install.hero.title')}</h1>
          <p>{t('install.hero.sub')}</p>
        </header>
      )}

      <InputBox value={text} onChange={setText} onSubmit={run} busy={state.status === 'loading'} autoFocus={!compact} />

      {!compact && (
        <section className="picks" aria-label={t('picks.title')}>
          <div className="picks-label">{t('picks.title')}</div>
          <div className="picks-grid">
            {PICKS.map((p) => (
              <button key={p.id} className="pick" onClick={() => run(p.value)}>
                <span className="pick-head">
                  <span className="pick-name">{p.name ?? t(`picks.${p.id}.name`)}</span>
                  {p.ours && <span className="pick-ours">{t('picks.ours')}</span>}
                </span>
                <span className="pick-desc">{t(`picks.${p.id}`)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {state.status === 'loading' && <Loading input={state.input} />}
      {state.status === 'done' && <Results key={state.input} result={state.result} clients={props.clients} onInstalled={props.onInstalled} />}
    </>
  );
}

function InputBox(props: { value: string; onChange: (v: string) => void; onSubmit: (v?: string) => void; busy: boolean; autoFocus: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [props.value]);

  return (
    <div className="input-wrap">
      <div className="input">
        <textarea
          ref={ref}
          rows={1}
          value={props.value}
          autoFocus={props.autoFocus}
          spellCheck={false}
          placeholder={t('install.placeholder')}
          onChange={(e) => props.onChange(e.target.value)}
          onPaste={(e) => {
            // Pasting into an empty box starts right away.
            const pasted = e.clipboardData.getData('text');
            if (!props.value.trim() && pasted.trim()) {
              e.preventDefault();
              props.onSubmit(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <button className="send" disabled={!props.value.trim() || props.busy} onClick={() => props.onSubmit()} aria-label={t('install.go')}>
          {props.busy ? <span className="spinner" /> : <IconArrowUp size={16} />}
        </button>
      </div>
    </div>
  );
}

function Loading({ input }: { input: string }) {
  const isRepo = /github\.com|^[\w.-]+\/[\w.-]+$/.test(input);
  return (
    <div className="results">
      <div className="loading-text">
        <span className="spinner spinner--muted" />
        {isRepo ? t('install.loadingRepo') : t('install.loading')}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton" style={{ ['--i' as string]: i }} />
      ))}
    </div>
  );
}

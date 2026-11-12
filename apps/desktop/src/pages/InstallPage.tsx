import { useEffect, useRef, useState } from 'react';
import { detect, t, type ClientId, type DetectResult } from '@cradler-desktop/core';
import { Results } from '../Results';
import { IconArrowUp } from '../icons';

const EXAMPLES = [
  { label: 'microsoft/playwright-mcp', value: 'https://github.com/microsoft/playwright-mcp' },
  { label: 'anthropics/skills', value: 'https://github.com/anthropics/skills' },
  { label: 'claude mcp add … sentry', value: 'claude mcp add --transport http sentry https://mcp.sentry.dev/mcp' },
  { label: 'npx -y firecrawl-mcp', value: 'npx -y firecrawl-mcp' },
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
        <div className="examples">
          {EXAMPLES.map((e) => (
            <button key={e.label} className="chip" onClick={() => run(e.value)}>
              {e.label}
            </button>
          ))}
        </div>
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

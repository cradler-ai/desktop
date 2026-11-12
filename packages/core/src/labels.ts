// Plain-language descriptions for the UI (localized).
import type { Candidate, InputField, InstallSpec } from './types';
import { t } from './i18n';

export const kindLabel = (spec: InstallSpec): string => t(`kind.${spec.kind}`);
export const kindExplain = (spec: InstallSpec): string => t(`kindExplain.${spec.kind}`);

/** What the user needs before it can run. */
export function requirements(spec: InstallSpec): string[] {
  const out: string[] = [];
  if (spec.kind === 'mcp-local') {
    if (spec.needsBuild) out.push(t('req.build'));
    else if (spec.runtime === 'node') out.push(t('req.node'));
    else if (spec.runtime === 'python') out.push(t('req.python'));
    else if (spec.runtime === 'docker') out.push(t('req.docker'));
  }
  for (const i of inputsOf(spec).filter((x) => x.required)) out.push(inputLabel(i));
  return out;
}

export function inputsOf(spec: InstallSpec): InputField[] {
  return 'inputs' in spec ? spec.inputs : [];
}

export function inputLabel(i: InputField): string {
  if (i.kind === 'path') return t('input.path');
  if (i.secret) return t('input.secret', { key: i.key });
  return t('input.text', { key: i.key });
}

export function sourceLabel(c: Candidate): string {
  const via = new Set(c.evidence.map((e) => e.via));
  if (via.has('user-input')) return t('source.user');
  if (via.has('server.json')) return t('source.registry');
  if (via.has('marketplace.json') || via.has('plugin.json')) return t('source.plugin');
  if (via.has('SKILL.md')) return t('source.skill');
  if (via.has('deeplink')) return t('source.deeplink');
  if (via.has('readme-config') || via.has('readme-command')) return t('source.readme');
  return t('source.inferred');
}

/** The command line / URL shown in the details. */
export function previewText(spec: InstallSpec): string {
  switch (spec.kind) {
    case 'mcp-local':
      return [spec.command, ...spec.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ');
    case 'mcp-remote':
      return spec.url;
    case 'skill':
      return `github.com/${spec.source.owner}/${spec.source.repo}${spec.dir ? '/' + spec.dir : ''}`;
    case 'plugin':
      return spec.marketplace?.source ? `${spec.plugin}@${spec.marketplace.name ?? spec.marketplace.source}` : spec.plugin;
    case 'mcpb':
      return spec.downloadUrl ?? spec.manifestPath ?? '';
  }
}

import type { InstallSpec } from './types';
import { t } from './i18n';

export type ClientId = 'claude-desktop' | 'claude-code' | 'cursor' | 'codex' | 'gemini' | 'chatgpt' | 'cherry-studio';

const IDS: ClientId[] = ['claude-desktop', 'claude-code', 'cursor', 'codex', 'gemini', 'chatgpt', 'cherry-studio'];

/** `name` follows the current locale. */
export const CLIENTS: { id: ClientId; readonly name: string }[] = IDS.map((id) => ({
  id,
  get name() {
    return t(`client.${id}`);
  },
}));

export const clientLabel = (id: ClientId | string) => t(`client.${id}`);

export interface ClientSupport {
  client: ClientId;
  /** direct: we write it for you · guided: one manual step in the app · unsupported: can't be used there */
  mode: 'direct' | 'guided' | 'unsupported';
  note?: string;
}

const S = (client: ClientId, mode: ClientSupport['mode'], note?: string): ClientSupport => ({ client, mode, note });

export function supportFor(spec: InstallSpec): ClientSupport[] {
  switch (spec.kind) {
    case 'mcp-local':
      return [
        S('claude-desktop', 'direct'),
        S('claude-code', 'direct'),
        S('cursor', 'direct'),
        S('codex', 'direct'),
        S('gemini', 'direct'),
        S('cherry-studio', 'guided', t('support.cherryPaste')),
        S('chatgpt', 'unsupported', t('support.chatgptRemoteOnly')),
      ];
    case 'mcp-remote':
      return [
        S('claude-code', 'direct'),
        S('cursor', 'direct'),
        S('codex', 'direct'),
        S('gemini', 'direct'),
        S('claude-desktop', 'guided', t('support.desktopConnectors')),
        S('chatgpt', 'guided', t('support.chatgptDevMode')),
        S('cherry-studio', 'guided', t('support.cherryPaste')),
      ];
    case 'skill':
      return [
        S('claude-code', 'direct'),
        S('codex', 'direct'),
        S('claude-desktop', 'guided', t('support.desktopSkillUpload')),
        S('cursor', 'unsupported', t('support.noSkills', { app: 'Cursor' })),
        S('chatgpt', 'unsupported', t('support.noSkills', { app: 'ChatGPT' })),
      ];
    case 'plugin':
      return [
        S('claude-code', 'direct'),
        S('claude-desktop', 'guided', t('support.desktopPlugin')),
        S('cursor', 'unsupported', t('support.claudePluginOnly')),
        S('codex', 'unsupported', t('support.claudePluginOnly')),
      ];
    case 'mcpb':
      return [
        S('claude-desktop', 'direct'),
        S('claude-code', 'unsupported', t('support.mcpbDesktopOnly')),
        S('cursor', 'unsupported', t('support.mcpbDesktopOnly')),
      ];
  }
}

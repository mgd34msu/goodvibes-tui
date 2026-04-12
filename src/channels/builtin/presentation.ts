import type { ChannelRenderPolicy, ChannelSurface } from '../types.ts';

export function renderBuiltinPolicy(surface: ChannelSurface): ChannelRenderPolicy {
  const base = {
    surface,
    maxEventsPerUpdate: 16,
    metadata: { builtIn: true },
  };
  switch (surface) {
    case 'tui':
      return { ...base, reasoningVisibility: 'public', format: 'markdown', supportsThreads: true, maxChunkChars: 8_000 };
    case 'web':
      return { ...base, reasoningVisibility: 'summary', format: 'markdown', supportsThreads: true, maxChunkChars: 8_000 };
    case 'slack':
    case 'discord':
    case 'telegram':
    case 'google-chat':
    case 'msteams':
    case 'mattermost':
    case 'matrix':
      return {
        ...base,
        reasoningVisibility: 'summary',
        format: 'markdown',
        supportsThreads: surface !== 'telegram',
        maxChunkChars: surface === 'slack' || surface === 'discord' ? 2_500 : 3_500,
      };
    case 'ntfy':
      return { ...base, reasoningVisibility: 'suppress', format: 'plain', supportsThreads: false, maxChunkChars: 1_600 };
    case 'webhook':
      return { ...base, reasoningVisibility: 'private', format: 'json', supportsThreads: false, maxChunkChars: 12_000 };
    case 'signal':
    case 'whatsapp':
    case 'imessage':
    case 'bluebubbles':
      return { ...base, reasoningVisibility: 'summary', format: 'plain', supportsThreads: false, maxChunkChars: 3_500 };
  }
}

export function surfaceLabelForBuiltin(surface: ChannelSurface): string {
  switch (surface) {
    case 'tui':
      return 'Terminal UI';
    case 'web':
      return 'Web control plane';
    case 'slack':
      return 'Slack';
    case 'discord':
      return 'Discord';
    case 'ntfy':
      return 'ntfy';
    case 'webhook':
      return 'Generic webhook';
    case 'telegram':
      return 'Telegram';
    case 'google-chat':
      return 'Google Chat';
    case 'signal':
      return 'Signal';
    case 'whatsapp':
      return 'WhatsApp';
    case 'imessage':
      return 'iMessage';
    case 'msteams':
      return 'Microsoft Teams';
    case 'bluebubbles':
      return 'BlueBubbles';
    case 'mattermost':
      return 'Mattermost';
    case 'matrix':
      return 'Matrix';
  }
}

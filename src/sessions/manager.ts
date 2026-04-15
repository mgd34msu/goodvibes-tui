export type {
  SessionInfo,
  SessionMeta,
} from '@pellux/goodvibes-sdk/platform/sessions/manager';

import { SessionManager as SdkSessionManager } from '@pellux/goodvibes-sdk/platform/sessions/manager';

export class SessionManager extends SdkSessionManager {
  constructor(baseDir: string) {
    super(baseDir, {
      surfaceRoot: 'tui',
    });
  }
}

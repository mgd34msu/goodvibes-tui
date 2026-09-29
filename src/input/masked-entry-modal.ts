/**
 * masked-entry-modal.ts, the local-auth password prompt as a kit modal.
 *
 * `/local-auth add-user <name>` and `/local-auth rotate-password <name>` with
 * no password argument, and the Local Auth modal's a / p actions, open this.
 * It is the only way to set a local password that keeps the plaintext out of
 * argv, input history, the transcript and scrollback: keystrokes land in a
 * private buffer that is never rendered (the row shows dots), and the buffer
 * is dropped before the auth call runs, so it never outlives the attempt.
 */

import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { SurfaceModal, SurfaceModalHost } from './surface-modal-host.ts';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';
import { renderMaskedEntryModal, type MaskedEntryView } from '../renderer/masked-entry-modal.ts';
import { isTextBackspace } from './delete-key-policy.ts';

export type MaskedEntryKind = 'add-user' | 'rotate-password';

export interface MaskedEntryOptions {
  readonly kind: MaskedEntryKind;
  /** The user; for add-user it may be empty, and the modal asks for it first. */
  readonly username?: string;
  readonly auth: Pick<UserAuthManager, 'addUser' | 'rotatePassword'>;
  /** Report the outcome (never includes the password). */
  readonly onDone?: (message: string) => void;
}

/** Printable characters of a text token (control characters are dropped). */
function printable(text: string): string {
  return [...text].filter((ch) => ch >= ' ' && ch !== '\x7f').join('');
}

export class MaskedEntryModal implements SurfaceModal, MaskedEntryView {
  readonly name = 'masked-entry';
  readonly kind: MaskedEntryKind;
  username: string;
  step: 'username' | 'password';
  error: string | null = null;
  /** The password being typed. Private, never rendered, cleared on submit, cancel and close. */
  private buffer = '';

  constructor(private readonly options: MaskedEntryOptions) {
    this.kind = options.kind;
    this.username = (options.username ?? '').trim();
    this.step = this.kind === 'add-user' && this.username.length === 0 ? 'username' : 'password';
  }

  get passwordLength(): number {
    return [...this.buffer].length;
  }

  onClose(): void {
    this.buffer = '';
  }

  escape(): boolean {
    // Esc from the password step of a new user goes back to the username.
    if (this.step === 'password' && this.kind === 'add-user' && !this.options.username) {
      this.buffer = '';
      this.error = null;
      this.step = 'username';
      return true;
    }
    return false;
  }

  private submit(host: SurfaceModalHost): void {
    if (this.step === 'username') {
      if (this.username.length === 0) return;
      this.step = 'password';
      this.error = null;
      return;
    }
    if (this.buffer.length === 0) return;
    const password = this.buffer;
    // Drop the secret before the call so it never lingers after an exception.
    this.buffer = '';
    try {
      if (this.kind === 'add-user') {
        const added = this.options.auth.addUser(this.username, password, ['admin']);
        host.close(this, 'done');
        this.options.onDone?.(`Added local auth user ${added.username}.`);
      } else {
        this.options.auth.rotatePassword(this.username, password);
        host.close(this, 'done');
        this.options.onDone?.(`Rotated the password for ${this.username}. Existing sessions were revoked.`);
      }
    } catch (error) {
      this.error = summarizeError(error);
    }
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    if (token.type === 'text') {
      const text = printable(token.value);
      if (!text) return;
      if (this.step === 'username') this.username += text.replace(/\s+/g, '');
      else this.buffer += text;
      this.error = null;
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (key === 'enter') this.submit(host);
    else if (isTextBackspace(key)) {
      if (this.step === 'username') this.username = this.username.slice(0, -1);
      else this.buffer = [...this.buffer].slice(0, -1).join('');
    }
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderMaskedEntryModal(this, screenWidth, screenHeight);
  }
}

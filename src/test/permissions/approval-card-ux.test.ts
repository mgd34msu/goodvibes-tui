/**
 * Approval card UX (SDK remember tiers, colored diff, full wrapped command,
 * deny-with-reason typing, exec-prompt answering, honest queue count):
 *
 *  - the SDK's rememberOptions tiers render as numbered one-key choices and
 *    the matching key resolves with that tier;
 *  - write/edit asks show a real colored diff through the diff-view
 *    machinery; execute asks render the FULL command wrapped, never
 *    truncated (verified at 80 and 60 columns);
 *  - typing while the card is up becomes deny-with-reason (Enter sends the
 *    reason as feedback, without aborting the turn); Ctrl+C stays the hard
 *    abort; an exec-prompt ask opens in answer mode and the typed answer
 *    rides the decision's modifiedArgs;
 *  - the card names how many other broker asks are waiting;
 *  - getPromptHeight matches createPromptLines for every new card shape.
 */
import { describe, expect, test } from 'bun:test';
import type { PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { PermissionPromptUI, type PromptViewState } from '../../permissions/prompt.ts';
import { buildPendingPermissionExtras } from '../../permissions/hunk-selection.ts';
import { handleBlockingShellInput, type PendingPermissionState } from '../../shell/blocking-input.ts';

const WIDTH = 80;

function lineText(line: { char?: string }[]): string {
  return line.map((cell) => cell.char ?? ' ').join('');
}

function cardText(lines: { char?: string }[][]): string[] {
  return lines.map(lineText);
}

const REMEMBER_OPTIONS = [
  { tier: 'exact', label: 'this exact command', detail: 'git push origin main' },
  { tier: 'command-class', label: 'this command class', detail: 'git push …' },
  { tier: 'tool', label: 'every Bash command', detail: 'all runs of Bash' },
  { tier: 'session', label: 'everything this session', detail: 'until this session ends' },
] as const;

function makeExecRequest(overrides: Partial<PermissionPromptRequest> = {}): PermissionPromptRequest {
  return {
    callId: 'call-1',
    tool: 'Bash',
    args: { command: 'git push origin main' },
    category: 'execute',
    ...overrides,
  } as PermissionPromptRequest;
}

function makePending(
  request: PermissionPromptRequest,
  onDecision: (decision: Record<string, unknown>) => void,
  now = 10_000,
): PendingPermissionState {
  return {
    ...request,
    ...buildPendingPermissionExtras(request, (decision) => onDecision(decision as Record<string, unknown>), null, now),
  } as PendingPermissionState;
}

const HANDLER_STUBS = {
  recoveryPending: false,
  conversation: {} as never,
  systemMessageRouter: {} as never,
  loadRecoveryConversation: () => null,
  deleteRecoveryFile: () => {},
  homeDirectory: '/tmp',
  sessionId: 'test-session',
  persistSnapshot: () => {},
};

function press(
  pending: PendingPermissionState | null,
  data: string,
  hooks: { abort?: () => void } = {},
): ReturnType<typeof handleBlockingShellInput> {
  return handleBlockingShellInput({
    data,
    pendingPermission: pending,
    abortTurn: hooks.abort ?? (() => {}),
    render: () => {},
    now: 100_000, // far past the debounce window
    ...HANDLER_STUBS,
  });
}

describe('remember tiers as one-key choices', () => {
  const request = makeExecRequest({ rememberOptions: REMEMBER_OPTIONS as never });

  test('the card renders one numbered row per tier (full strings, 80 cols)', () => {
    const lines = cardText(PermissionPromptUI.createPromptLines(WIDTH, request as never));
    const rememberRows = lines.filter((t) => /\[\d\]/.test(t));
    expect(rememberRows.map((t) => t.trimEnd())).toEqual([
      '   Remember : [1] this exact command — git push origin main',
      '            : [2] this command class — git push …',
      '            : [3] every Bash command — all runs of Bash',
      '            : [4] everything this session — until this session ends',
    ]);
    expect(lines.some((t) => t.includes('[Y] Allow once    [1-4] Allow + remember    [N] Deny    type a reason to deny'))).toBe(true);
  });

  test('pressing a tier number approves and remembers at that tier', () => {
    const decisions: Record<string, unknown>[] = [];
    const pending = makePending(request, (d) => decisions.push(d));
    const result = press(pending, '2');
    expect(result.pendingPermission).toBeNull();
    expect(decisions).toEqual([{ approved: true, remember: false, modifiedArgs: undefined, rememberTier: 'command-class' }]);
  });

  test('the session tier sets the legacy remember flag too', () => {
    const decisions: Record<string, unknown>[] = [];
    const pending = makePending(request, (d) => decisions.push(d));
    press(pending, '4');
    expect(decisions).toEqual([{ approved: true, remember: true, modifiedArgs: undefined, rememberTier: 'session' }]);
  });

  test('[a] stays the session-tier alias', () => {
    const decisions: Record<string, unknown>[] = [];
    const pending = makePending(request, (d) => decisions.push(d));
    press(pending, 'a');
    expect(decisions).toEqual([{ approved: true, remember: true, modifiedArgs: undefined, rememberTier: 'session' }]);
  });

  test('a digit past the tier list resolves nothing', () => {
    const decisions: Record<string, unknown>[] = [];
    const pending = makePending(request, (d) => decisions.push(d));
    const result = press(pending, '9');
    expect(decisions).toEqual([]);
    expect(result.pendingPermission).not.toBeNull();
  });
});

describe('full command rendering — wrapped, never truncated', () => {
  const longCommand = `git commit --no-verify -m "adopt the pricing resolver and the durable approval rules across every cost surface" && git push origin feature/approval-ux-and-pricing --force-with-lease`;
  const request = makeExecRequest({ args: { command: longCommand } });

  for (const width of [80, 60]) {
    test(`${width} cols: every character of the command reaches the card`, () => {
      const lines = cardText(PermissionPromptUI.createPromptLines(width, request as never));
      const commandRows = lines.filter((t) => t.includes('Command   :') || /^ {15}\S/.test(t));
      const joined = commandRows.map((t) => t.replace(/^ {3}Command {3}: /, '').replace(/^ {15}/, '').trimEnd()).join(' ');
      expect(joined.replace(/\s+/g, ' ')).toContain('--force-with-lease');
      expect(joined.replace(/\s+/g, ' ').includes('adopt the pricing resolver')).toBe(true);
      // Nothing elided: reassembling the rows yields the entire command.
      expect(joined.replace(/\s+/g, '')).toBe(longCommand.replace(/\s+/g, ''));
    });
  }
});

describe('write asks show a real colored diff', () => {
  test('a content write renders +++ header and added lines through the diff view', () => {
    const request = makeExecRequest({
      tool: 'write_file',
      category: 'write',
      args: { path: 'notes/haiku.txt', content: 'line one\nline two' },
    });
    const lines = cardText(PermissionPromptUI.createPromptLines(WIDTH, request as never));
    expect(lines.some((t) => t.includes('+++ notes/haiku.txt'))).toBe(true);
    expect(lines.some((t) => t.includes('line one'))).toBe(true);
    expect(lines.some((t) => t.includes('line two'))).toBe(true);
  });

  test('long content is capped with an honest more-lines trailer', () => {
    const content = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join('\n');
    const request = makeExecRequest({ tool: 'write_file', category: 'write', args: { path: 'big.txt', content } });
    const lines = cardText(PermissionPromptUI.createPromptLines(WIDTH, request as never));
    expect(lines.some((t) => t.includes('+20 more lines'))).toBe(true);
    expect(lines.some((t) => t.includes('row 10'))).toBe(true);
    expect(lines.some((t) => t.includes('row 11'))).toBe(false);
  });
});

describe('deny-with-reason typing', () => {
  const request = makeExecRequest();

  test('typing starts the reason draft; Enter denies with the reason and never aborts the turn', () => {
    const decisions: Record<string, unknown>[] = [];
    let aborted = 0;
    let pending: PendingPermissionState | null = makePending(request, (d) => decisions.push(d));
    for (const ch of 'wrong branch') {
      const result = press(pending, ch, { abort: () => { aborted += 1; } });
      pending = result.pendingPermission;
    }
    expect(pending?.replyMode).toBe('deny-reason');
    expect(pending?.replyBuffer).toBe('wrong branch');
    const done = press(pending, '\r', { abort: () => { aborted += 1; } });
    expect(done.pendingPermission).toBeNull();
    expect(aborted).toBe(0);
    expect(decisions).toEqual([{ approved: false, remember: false, modifiedArgs: undefined, reason: 'wrong branch' }]);
  });

  test('the reason draft renders on the card with the reply choices', () => {
    const view: PromptViewState = { replyMode: 'deny-reason', replyBuffer: 'wrong branch', width: WIDTH };
    const lines = cardText(PermissionPromptUI.createPromptLines(WIDTH, request as never, undefined, false, undefined, view));
    expect(lines.some((t) => t.includes('Reason   : wrong branch█'))).toBe(true);
    expect(lines.some((t) => t.includes('[Enter] Deny with this reason    [Esc] Back    [Ctrl+C] Abort turn'))).toBe(true);
  });

  test('Esc backs out of reason mode without resolving', () => {
    const decisions: Record<string, unknown>[] = [];
    let pending: PendingPermissionState | null = makePending(request, (d) => decisions.push(d));
    pending = press(pending, 'w').pendingPermission;
    const result = press(pending, '\x1b');
    expect(decisions).toEqual([]);
    expect(result.pendingPermission?.replyMode).toBeUndefined();
  });

  test('Ctrl+C during reason typing is the hard abort', () => {
    const decisions: Record<string, unknown>[] = [];
    let aborted = 0;
    let pending: PendingPermissionState | null = makePending(request, (d) => decisions.push(d));
    pending = press(pending, 'w').pendingPermission;
    const result = press(pending, '\x03', { abort: () => { aborted += 1; } });
    expect(result.pendingPermission).toBeNull();
    expect(aborted).toBe(1);
    expect(decisions).toEqual([{ approved: false, remember: false, modifiedArgs: undefined }]);
  });
});

describe('exec-prompt asks: an answerable card', () => {
  const execPromptRequest = makeExecRequest({
    attribution: {
      kind: 'exec-prompt',
      command: 'ssh deploy@example.test',
      prompt: "The authenticity of host 'example.test' can't be established. Are you sure you want to continue connecting (yes/no)?",
    } as never,
  });

  test('the pending state opens in answer mode', () => {
    const pending = makePending(execPromptRequest, () => {});
    expect(pending.replyMode).toBe('exec-answer');
    expect(pending.replyBuffer).toBe('');
  });

  test('the card renders the running command, the prompt text in full, and the answer row', () => {
    const view: PromptViewState = { replyMode: 'exec-answer', replyBuffer: 'yes', width: WIDTH };
    const lines = cardText(PermissionPromptUI.createPromptLines(WIDTH, execPromptRequest as never, undefined, false, undefined, view));
    expect(lines.some((t) => t.includes('Running  : ssh deploy@example.test'))).toBe(true);
    const joined = lines.map((t) => t.trim()).join(' ');
    expect(joined).toContain("can't be established");
    expect(joined).toContain('continue connecting (yes/no)?');
    expect(lines.some((t) => t.includes('Answer   : yes█'))).toBe(true);
    expect(lines.some((t) => t.includes('[Enter] Send answer    [Esc] Clear    [Ctrl+C] Abort turn'))).toBe(true);
  });

  test("typed characters — including 'y' and 'n' — are answer text, and Enter feeds the run", () => {
    const decisions: Record<string, unknown>[] = [];
    let pending: PendingPermissionState | null = makePending(execPromptRequest, (d) => decisions.push(d));
    for (const ch of 'yes') pending = press(pending, ch).pendingPermission;
    expect(pending?.replyBuffer).toBe('yes');
    const done = press(pending, '\r');
    expect(done.pendingPermission).toBeNull();
    expect(decisions).toEqual([{ approved: true, remember: false, modifiedArgs: { answer: 'yes' } }]);
  });

  test('Esc with no draft declines the prompt', () => {
    const decisions: Record<string, unknown>[] = [];
    const pending = makePending(execPromptRequest, (d) => decisions.push(d));
    const result = press(pending, '\x1b');
    expect(result.pendingPermission).toBeNull();
    expect(decisions).toEqual([{ approved: false, remember: false, modifiedArgs: undefined }]);
  });
});

describe('honest queue count', () => {
  test('the title names how many other asks are waiting', () => {
    const request = makeExecRequest();
    const view: PromptViewState = { queueCount: 2, width: WIDTH };
    const lines = cardText(PermissionPromptUI.createPromptLines(WIDTH, request as never, undefined, false, undefined, view));
    expect(lines.some((t) => t.includes('— 2 more waiting'))).toBe(true);
  });

  test('promptViewState counts only OTHER pending records (coalesced asks share one record)', () => {
    const broker = {
      listApprovals: () => [
        { callId: 'call-1', status: 'pending' },
        { callId: 'call-2', status: 'pending' },
        { callId: 'call-3', status: 'approved' },
      ],
    };
    const view = PermissionPromptUI.promptViewState({ callId: 'call-1' }, WIDTH, broker);
    expect(view.queueCount).toBe(1);
  });
});

describe('height parity for every new card shape', () => {
  const shapes: Array<{ name: string; request: PermissionPromptRequest; view?: PromptViewState }> = [
    { name: 'tiers', request: makeExecRequest({ rememberOptions: REMEMBER_OPTIONS as never }) },
    {
      name: 'long command',
      request: makeExecRequest({ args: { command: 'x'.repeat(300) } }),
    },
    {
      name: 'write diff',
      request: makeExecRequest({ tool: 'write_file', category: 'write', args: { path: 'a.txt', content: Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') } }),
    },
    {
      name: 'exec-prompt with answer draft',
      request: makeExecRequest({ attribution: { kind: 'exec-prompt', command: 'ssh h', prompt: 'p'.repeat(200) } as never }),
      view: { replyMode: 'exec-answer', replyBuffer: 'yes' },
    },
    {
      name: 'deny reason draft',
      request: makeExecRequest(),
      view: { replyMode: 'deny-reason', replyBuffer: 'because' },
    },
  ];

  for (const width of [80, 60]) {
    for (const shape of shapes) {
      test(`${shape.name} at ${width} cols`, () => {
        const view: PromptViewState = { ...(shape.view ?? {}), width };
        const height = PermissionPromptUI.getPromptHeight(shape.request, undefined, false, undefined, view);
        const lines = PermissionPromptUI.createPromptLines(width, shape.request as never, undefined, false, undefined, view);
        expect(lines.length).toBe(height);
      });
    }
  }
});

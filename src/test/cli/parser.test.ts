import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import {
  SessionManager,
} from '@pellux/goodvibes-sdk/platform/sessions';
import { persistConversation, readLastSessionPointer } from '@/runtime/index.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(args: string[]) {
  return parseGoodVibesCli(args, 'goodvibes');
}

function flags(args: string[]) {
  return parse(args).flags;
}

// ---------------------------------------------------------------------------
// --continue
// ---------------------------------------------------------------------------

describe('--continue flag', () => {
  test('sets continueLast=true', () => {
    expect(flags(['--continue']).continueLast).toBe(true);
  });

  test('continueLast defaults to false', () => {
    expect(flags([]).continueLast).toBe(false);
  });

  test('--continue alongside --model parses both', () => {
    const f = flags(['--continue', '--model', 'openai:gpt-5.2']);
    expect(f.continueLast).toBe(true);
    expect(f.model).toBe('openai:gpt-5.2');
  });

  test('--continue does not affect command (stays tui)', () => {
    const result = parse(['--continue']);
    expect(result.command).toBe('tui');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --resume [id]
// ---------------------------------------------------------------------------

describe('--resume flag', () => {
  test('bare --resume sets resume="latest"', () => {
    expect(flags(['--resume']).resume).toBe('latest');
  });

  test('--resume with explicit id sets that id', () => {
    expect(flags(['--resume', 'session-abc123']).resume).toBe('session-abc123');
  });

  test('-r bare sets resume="latest"', () => {
    expect(flags(['-r']).resume).toBe('latest');
  });

  test('-r with explicit id sets that id', () => {
    expect(flags(['-r', 'sess-xyz']).resume).toBe('sess-xyz');
  });

  test('--resume=<id> inline value parses correctly', () => {
    expect(flags(['--resume=user-1234']).resume).toBe('user-1234');
  });

  test('resume defaults to undefined', () => {
    expect(flags([]).resume).toBeUndefined();
  });

  test('--resume does not affect command (stays tui)', () => {
    const result = parse(['--resume']);
    expect(result.command).toBe('tui');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --fork [id]
// ---------------------------------------------------------------------------

describe('--fork flag', () => {
  test('bare --fork sets fork=true (no sentinel string collision)', () => {
    expect(flags(['--fork']).fork).toBe(true);
  });

  test('--fork with explicit session id sets that id', () => {
    expect(flags(['--fork', 'user-sess-1234']).fork).toBe('user-sess-1234');
  });

  test('--fork=<id> inline value parses correctly', () => {
    expect(flags(['--fork=session-xyz']).fork).toBe('session-xyz');
  });

  test('fork defaults to undefined (not false, not empty string)', () => {
    expect(flags([]).fork).toBeUndefined();
  });

  test('--fork current forks the session named "current" by explicit id (no sentinel collision)', () => {
    // With the boolean-union type, bare --fork → true; "current" as an explicit id stays a string
    expect(flags(['--fork', 'current']).fork).toBe('current');
    expect(flags(['--fork', 'current']).fork).not.toBe(true);
  });

  test('bare --fork is true, not the string "current"', () => {
    const f = flags(['--fork']);
    expect(f.fork).toBe(true);
    expect(f.fork).not.toBe('current');
  });

  test('--fork does not affect command (stays tui)', () => {
    const result = parse(['--fork']);
    expect(result.command).toBe('tui');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --yes / -y
// ---------------------------------------------------------------------------

describe('--yes / -y flag', () => {
  test('--yes sets yes=true', () => {
    expect(flags(['--yes']).yes).toBe(true);
  });

  test('-y sets yes=true', () => {
    expect(flags(['-y']).yes).toBe(true);
  });

  test('yes defaults to false', () => {
    expect(flags([]).yes).toBe(false);
  });

  test('--yes alongside run command parses cleanly', () => {
    const result = parse(['run', '--yes', 'do something']);
    expect(result.flags.yes).toBe(true);
    expect(result.command).toBe('run');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --non-interactive
// ---------------------------------------------------------------------------

describe('--non-interactive flag', () => {
  test('--non-interactive sets nonInteractive=true', () => {
    expect(flags(['--non-interactive']).nonInteractive).toBe(true);
  });

  test('nonInteractive defaults to false', () => {
    expect(flags([]).nonInteractive).toBe(false);
  });

  test('--non-interactive and --yes can coexist', () => {
    const f = flags(['--non-interactive', '--yes']);
    expect(f.nonInteractive).toBe(true);
    expect(f.yes).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --strict (doctor)
// ---------------------------------------------------------------------------

describe('--strict flag', () => {
  test('--strict sets strict=true', () => {
    expect(flags(['--strict']).strict).toBe(true);
  });

  test('strict defaults to false', () => {
    expect(flags([]).strict).toBe(false);
  });

  test('doctor --strict parses cleanly', () => {
    const result = parse(['doctor', '--strict']);
    expect(result.command).toBe('doctor');
    expect(result.flags.strict).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Output flag alias consolidation
// Canonical: --output / -o
// Aliases: --output-format (deprecated alias), --json (shorthand)
// Conflict resolution: last-wins (left-to-right token processing)
// ---------------------------------------------------------------------------

describe('output flag consolidation', () => {
  test('--output sets canonical outputFormat', () => {
    expect(flags(['--output', 'json']).outputFormat).toBe('json');
  });

  test('-o sets canonical outputFormat', () => {
    expect(flags(['-o', 'stream-json']).outputFormat).toBe('stream-json');
  });

  test('--output-format (alias) maps onto outputFormat', () => {
    expect(flags(['--output-format', 'json']).outputFormat).toBe('json');
  });

  test('--json (alias) maps onto outputFormat=json', () => {
    expect(flags(['--json']).outputFormat).toBe('json');
  });

  test('all three valid output values are accepted', () => {
    for (const fmt of ['text', 'json', 'stream-json'] as const) {
      expect(flags(['--output', fmt]).outputFormat).toBe(fmt);
    }
  });

  test('invalid --output value emits error with canonical flag name', () => {
    const result = parse(['--output', 'yaml']);
    expect(result.errors).toContain('--output must be one of: text, json, stream-json.');
    expect(result.flags.outputFormat).toBe('text');
  });

  test('invalid --output-format value emits error with alias flag name', () => {
    const result = parse(['--output-format', 'yaml']);
    expect(result.errors).toContain('--output-format must be one of: text, json, stream-json.');
    expect(result.flags.outputFormat).toBe('text');
  });

  // Conflict resolution: last-wins semantics
  test('--json then --output stream-json → stream-json (last wins)', () => {
    expect(flags(['--json', '--output', 'stream-json']).outputFormat).toBe('stream-json');
  });

  test('--output text then --json → json (last wins)', () => {
    expect(flags(['--output', 'text', '--json']).outputFormat).toBe('json');
  });

  test('--output-format json then --output stream-json → stream-json (last wins)', () => {
    expect(flags(['--output-format', 'json', '--output', 'stream-json']).outputFormat).toBe('stream-json');
  });

  test('--output json then --output-format text → text (last wins)', () => {
    expect(flags(['--output', 'json', '--output-format', 'text']).outputFormat).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// --hostname / --host alias consolidation
// Canonical: --hostname (documented in help as --hostname; --host is an alias)
// Both map to the same flags.hostname field
// ---------------------------------------------------------------------------

describe('hostname flag consolidation', () => {
  test('--hostname maps to flags.hostname', () => {
    expect(flags(['--hostname', '0.0.0.0']).hostname).toBe('0.0.0.0');
  });

  test('--host maps to flags.hostname', () => {
    expect(flags(['--host', '127.0.0.1']).hostname).toBe('127.0.0.1');
  });

  test('--hostname=<value> inline value works', () => {
    expect(flags(['--hostname=example.local']).hostname).toBe('example.local');
  });

  test('--host=<value> inline value works', () => {
    expect(flags(['--host=192.168.1.1']).hostname).toBe('192.168.1.1');
  });

  test('hostname defaults to undefined', () => {
    expect(flags([]).hostname).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session flags coexistence
// ---------------------------------------------------------------------------

describe('session flags coexistence', () => {
  test('--continue and --model can coexist', () => {
    const f = flags(['--continue', '--model', 'anthropic:claude-sonnet-4-6']);
    expect(f.continueLast).toBe(true);
    expect(f.model).toBe('anthropic:claude-sonnet-4-6');
    expect(f.provider).toBe('anthropic');
  });

  test('--resume and --yes can coexist', () => {
    const f = flags(['--resume', 'sess-abc', '--yes']);
    expect(f.resume).toBe('sess-abc');
    expect(f.yes).toBe(true);
  });

  test('--fork and --provider can coexist', () => {
    const f = flags(['--fork', 'sess-xyz', '--provider', 'openai']);
    expect(f.fork).toBe('sess-xyz');
    expect(f.provider).toBe('openai');
  });

  test('--continue and --resume together produce a conflict error', () => {
    const result = parse(['--continue', '--resume', 'sess-1']);
    expect(result.errors.some((e) => e.includes('Conflicting session lifecycle flags') && e.includes('--continue') && e.includes('--resume'))).toBe(true);
  });

  test('--continue and --fork together produce a conflict error', () => {
    const result = parse(['--continue', '--fork', 'sess-2']);
    expect(result.errors.some((e) => e.includes('Conflicting session lifecycle flags') && e.includes('--continue') && e.includes('--fork'))).toBe(true);
  });

  test('--resume and --fork together produce a conflict error', () => {
    const result = parse(['--resume', 'sess-1', '--fork', 'sess-2']);
    expect(result.errors.some((e) => e.includes('Conflicting session lifecycle flags') && e.includes('--resume') && e.includes('--fork'))).toBe(true);
  });

  test('all three lifecycle flags together produce a conflict error listing all three', () => {
    const result = parse(['--continue', '--resume', 'sess-1', '--fork', 'sess-2']);
    expect(result.errors.some((e) => e.includes('Conflicting session lifecycle flags') && e.includes('--continue') && e.includes('--resume') && e.includes('--fork'))).toBe(true);
  });

  test('session lifecycle flags can coexist with non-lifecycle flags without conflict errors', () => {
    // --yes and --non-interactive do not conflict with lifecycle flags
    const result = parse(['--continue', '--yes', '--non-interactive']);
    expect(result.errors.filter((e) => e.includes('Conflicting'))).toHaveLength(0);
    expect(result.flags.continueLast).toBe(true);
    expect(result.flags.yes).toBe(true);
    expect(result.flags.nonInteractive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pointer-file resume: --continue reads the last-session pointer
// ---------------------------------------------------------------------------

describe('pointer-file resume (--continue integration)', () => {
  let tmpDir: string;
  let cwdDir: string;
  let homeDir: string;
  let sessionManager: SessionManager;

  beforeEach(() => {
    const base = join(tmpdir(), `gv-parser-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tmpDir = base;
    cwdDir = join(base, 'workspace');
    homeDir = join(base, 'home');
    mkdirSync(cwdDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    sessionManager = new SessionManager(cwdDir, { surface: makeTestSurface(cwdDir) });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('readLastSessionPointer returns null when no pointer file exists', () => {
    const pointer = readLastSessionPointer({
      workingDirectory: cwdDir,
      homeDirectory: homeDir,
      surfaceRoot: 'tui',
    });
    expect(pointer).toBeNull();
  });

  test('readLastSessionPointer returns the last persisted session id after persistConversation', () => {
    const sessionId = 'user-test-resume-pointer';
    persistConversation(
      sessionId,
      {
        messages: [{ role: 'user', content: 'hello world' }],
        timestamp: Date.now(),
        titleSource: 'user',
        returnContext: {
          activityLabel: 'user prompt queued',
          statusLabel: 'awaiting response',
          pendingApprovals: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          assistantTurnCount: 0,
          userTurnCount: 1,
          activeTasks: 0,
          blockedTasks: 0,
          remoteContracts: 0,
          worktreeCount: 0,
          openPanels: [],
          lines: ['Activity: user prompt queued'],
        },
      },
      'openai:gpt-5.2',
      'openai',
      'Hello',
      { surface: makeTestSurface(cwdDir, homeDir) },
    );

    const pointer = readLastSessionPointer({
      workingDirectory: cwdDir,
      homeDirectory: homeDir,
      surfaceRoot: 'tui',
    });
    expect(pointer).toBe(sessionId);
  });

  test('--continue flag parses without error (pointer lookup happens at startup, not parse time)', () => {
    // Confirm --continue is a pure parse-time flag; pointer file read happens in tui-startup.ts
    const result = parse(['--continue']);
    expect(result.errors).toEqual([]);
    expect(result.flags.continueLast).toBe(true);
    // pointer lookup intentionally NOT done at parse time
  });

  test('second persistConversation updates pointer to new session id', () => {
    for (const sessionId of ['user-first-session', 'user-second-session']) {
      persistConversation(
        sessionId,
        { messages: [], timestamp: Date.now(), titleSource: 'user', returnContext: undefined as never },
        'openai:gpt-5.2',
        'openai',
        sessionId,
        { surface: makeTestSurface(cwdDir, homeDir) },
      );
    }
    const pointer = readLastSessionPointer({
      workingDirectory: cwdDir,
      homeDirectory: homeDir,
      surfaceRoot: 'tui',
    });
    expect(pointer).toBe('user-second-session');
  });
});

// ---------------------------------------------------------------------------
// -y bypass wiring: --yes flag is parsed and present on flags for callers
// ---------------------------------------------------------------------------

describe('-y / --yes bypass availability', () => {
  test('--yes flag is present on the flags object for bypass wiring', () => {
    const result = parse(['sessions', 'list', '--yes']);
    // --yes is a global flag — after the command is consumed, remaining tokens go to commandArgs
    // The key invariant: yes=true when the global flag is set before the command
    const global = parse(['--yes', 'sessions', 'list']);
    expect(global.flags.yes).toBe(true);
    expect(global.command).toBe('sessions');
    expect(global.errors).toEqual([]);
  });

  test('-y is a short alias for --yes', () => {
    const result = parse(['-y', 'secrets', 'delete', 'MY_KEY']);
    expect(result.flags.yes).toBe(true);
    expect(result.command).toBe('secrets');
    expect(result.errors).toEqual([]);
  });

  test('--non-interactive flag is present on the flags object for bypass wiring', () => {
    const result = parse(['--non-interactive', 'run', 'do something']);
    expect(result.flags.nonInteractive).toBe(true);
    expect(result.command).toBe('run');
    expect(result.errors).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import { buildShellFooter, estimateShellFooterHeight } from '../../renderer/shell-surface.ts';
import { lineToString } from '../setup.ts';

describe('shell surface', () => {
  test('estimated footer height matches rendered footer height without context bar', () => {
    const result = buildShellFooter({
      width: 100,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
    });
    expect(result.height).toBe(estimateShellFooterHeight(1, 0));
  });

  test('estimated footer height matches rendered footer height with context bar', () => {
    const result = buildShellFooter({
      width: 100,
      promptText: 'hello\nworld',
      promptLineCount: 2,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'claude-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'anthropic',
      contextWindow: 200000,
      lastInputTokens: 1024,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
      runningAgentProgress: 'Turn 2',
    });
    expect(result.height).toBe(estimateShellFooterHeight(2, 200000));
  });

  test('process indicator sits directly below the prompt box', () => {
    const result = buildShellFooter({
      width: 100,
      promptText: 'hello\nworld',
      promptLineCount: 2,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
      runningAgentProgress: 'Turn 2',
    });
    expect(lineToString(result.lines[4])).toContain('1 agent');
  });

  test('prompt box keeps half-height top and bottom borders', () => {
    const result = buildShellFooter({
      width: 80,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
    });
    expect(lineToString(result.lines[0])).toContain('▄');
    expect(lineToString(result.lines[2])).toContain('▀');
  });
});

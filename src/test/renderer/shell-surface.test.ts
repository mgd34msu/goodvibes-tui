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

  test('composer posture line surfaces mode and pending risk without bloating the footer', () => {
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
      composerMode: 'shell',
      composerStatus: 'preflight',
      composerFlags: ['approval'],
      composerPendingRisk: 'shell',
    });
    const text = result.lines.map(lineToString).join('\n');
    expect(text).toContain('risk:shell');
    expect(text).toContain('state:preflight');
    expect(text).toContain('flags:approval');
  });

  test('prompt box visibly loses focus when the indicator is focused', () => {
    const focused = buildShellFooter({
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
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
    });
    const unfocused = buildShellFooter({
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
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: true,
    });
    expect(lineToString(focused.lines[1])).toContain('›');
    expect(lineToString(unfocused.lines[1])).toContain('›');
    expect(focused.lines[1]![4]!.bg).toBe('#2a2a2a');
    expect(unfocused.lines[1]![4]!.bg).toBe('#1f2430');
    expect(lineToString(unfocused.lines[1])).not.toContain('█');
  });

  test('prompt box borders match the inactive prompt fill when the indicator is focused', () => {
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
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: true,
    });
    const topBorderCells = result.lines[0]!.filter((cell) => cell.char === '▄');
    const bottomBorderCells = result.lines[2]!.filter((cell) => cell.char === '▀');

    expect(topBorderCells.length).toBeGreaterThan(0);
    expect(bottomBorderCells.length).toBeGreaterThan(0);
    expect(topBorderCells.every((cell) => cell.fg === '#1f2430')).toBe(true);
    expect(bottomBorderCells.every((cell) => cell.fg === '#1f2430')).toBe(true);
  });
});

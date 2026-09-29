/**
 * /status carries what the rows under the composer used to show: token
 * totals, context use, working directory, model and provider, tool count,
 * notification mode, the session spine and the web surface address, plus the
 * safety states that also stay visible on the composer.
 */
import { describe, expect, test } from 'bun:test';
import { formatStatusReport, type StatusReportSource } from '../../shell/status-report.ts';

function report(overrides: Partial<StatusReportSource> = {}): string {
  return formatStatusReport({
    workingDirectory: '/proj',
    branch: 'main',
    dirty: false,
    model: 'claude-opus-4-6',
    provider: 'anthropic',
    permissionMode: 'prompt',
    toolCount: 42,
    notifyMode: 'operator',
    usage: { input: 53_000, output: 1_700, cacheRead: 2_000, cacheWrite: 0 },
    cost: '~$0.246',
    contextTokens: 13_200,
    contextWindow: 1_000_000,
    compactFraction: 0.8,
    autoApprove: false,
    keepAwake: false,
    microphone: null,
    runningAgents: 0,
    runningProcesses: 0,
    ...overrides,
  });
}

describe('/status report', () => {
  test('token totals, cost and context use', () => {
    const text = report();
    expect(text).toMatch(/input +53\.0k/);
    expect(text).toMatch(/output +1\.7k/);
    expect(text).toMatch(/cache read +2\.0k/);
    expect(text).toMatch(/total +56\.7k/);
    expect(text).toMatch(/cost +~\$0\.246/);
    expect(text).toMatch(/used +13\.2k \/ 1\.0M \(1%\)/);
    expect(text).toMatch(/compacts at +80%/);
  });

  test('an unknown window shows the tokens in use against "unknown", never a guessed window', () => {
    const text = report({ contextTokens: 29_871, contextWindow: 0 });
    expect(text).toMatch(/used +29\.9k \/ unknown/);
    expect(text).not.toMatch(/compacts at/);
  });

  test('"—" instead of a false 0 before the first input count', () => {
    const text = report({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextTokens: 0 });
    expect(text).toMatch(/input +—/);
    expect(text).toMatch(/used +— \/ 1\.0M/);
  });

  test('directory, model, provider, tools and notification mode', () => {
    const text = report({ dirty: true, modelNote: 'failover from abacusai:route-llm' });
    expect(text).toContain('/proj (main, uncommitted changes)');
    expect(text).toContain('claude-opus-4-6 (anthropic) · failover from abacusai:route-llm');
    expect(text).toMatch(/tools +42/);
    // /mode governs notification verbosity, never tool approval: it is labeled notify, not hitl.
    expect(text).toMatch(/notify +operator/);
    expect(text).not.toContain('hitl');
  });

  test('the session spine only in adopted-daemon mode, the web address when enabled', () => {
    expect(report()).toMatch(/spine +local only/);
    expect(report({ sessionSpine: 'online' })).toMatch(/spine +online/);
    expect(report({ sessionSpine: 'offline' })).toMatch(/spine +offline/);
    expect(report()).toMatch(/web +off/);
    expect(report({ webSurfaceUrl: 'http://127.0.0.1:3421' })).toMatch(/web +http:\/\/127\.0\.0\.1:3421/);
  });

  test('safety states: auto-approve, keep-awake and the microphone with its detail', () => {
    const text = report({ autoApprove: true, keepAwake: true, microphone: 'wake detection stopped · parecord · crashed 2 times within 60s' });
    expect(text).toContain('auto-approve ON');
    expect(text).toContain('disabled (keep-awake is on)');
    expect(text).toContain('crashed 2 times within 60s');
    expect(report()).toMatch(/microphone +closed/);
  });

  test('an unpriced model says so instead of a false cost', () => {
    expect(report({ cost: null })).toContain('n/a (model not priced)');
  });
});

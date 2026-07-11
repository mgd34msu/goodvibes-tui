/**
 * Model-judgment annotation rendering (sandbox-model-judgment tier).
 *
 * The SDK's sandbox-judgment tier annotates an escalation ask by pushing one
 * string — verbatim "model judgment: looks safe because…" / "model judgment:
 * flags risk because…" — onto `analysis.reasons`, after the sandbox-boundary
 * line and any policy reasons (see sandbox-escalation.ts /
 * sandbox-judgment.ts in the SDK). The card's generic Review rows only show
 * the first 2 reasons, so without special handling the annotation is
 * silently cut whenever at least one policy reason precedes it. These tests
 * pin that it always gets its own row, clearly labeled, never truncated away.
 */
import { describe, expect, test } from 'bun:test';
import { PermissionPromptUI, type PermissionPromptRequest } from '../../permissions/prompt.ts';

const WIDTH = 80;

function makeEscalationRequest(reasons: readonly string[]): PermissionPromptRequest & { resolve: (approved: boolean) => void } {
  return {
    callId: 'judgment-test',
    tool: 'exec',
    args: { command: 'curl https://example.com' },
    category: 'execute',
    analysis: {
      classification: 'sandbox-escalation',
      riskLevel: 'high',
      summary: 'Sandboxed command needs host access (wants-network): curl https://example.com',
      reasons: [...reasons],
    },
    attribution: { kind: 'sandbox-escalation', sandbox: 'exec-sandbox', escalations: ['wants-network'] },
    resolve: (_approved: boolean) => {},
  };
}

function linesToText(lines: ReturnType<typeof PermissionPromptUI.createPromptLines>): string[] {
  return lines.map((line) => line.map((c) => c.char).join(''));
}

describe('model-judgment annotation rendering', () => {
  test('renders on its own "Judgment" row, clearly labeled as model judgment', () => {
    const reasons = [
      'The exec-sandbox sandbox boundary needs host access: wants-network.',
      'model judgment: looks safe because the command only reaches a known public API.',
    ];
    const lines = PermissionPromptUI.createPromptLines(WIDTH, makeEscalationRequest(reasons));
    const text = linesToText(lines);
    const judgmentRow = text.find((l) => l.includes('Judgment'));
    expect(judgmentRow).toBeDefined();
    expect(judgmentRow).toContain('model judgment: looks safe because');
  });

  test('is NOT cut by the 2-reason Review truncation even with 2 preceding policy reasons', () => {
    const reasons = [
      'The exec-sandbox sandbox boundary needs host access: wants-network.',
      'Policy reason one.',
      'Policy reason two.',
      'model judgment: flags risk because the target host is not in the egress allowlist history.',
    ];
    const lines = PermissionPromptUI.createPromptLines(WIDTH, makeEscalationRequest(reasons));
    const text = linesToText(lines);
    expect(text.some((l) => l.includes('model judgment: flags risk because'))).toBe(true);
  });

  test('absent when no model-judgment annotation is present (annotate-only default off, or judgment tier disabled)', () => {
    const reasons = ['The exec-sandbox sandbox boundary needs host access: wants-network.'];
    const lines = PermissionPromptUI.createPromptLines(WIDTH, makeEscalationRequest(reasons));
    const text = linesToText(lines);
    expect(text.some((l) => l.includes('Judgment'))).toBe(false);
  });

  test('getPromptHeight/createPromptLines stay in parity when a judgment annotation is present', () => {
    const reasons = [
      'The exec-sandbox sandbox boundary needs host access: wants-network.',
      'Policy reason one.',
      'model judgment: looks safe because nothing unusual.',
    ];
    const request = makeEscalationRequest(reasons);
    const height = PermissionPromptUI.getPromptHeight(request);
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request);
    expect(lines.length).toBe(height);
  });
});

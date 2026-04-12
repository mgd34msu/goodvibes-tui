import { describe, expect, test } from 'bun:test';
import { ApprovalPanel } from '../../panels/approval-panel.ts';
import { PolicyRuntimeState } from '../../runtime/permissions/policy-runtime.ts';

describe('ApprovalPanel', () => {
  test('renders action-specific approval workspace guidance', () => {
    const panel = new ApprovalPanel(new PolicyRuntimeState());
    const text = panel.render(100, 24).flat().map((cell) => cell.char).join('');
    expect(text).toContain('Approval Control Room');
    expect(text).toContain('Approval posture');
    expect(text).toContain('shell');
    expect(text).toContain('mcp');
    expect(text).toContain('what-if');
    expect(text).toContain('/approval review shell');
  });

  test('supports selecting an approval lane', () => {
    const panel = new ApprovalPanel(new PolicyRuntimeState());
    expect(panel.handleInput('down')).toBe(true);
    const text = panel.render(100, 18).flat().map((cell) => cell.char).join('');
    expect(text).toContain('Selected Lane');
    expect(text).toContain('file');
    expect(text).toContain('/approval review file');
  });
});

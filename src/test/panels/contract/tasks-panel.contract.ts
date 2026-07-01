import { describe, test, expect } from 'bun:test';
import { TasksPanel } from '../../../panels/tasks-panel.ts';
import { EMPTY_TASKS_READ_MODEL, W, H } from './_shared.ts';

// ---------------------------------------------------------------------------
// TasksPanel — requires UiReadModel, tested separately
// ---------------------------------------------------------------------------

describe('TasksPanel — BasePanel contract', () => {
  let panel: TasksPanel;

  test('render() returns exactly H lines', () => {
    panel = new TasksPanel(EMPTY_TASKS_READ_MODEL as never);
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells', () => {
    panel = new TasksPanel(EMPTY_TASKS_READ_MODEL as never);
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('showSelectionGutter is true (S5: non-color selection affordance)', () => {
    panel = new TasksPanel(EMPTY_TASKS_READ_MODEL as never);
    expect((panel as unknown as { showSelectionGutter: boolean }).showSelectionGutter).toBe(true);
  });
});

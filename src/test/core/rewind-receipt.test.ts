import { describe, expect, test } from 'bun:test';
import { buildRewindReceiptBlock } from '../../core/rewind-receipt.ts';

describe('buildRewindReceiptBlock', () => {
  test('renders a both-scope receipt with file + conversation lines and an undo hint', () => {
    const block = buildRewindReceiptBlock({
      scope: 'both',
      turnId: 't1',
      files: { restored: true, restoredFileCount: 3, removedFileCount: 1, safetyCheckpointId: 'wcp_safe' },
      conversation: { rewound: true, droppedMessages: 2, undoSnapshotId: 'rwc_1' },
      undoAvailable: true,
      warnings: [],
    });
    expect(block.startsWith('[Rewind] Receipt')).toBe(true);
    expect(block).toContain('Files: restored 3 files, removed 1 file.');
    expect(block).toContain('Conversation: dropped 2 messages');
    expect(block).toContain('/undo rewind');
  });

  test('states plainly when a half was not applied and when no undo point exists', () => {
    const block = buildRewindReceiptBlock({
      scope: 'both',
      turnId: null,
      files: { restored: false, restoredFileCount: 0, removedFileCount: 0, safetyCheckpointId: null },
      conversation: { rewound: false, droppedMessages: 0, undoSnapshotId: null },
      undoAvailable: false,
      warnings: ['files rewind: no workspace checkpoint was recorded for this turn.'],
    });
    expect(block).toContain('Files: not restored');
    expect(block).toContain('Conversation: not rewound');
    expect(block).toContain('no undo point was recorded');
    expect(block).toContain('the most recent checkpoint');
    expect(block).toContain('note: files rewind: no workspace checkpoint');
  });
});

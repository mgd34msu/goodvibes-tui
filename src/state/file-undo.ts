import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileOperation {
  /** Absolute resolved path to the file. */
  path: string;
  /** File content before the operation. Null if the file did not exist. */
  beforeContent: string | null;
  /** File content after the operation. */
  afterContent: string;
  /** Human-readable label, e.g. "write" or "edit". */
  tool: 'write' | 'edit';
  /** ISO timestamp of the operation. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// FileUndoManager
// ---------------------------------------------------------------------------

const MAX_STACK_SIZE = 50;

export class FileUndoManager {
  private undoStack: FileOperation[] = [];
  private redoStack: FileOperation[] = [];

  // ---------------------------------------------------------------------------
  // Snapshot — called by write/edit tools after a successful write
  // ---------------------------------------------------------------------------

  /**
   * Record a completed file operation for potential undo/redo.
   * beforeContent is null when the file was newly created.
   */
  snapshot(op: Omit<FileOperation, 'timestamp'>): void {
    const entry: FileOperation = { ...op, timestamp: new Date().toISOString() };

    this.undoStack.push(entry);
    // Trim to max stack size — remove oldest entries first
    if (this.undoStack.length > MAX_STACK_SIZE) {
      this.undoStack.shift();
    }
    // Any new operation invalidates the redo stack
    this.redoStack = [];
  }

  // ---------------------------------------------------------------------------
  // Undo
  // ---------------------------------------------------------------------------

  /**
   * Revert the most recent file operation.
   * Returns `{ path }` on success, or `null` if nothing to undo.
   */
  undo(): { path: string; tool: string } | null {
    const op = this.undoStack.pop();
    if (!op) return null;

    try {
      if (op.beforeContent === null) {
        // File was created by this op — restoring means deleting it,
        // but we do a safe approach: write empty string + push to redo.
        // Full deletion would be destructive; leave as empty file instead.
        writeFileSync(op.path, '', 'utf-8');
        logger.debug('file-undo: reverted new file to empty', { path: op.path });
      } else {
        writeFileSync(op.path, op.beforeContent, 'utf-8');
        logger.debug('file-undo: restored previous content', { path: op.path });
      }
    } catch (err) {
      logger.debug('file-undo: undo write failed', { path: op.path, error: summarizeError(err) });
      // Put it back on the stack so state is consistent
      this.undoStack.push(op);
      throw err;
    }

    this.redoStack.push(op);
    if (this.redoStack.length > MAX_STACK_SIZE) {
      this.redoStack.shift();
    }
    return { path: op.path, tool: op.tool };
  }

  // ---------------------------------------------------------------------------
  // Redo
  // ---------------------------------------------------------------------------

  /**
   * Re-apply the most recently undone file operation.
   * Returns `{ path }` on success, or `null` if nothing to redo.
   */
  redo(): { path: string; tool: string } | null {
    const op = this.redoStack.pop();
    if (!op) return null;

    try {
      writeFileSync(op.path, op.afterContent, 'utf-8');
      logger.debug('file-undo: re-applied operation', { path: op.path });
    } catch (err) {
      logger.debug('file-undo: redo write failed', { path: op.path, error: summarizeError(err) });
      this.redoStack.push(op);
      throw err;
    }

    this.undoStack.push(op);
    if (this.undoStack.length > MAX_STACK_SIZE) {
      this.undoStack.shift();
    }
    return { path: op.path, tool: op.tool };
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /** Number of operations that can be undone. */
  undoDepth(): number {
    return this.undoStack.length;
  }

  /** Number of operations that can be redone. */
  redoDepth(): number {
    return this.redoStack.length;
  }

  /** Peek at the most recent undoable operation without popping. */
  peekUndo(): FileOperation | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  /** Clear both stacks (e.g., on session reset). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

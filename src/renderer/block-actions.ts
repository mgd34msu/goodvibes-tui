import type { BlockMeta } from '../core/conversation.ts';

export type BlockActionId = 'copy' | 'bookmark' | 'toggle' | 'apply' | 'rerun';

export interface BlockAction {
  id: BlockActionId;
  label: string;
  key: string;
}

const ALL_ACTIONS: BlockAction[] = [
  { id: 'copy',     label: 'Copy',           key: 'c' },
  { id: 'bookmark', label: 'Bookmark',       key: 'b' },
  { id: 'toggle',   label: 'Collapse/Expand',key: 'Tab' },
  { id: 'apply',    label: 'Apply diff',     key: 'a' },
  { id: 'rerun',    label: 'Re-run tool',    key: 'r' },
];

/**
 * BlockActionsMenu - Lightweight overlay that shows available actions
 * for the block the cursor is currently on.
 *
 * Activated by pressing Enter on a block in the conversation.
 * Dismissed by Esc or by selecting an action.
 */
export class BlockActionsMenu {
  public active = false;
  public selectedIndex = 0;
  public actions: BlockAction[] = [];
  public block: BlockMeta | null = null;

  /**
   * open - Show the menu for the given block.
   * Filters available actions by block type.
   */
  open(block: BlockMeta): void {
    this.block = block;
    this.actions = ALL_ACTIONS.filter(a => {
      if (a.id === 'apply') return block.type === 'diff';
      if (a.id === 'rerun') return block.type === 'tool';
      return true;
    });
    this.selectedIndex = 0;
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.block = null;
    this.actions = [];
    this.selectedIndex = 0;
  }

  moveUp(): void {
    if (this.actions.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.actions.length) % this.actions.length;
  }

  moveDown(): void {
    if (this.actions.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.actions.length;
  }

  getSelected(): BlockAction | null {
    return this.actions[this.selectedIndex] ?? null;
  }

  /**
   * getActionForKey - Return the action matching a single key press, or null.
   * Handles 'tab' as 'Tab'.
   */
  getActionForKey(key: string): BlockAction | null {
    const k = key === 'tab' ? 'Tab' : key;
    return this.actions.find(a => a.key === k) ?? null;
  }
}

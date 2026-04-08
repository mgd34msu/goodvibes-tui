export const WORKLIST_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['create', 'list', 'show', 'add-item', 'complete-item', 'reopen-item', 'remove-item'],
    },
    view: { type: 'string', enum: ['summary', 'full'] },
    worklistId: { type: 'string' },
    title: { type: 'string' },
    itemId: { type: 'string' },
    text: { type: 'string' },
    owner: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

export type WorklistToolInput = {
  mode: 'create' | 'list' | 'show' | 'add-item' | 'complete-item' | 'reopen-item' | 'remove-item';
  view?: 'summary' | 'full';
  worklistId?: string;
  title?: string;
  itemId?: string;
  text?: string;
  owner?: string;
  priority?: 'low' | 'medium' | 'high';
};

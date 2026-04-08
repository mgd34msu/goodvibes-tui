export const TEAM_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['create', 'list', 'show', 'add-member', 'remove-member', 'set-lanes', 'delete'],
    },
    view: { type: 'string', enum: ['summary', 'full'] },
    teamId: { type: 'string' },
    name: { type: 'string' },
    summary: { type: 'string' },
    memberId: { type: 'string' },
    role: { type: 'string' },
    lanes: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

export type TeamToolInput = {
  mode: 'create' | 'list' | 'show' | 'add-member' | 'remove-member' | 'set-lanes' | 'delete';
  view?: 'summary' | 'full';
  teamId?: string;
  name?: string;
  summary?: string;
  memberId?: string;
  role?: string;
  lanes?: string[];
};

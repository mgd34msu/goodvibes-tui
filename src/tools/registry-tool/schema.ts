/**
 * JSON Schema and TypeScript types for the `registry` tool.
 */
export const REGISTRY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['search', 'recommend', 'dependencies', 'preview', 'content'],
      description:
        'Operation mode: search finds skills/agents/tools by query;'
        + ' recommend lists items sorted by relevance to a task;'
        + ' dependencies reads a skill\'s depends_on;'
        + ' preview returns metadata, references, and preview text without materializing linked content;'
        + ' content returns the materialized markdown body and parsed metadata.'
        + ' Discovery: use mode=search with no query to list all available items;'
        + ' use mode=search type=skills to list skills, type=agents for agents, type=tools for tools.',
    },
    query: {
      type: 'string',
      description: '(mode: search) Search term to match against name, description.',
    },
    type: {
      type: 'string',
      enum: ['skills', 'agents', 'tools', 'all'],
      description: '(mode: search) Filter by item type. Default: "all".',
    },
    task: {
      type: 'string',
      description: '(mode: recommend) Task description used for keyword-based relevance sorting.',
    },
    scope: {
      type: 'string',
      enum: ['skills', 'tools'],
      description: '(mode: recommend) Whether to recommend skills or tools. Default: "skills".',
    },
    skillName: {
      type: 'string',
      description: '(mode: dependencies) Name of the skill to inspect for dependencies.',
    },
    path: {
      type: 'string',
      description: '(mode: preview/content) Absolute or relative path to a skill/agent markdown file.',
    },
  },
  required: ['mode'],
} as const;

/** Valid operation modes for the registry tool. */
export type RegistryMode = 'search' | 'recommend' | 'dependencies' | 'preview' | 'content';

/** Full input shape for the registry tool. */
export interface RegistryInput {
  mode: RegistryMode;

  // mode: search
  query?: string;
  type?: 'skills' | 'agents' | 'tools' | 'all';

  // mode: recommend
  task?: string;
  scope?: 'skills' | 'tools';

  // mode: dependencies
  skillName?: string;

  // mode: preview/content
  path?: string;
}

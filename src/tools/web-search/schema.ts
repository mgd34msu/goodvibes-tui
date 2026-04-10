export const WEB_SEARCH_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Web search query to execute.',
    },
    providerId: {
      type: 'string',
      description: 'Optional provider id. Defaults to the built-in default provider.',
    },
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 25,
      description: 'Maximum number of ranked results to return. Default 10.',
    },
    verbosity: {
      type: 'string',
      enum: ['urls_only', 'titles', 'snippets', 'evidence', 'full'],
      description:
        'urls_only returns ranked URLs, titles adds titles, snippets adds descriptions,'
        + ' evidence fetches bounded excerpts from the top results, and full fetches fuller readable excerpts.',
    },
    region: {
      type: 'string',
      description: 'Provider-specific region code such as us-en for DuckDuckGo.',
    },
    safeSearch: {
      type: 'string',
      enum: ['strict', 'moderate', 'off'],
      description: 'Safe-search posture. Default provider behavior is moderate.',
    },
    timeRange: {
      type: 'string',
      enum: ['any', 'day', 'week', 'month', 'year'],
      description: 'Optional recency filter.',
    },
    includeInstantAnswer: {
      type: 'boolean',
      description: 'When supported, include provider instant-answer enrichment.',
    },
    includeEvidence: {
      type: 'boolean',
      description: 'Attach fetched evidence from the top ranked pages.',
    },
    evidenceTopN: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'How many top results to fetch for evidence when evidence is enabled.',
    },
    evidenceExtract: {
      type: 'string',
      enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf', 'summary'],
      description: 'Fetch extraction mode to use for evidence fetches.',
    },
  },
  required: ['query'],
} as const;

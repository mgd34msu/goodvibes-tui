export interface AnalyzeInput {
  mode:
    | 'impact'
    | 'dependencies'
    | 'dead_code'
    | 'security'
    | 'coverage'
    | 'bundle'
    | 'preview'
    | 'diff'
    | 'surface'
    | 'breaking'
    | 'semantic_diff'
    | 'upgrade'
    | 'permissions'
    | 'env_audit'
    | 'test_find';
  files?: string[];
  projectRoot?: string;
  changes?: string;
  submode?: 'analyze' | 'circular' | 'upgrade';
  securityScope?: 'secrets' | 'permissions' | 'env' | 'all';
  before?: string;
  after?: string;
  find?: string;
  replace?: string;
  include?: string[];
  packages?: string[];
  output?: {
    format?: 'summary' | 'detailed' | 'json';
    max_tokens?: number;
  };
}

export type ExportedSymbol = { name: string; file: string; line: number; kind?: string };

export type JsonObject = Record<string, unknown>;

export type DiffStatFile = { file: string; insertions: number; deletions: number };

export type SemanticDiffSummary = {
  summary: string;
  impact: string[];
  risk: 'low' | 'medium' | 'high';
};

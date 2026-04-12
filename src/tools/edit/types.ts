export type OccurrenceSpec = 'first' | 'last' | 'all' | number;

export interface EditItem {
  path: string;
  find: string;
  find_base64?: string;
  replace: string;
  replace_base64?: string;
  id?: string;
  occurrence?: OccurrenceSpec;
  hints?: {
    near_line?: number;
    in_function?: string;
    in_class?: string;
    after?: string;
    before?: string;
  };
}

export type ValidatorName = 'typecheck' | 'lint' | 'test' | 'build';

export interface EditInput {
  edits?: EditItem[];
  notebook_operations?: NotebookOperationsInput;
  match?: {
    mode?: 'exact' | 'fuzzy' | 'regex' | 'ast' | 'ast_pattern';
    case_sensitive?: boolean;
    whitespace_sensitive?: boolean;
    multiline?: boolean;
  };
  transaction?: {
    mode?: 'atomic' | 'partial' | 'none';
  };
  output?: {
    format?: 'count_only' | 'minimal' | 'with_diff' | 'verbose';
    diff_context?: number;
  };
  dry_run?: boolean;
  validate?: {
    before?: ValidatorName[];
    after?: ValidatorName[];
  };
}

export type EditResultStatus = 'applied' | 'not_found' | 'ambiguous' | 'conflict' | 'failed';

export interface EditResult {
  id?: string;
  path: string;
  success: boolean;
  status?: EditResultStatus;
  occurrencesReplaced?: number;
  diff?: string;
  diff_truncated?: boolean;
  diff_preview?: string;
  error?: string;
  hint?: string;
  warning?: string;
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
  id?: string;
}

export interface JupyterNotebook {
  nbformat: number;
  nbformat_minor: number;
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
}

export interface NotebookOperation {
  op: 'replace' | 'insert' | 'delete';
  cell?: number;
  cell_id?: string;
  after?: number;
  source?: string;
  cell_type?: 'code' | 'markdown' | 'raw';
  clear_outputs?: boolean;
}

export interface NotebookOperationsInput {
  path: string;
  operations: NotebookOperation[];
}

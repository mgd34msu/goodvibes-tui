CREATE TABLE IF NOT EXISTS knowledge_sources (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT,
      source_uri TEXT,
      canonical_uri TEXT,
      summary TEXT,
      description TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      folder_path TEXT,
      status TEXT NOT NULL,
      artifact_id TEXT,
      content_hash TEXT,
      last_crawled_at INTEGER,
      crawl_error TEXT,
      session_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_canonical_uri ON knowledge_sources(canonical_uri);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_updated_at ON knowledge_sources(updated_at);

CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      source_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_nodes_kind_slug ON knowledge_nodes(kind, slug);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_updated_at ON knowledge_nodes(updated_at);

CREATE TABLE IF NOT EXISTS knowledge_edges (
      id TEXT PRIMARY KEY,
      from_kind TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_kind TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_edges_unique ON knowledge_edges(from_kind, from_id, to_kind, to_id, relation);

CREATE TABLE IF NOT EXISTS knowledge_issues (
      id TEXT PRIMARY KEY,
      severity TEXT NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      source_id TEXT,
      node_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_issues_code ON knowledge_issues(code);

CREATE TABLE IF NOT EXISTS knowledge_extractions (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      artifact_id TEXT,
      extractor_id TEXT NOT NULL,
      format TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      excerpt TEXT,
      sections TEXT NOT NULL DEFAULT '[]',
      links TEXT NOT NULL DEFAULT '[]',
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      structure TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_extractions_source_id ON knowledge_extractions(source_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_extractions_format ON knowledge_extractions(format);

CREATE TABLE IF NOT EXISTS knowledge_job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      result TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_job_runs_job_id ON knowledge_job_runs(job_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_job_runs_requested_at ON knowledge_job_runs(requested_at);

CREATE TABLE IF NOT EXISTS knowledge_refinement_tasks (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      subject_kind TEXT,
      subject_id TEXT,
      subject_title TEXT,
      subject_type TEXT,
      gap_id TEXT,
      issue_id TEXT,
      state TEXT NOT NULL,
      priority TEXT NOT NULL,
      trigger TEXT NOT NULL,
      budget TEXT NOT NULL DEFAULT '{}',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT,
      trace TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_refinement_space_state ON knowledge_refinement_tasks(space_id, state);

CREATE INDEX IF NOT EXISTS idx_knowledge_refinement_gap ON knowledge_refinement_tasks(gap_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_refinement_subject ON knowledge_refinement_tasks(subject_kind, subject_id);

CREATE TABLE IF NOT EXISTS knowledge_usage_records (
      id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      usage_kind TEXT NOT NULL,
      task TEXT,
      session_id TEXT,
      score REAL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_usage_target ON knowledge_usage_records(target_kind, target_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_usage_created_at ON knowledge_usage_records(created_at);

CREATE TABLE IF NOT EXISTS knowledge_consolidation_candidates (
      id TEXT PRIMARY KEY,
      candidate_type TEXT NOT NULL,
      status TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      score REAL NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      suggested_memory_class TEXT,
      suggested_scope TEXT,
      decided_at INTEGER,
      decided_by TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_subject ON knowledge_consolidation_candidates(subject_kind, subject_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_status ON knowledge_consolidation_candidates(status);

CREATE TABLE IF NOT EXISTS knowledge_consolidation_reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      highlights TEXT NOT NULL DEFAULT '[]',
      metrics TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_reports_kind ON knowledge_consolidation_reports(kind);

CREATE TABLE IF NOT EXISTS knowledge_schedules (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      schedule TEXT NOT NULL,
      last_run_at INTEGER,
      next_run_at INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_schedules_job_id ON knowledge_schedules(job_id);

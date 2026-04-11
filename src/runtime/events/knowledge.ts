/**
 * KnowledgeEvent — structured knowledge ingest, extraction, packet, projection, and job lifecycle events.
 */

export type KnowledgeEvent =
  | {
      type: 'KNOWLEDGE_INGEST_STARTED';
      sourceId: string;
      connectorId: string;
      sourceType: string;
      uri?: string;
    }
  | {
      type: 'KNOWLEDGE_INGEST_COMPLETED';
      sourceId: string;
      status: string;
      artifactId?: string;
      title?: string;
    }
  | {
      type: 'KNOWLEDGE_INGEST_FAILED';
      sourceId: string;
      error: string;
    }
  | {
      type: 'KNOWLEDGE_EXTRACTION_COMPLETED';
      sourceId: string;
      extractionId: string;
      format: string;
      estimatedTokens: number;
    }
  | {
      type: 'KNOWLEDGE_EXTRACTION_FAILED';
      sourceId: string;
      error: string;
    }
  | {
      type: 'KNOWLEDGE_COMPILE_COMPLETED';
      sourceId: string;
      nodeCount: number;
      edgeCount: number;
    }
  | {
      type: 'KNOWLEDGE_LINT_COMPLETED';
      issueCount: number;
    }
  | {
      type: 'KNOWLEDGE_PACKET_BUILT';
      task: string;
      itemCount: number;
      estimatedTokens: number;
      detail: 'compact' | 'standard' | 'detailed';
    }
  | {
      type: 'KNOWLEDGE_PROJECTION_RENDERED';
      targetId: string;
      pageCount: number;
    }
  | {
      type: 'KNOWLEDGE_PROJECTION_MATERIALIZED';
      targetId: string;
      artifactId: string;
      pageCount: number;
    }
  | {
      type: 'KNOWLEDGE_JOB_QUEUED';
      jobId: string;
      runId: string;
      mode: 'inline' | 'background';
    }
  | {
      type: 'KNOWLEDGE_JOB_STARTED';
      jobId: string;
      runId: string;
      mode: 'inline' | 'background';
    }
  | {
      type: 'KNOWLEDGE_JOB_COMPLETED';
      jobId: string;
      runId: string;
      durationMs: number;
    }
  | {
      type: 'KNOWLEDGE_JOB_FAILED';
      jobId: string;
      runId: string;
      error: string;
      durationMs: number;
    };

export type KnowledgeEventType = KnowledgeEvent['type'];

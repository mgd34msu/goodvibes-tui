/**
 * Automation domain state — jobs, runs, and source registry.
 */

import type { AutomationJob } from '../../../automation/jobs.ts';
import type { AutomationRun } from '../../../automation/runs.ts';
import type { AutomationSourceRecord } from '../../../automation/sources.ts';

export interface AutomationDomainState {
  readonly revision: number;
  readonly lastUpdatedAt: number;
  readonly source: string;
  readonly jobs: Map<string, AutomationJob>;
  readonly jobIds: string[];
  readonly runs: Map<string, AutomationRun>;
  readonly runIds: string[];
  readonly activeRunIds: string[];
  readonly failedRunIds: string[];
  readonly sources: Map<string, AutomationSourceRecord>;
  readonly sourceIds: string[];
  readonly totalJobs: number;
  readonly totalRuns: number;
  readonly totalSucceeded: number;
  readonly totalFailed: number;
  readonly totalCancelled: number;
  readonly totalDeadLettered: number;
}

export function createInitialAutomationState(): AutomationDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    jobs: new Map(),
    jobIds: [],
    runs: new Map(),
    runIds: [],
    activeRunIds: [],
    failedRunIds: [],
    sources: new Map(),
    sourceIds: [],
    totalJobs: 0,
    totalRuns: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalCancelled: 0,
    totalDeadLettered: 0,
  };
}

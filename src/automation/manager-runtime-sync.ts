import type { DomainDispatch } from '../runtime/store/index.ts';
import type { AutomationJob } from './jobs.ts';
import type { AutomationRun } from './runs.ts';
import type { AutomationSourceRecord } from './sources.ts';

export function collectAutomationSources(
  jobs: Iterable<AutomationJob>,
  runs: Iterable<AutomationRun>,
): AutomationSourceRecord[] {
  const sources = new Map<string, AutomationSourceRecord>();
  for (const job of jobs) {
    sources.set(job.source.id, job.source);
  }
  for (const run of runs) {
    if (!run.triggeredBy?.id) continue;
    sources.set(run.triggeredBy.id, run.triggeredBy);
  }
  return [...sources.values()];
}

export function syncAutomationRuntimeSnapshot(
  runtimeDispatch: DomainDispatch | null,
  jobs: Iterable<AutomationJob>,
  runs: Iterable<AutomationRun>,
): void {
  if (!runtimeDispatch) return;
  for (const source of collectAutomationSources(jobs, runs)) {
    runtimeDispatch.syncAutomationSource(source, 'automation.bootstrap');
  }
  for (const job of jobs) {
    runtimeDispatch.syncAutomationJob(job, 'automation.bootstrap');
  }
  for (const run of runs) {
    runtimeDispatch.syncAutomationRun(run, 'automation.bootstrap');
  }
}

export function syncAutomationJobToRuntime(
  runtimeDispatch: DomainDispatch | null,
  job: AutomationJob,
  source: string,
): void {
  runtimeDispatch?.syncAutomationSource(job.source, `${source}.source`);
  runtimeDispatch?.syncAutomationJob(job, source);
}

export function syncAutomationRunToRuntime(
  runtimeDispatch: DomainDispatch | null,
  run: AutomationRun,
  source: string,
): void {
  runtimeDispatch?.syncAutomationSource(run.triggeredBy, `${source}.source`);
  runtimeDispatch?.syncAutomationRun(run, source);
}

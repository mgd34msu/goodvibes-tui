import { createEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { EmitterContext } from './index.ts';

export function emitForensicsReportCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    reportId: string;
    classification: string;
    errorMessage?: string;
    taskId?: string;
    turnId?: string;
  },
): void {
  bus.emit('forensics', createEventEnvelope('FORENSICS_REPORT_CREATED', { type: 'FORENSICS_REPORT_CREATED', ...data }, ctx));
}

/**
 * ForensicsEvent — discriminated union for failure forensics events.
 *
 * Emitted by the ForensicsCollector when a failure report is generated
 * on a terminal state, and when a report is exported.
 */

export type ForensicsEvent =
  /** A new failure report has been generated for a terminal task or turn. */
  | {
      type: 'FORENSICS_REPORT_CREATED';
      /** Unique report ID (short hex prefix of trace ID). */
      reportId: string;
      /** Classification label for the failure. */
      classification: string;
      /** Primary error message. */
      errorMessage?: string;
      /** Task ID if this is a task failure. */
      taskId?: string;
      /** Turn ID if this is a turn failure. */
      turnId?: string;
    }
  /** A report was exported (to stdout or file). */
  | {
      type: 'FORENSICS_REPORT_EXPORTED';
      reportId: string;
      destination: 'stdout' | 'file';
      path?: string;
    };

/** All forensics event type literals as a union. */
export type ForensicsEventType = ForensicsEvent['type'];

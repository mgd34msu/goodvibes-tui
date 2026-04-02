/**
 * Playbook: Export Recovery
 *
 * Diagnoses and resolves telemetry / OTLP export pipeline failures.
 * Covers queue overflow, endpoint unreachability, and exporter misconfiguration.
 */
import type { Playbook, DiagnosticCheckResult } from '../types.ts';
import { safeCheck } from '../safe-check.ts';

/** Telemetry export recovery playbook. */
export const exportRecoveryPlaybook: Playbook = {
  id: 'export-recovery',
  name: 'Export Recovery',
  description:
    'Diagnoses and resolves telemetry / OTLP export pipeline failures. ' +
    'The runtime continues operating during export failures — this playbook ' +
    'focuses on restoring span delivery without interrupting agent work.',
  symptoms: [
    'Console logs show "[ExportQueue] Export failed" or "[OtlpExporter] Export failed permanently"',
    'Console warnings show "[ExportQueue] Queue overflow"',
    'Local ledger file is not growing despite active spans',
    'OTLP endpoint returning non-2xx responses',
    'Diagnostics panel shows exporter health as DEGRADED',
  ],
  checks: [
    {
      id: 'export.otlp-endpoint-reachable',
      label: 'OTLP endpoint reachable',
      description: 'Checks whether the configured OTLP endpoint responds to HTTP.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'OTLP endpoint reachability requires live network context.',
          severity: 'warning',
          context: { hint: 'curl -sf -X POST <otlpEndpoint> -d "{}" -H "Content-Type: application/json"' },
        })),
    },
    {
      id: 'export.queue-overflow',
      label: 'Export queue not overflowing',
      description: 'Checks whether the ExportQueue is within its configured size limit.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Queue size requires live ExportQueue reference.',
          severity: 'warning',
          context: { hint: 'Inspect exportQueue.size vs exportQueue config.maxSize' },
        })),
    },
    {
      id: 'export.ledger-writable',
      label: 'Local ledger file writable',
      description: 'Checks whether the local ledger file path is writable.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Ledger writeability requires live filesystem access.',
          severity: 'warning',
          context: { hint: 'Run: touch <ledgerFilePath> to test writability' },
        })),
    },
  ],
  steps: [
    {
      step: 1,
      title: 'Check OTLP endpoint connectivity',
      action:
        'Verify the configured OTLP endpoint is reachable. ' +
        'A minimal POST should return HTTP 200 or 204.',
      kind: 'observe',
      command: 'curl -sf -X POST <otlpEndpoint>/v1/traces -H "Content-Type: application/json" -d \'{"resourceSpans":[]}\' ',
      expectedOutcome: 'HTTP 200 or 204 response.',
      automatable: true,
    },
    {
      step: 2,
      title: 'Verify local ledger path',
      action:
        'Confirm the local ledger file path exists and is writable. ' +
        'Check disk space if the file exists but is not growing.',
      kind: 'observe',
      command: 'ls -lh <ledgerFilePath> && df -h <ledgerDirectory>',
      expectedOutcome: 'File exists and is writable; adequate disk space.',
      automatable: true,
    },
    {
      step: 3,
      title: 'Increase export queue size',
      action:
        'If spans are being dropped due to queue overflow, increase the queue ' +
        'maxSize in the OtlpExporter configuration and restart the exporter.',
      kind: 'config',
      command: 'new OtlpExporter({ ..., queue: { maxSize: 512 } })',
      expectedOutcome: 'Queue overflow warnings cease; no more span drops.',
      automatable: false,
    },
    {
      step: 4,
      title: 'Switch to console exporter temporarily',
      action:
        'Replace the failing OTLP exporter with a ConsoleExporter to preserve ' +
        'span visibility while the pipeline is being restored.',
      kind: 'config',
      command: 'tracer.config.exporters = [new ConsoleExporter({ verbosity: "compact" })]',
      expectedOutcome: 'Spans visible in console output; no data lost.',
      automatable: false,
    },
    {
      step: 5,
      title: 'Restore OTLP exporter',
      action:
        'After fixing the endpoint or configuration, re-add the OtlpExporter. ' +
        'Verify the first batch of spans is acknowledged by the OTLP receiver.',
      kind: 'config',
      command: 'tracer.config.exporters.push(new OtlpExporter({ endpoint: "<fixed-endpoint>" }))',
      expectedOutcome: 'Export result callback reports code: "success".',
      automatable: false,
    },
  ],
  escalationCriteria: [
    'OTLP endpoint unreachable for > 30 minutes with spans being dropped',
    'Local ledger disk full and no alternative export target available',
    'Export failures causing memory pressure (queue too large for available RAM)',
    'All configured exporters failing simultaneously',
  ],
  tags: ['telemetry', 'otlp', 'export', 'queue', 'ledger', 'exporter'],
};

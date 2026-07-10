/**
 * summarizeToolResult — one-line human summaries for tool RESULTS, so the
 * transcript (and the fleet attach view, which shares the same rendering seam
 * in conversation-rendering.ts) shows "wrote haiku.txt (532 B)" instead of a
 * raw `{"files_written":1,"bytes_written":532,...}` JSON blob. The full payload
 * stays reachable behind the existing collapse/expand toggle — this only
 * changes the collapsed preview line, never destroys data. (UX-B item 3.)
 *
 * Returning `null` means "no honest summary for this shape" — the caller then
 * falls back to the previous raw-first-line preview, so an unrecognised tool or
 * an unexpected payload is never mis-summarised.
 */

/** Compact byte count: "87 B", "1.2 KB", "3.4 MB". */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '? B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact duration: "820ms", "1.2s", "1m3s". */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** Trailing filename for compact display (paths can be long/absolute). */
function baseName(p: string): string {
  const cleaned = p.replace(/[/\\]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function firstPath(files: unknown): string | undefined {
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const first = files[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const rec = first as Record<string, unknown>;
    if (typeof rec.path === 'string') return rec.path;
    if (typeof rec.resolved_path === 'string') return rec.resolved_path;
  }
  return undefined;
}

/** write: { files_written, bytes_written, files?: [{path, bytes_written}], dry_run? } */
function summarizeWrite(obj: Record<string, unknown>): string | null {
  const count = asNumber(obj.files_written);
  const bytes = asNumber(obj.bytes_written);
  if (count === undefined) return null;
  const verb = obj.dry_run === true ? 'would write' : 'wrote';
  const size = bytes !== undefined ? ` (${formatBytes(bytes)})` : '';
  if (count === 1) {
    const path = firstPath(obj.files);
    return path ? `${verb} ${baseName(path)}${size}` : `${verb} 1 file${size}`;
  }
  return `${verb} ${count} files${size}`;
}

/** read: { summary: { files_read, total_lines }, files?: [{path, lineCount}] } */
function summarizeRead(obj: Record<string, unknown>): string | null {
  const summary = (obj.summary && typeof obj.summary === 'object')
    ? obj.summary as Record<string, unknown>
    : obj;
  const count = asNumber(summary.files_read);
  const lines = asNumber(summary.total_lines);
  if (count === undefined && lines === undefined) return null;
  const lineText = lines !== undefined ? ` (${lines} line${lines === 1 ? '' : 's'})` : '';
  if (count === 1) {
    const path = firstPath(obj.files);
    return path ? `read ${baseName(path)}${lineText}` : `read 1 file${lineText}`;
  }
  return `read ${count ?? '?'} files${lineText}`;
}

/** edit: { applied, failed, dry_run } or richer with a path. */
function summarizeEdit(obj: Record<string, unknown>): string | null {
  const applied = asNumber(obj.applied);
  if (applied === undefined) return null;
  const failed = asNumber(obj.failed) ?? 0;
  const verb = obj.dry_run === true ? 'would apply' : 'applied';
  const path = typeof obj.path === 'string' ? obj.path : firstPath(obj.files);
  const target = path ? ` to ${baseName(path)}` : '';
  const failText = failed > 0 ? `, ${failed} failed` : '';
  return `${verb} ${applied} edit${applied === 1 ? '' : 's'}${target}${failText}`;
}

/** Credential-bearing env-var names withheld from the spawn (never values). Empty when the field is absent/empty. */
function withheldEnvNames(obj: Record<string, unknown>): string[] {
  const raw = obj.withheld_env;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/** Compact "withheld: NAME, NAME, …" suffix, capped so a long scrub list doesn't dominate the collapsed line. */
function withheldEnvSuffix(names: readonly string[]): string {
  if (names.length === 0) return '';
  const MAX_SHOWN = 3;
  const shown = names.slice(0, MAX_SHOWN).join(', ');
  const more = names.length > MAX_SHOWN ? `, +${names.length - MAX_SHOWN} more` : '';
  return ` · withheld: ${shown}${more}`;
}

/** A single exec command result. */
function summarizeExecOne(obj: Record<string, unknown>): string | null {
  const exit = obj.exit_code;
  const dur = asNumber(obj.duration_ms);
  const durText = dur !== undefined ? ` · ${formatDuration(dur)}` : '';
  const withheldText = withheldEnvSuffix(withheldEnvNames(obj));
  if (obj.timed_out === true) return `timed out${durText}${withheldText}`;
  if (obj.cancelled === true) return `cancelled${durText}${withheldText}`;
  const stdout = typeof obj.stdout === 'string' ? obj.stdout : '';
  const lineCount = stdout.length === 0
    ? 0
    : stdout.replace(/\n$/, '').split('\n').length;
  const lineText = lineCount > 0 ? ` · ${lineCount} line${lineCount === 1 ? '' : 's'}` : '';
  const code = typeof exit === 'number' ? String(exit) : '?';
  return `exit ${code}${durText}${lineText}${withheldText}`;
}

/** exec: single { cmd, exit_code, ... } or multi { commands: [...], total }. */
function summarizeExec(obj: Record<string, unknown>): string | null {
  if (Array.isArray(obj.commands)) {
    const total = asNumber(obj.total) ?? obj.commands.length;
    const failed = obj.commands.filter(
      (c) => c && typeof c === 'object' && (c as Record<string, unknown>).success === false,
    ).length;
    // Union of withheld names across every command in the batch — the scrub
    // runs per-spawn, so different commands can withhold different names.
    const withheldAcrossCommands = new Set<string>();
    for (const c of obj.commands) {
      if (c && typeof c === 'object') {
        for (const name of withheldEnvNames(c as Record<string, unknown>)) withheldAcrossCommands.add(name);
      }
    }
    const withheldText = withheldEnvSuffix([...withheldAcrossCommands]);
    return failed > 0
      ? `${total} commands · ${failed} failed${withheldText}`
      : `${total} commands · all ok${withheldText}`;
  }
  if ('exit_code' in obj || 'timed_out' in obj || 'cancelled' in obj) {
    return summarizeExecOne(obj);
  }
  return null;
}

export function summarizeToolResult(toolName: string | undefined, content: string): string | null {
  if (!toolName) return null;
  const family = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;

  switch (family) {
    case 'write': return summarizeWrite(obj);
    case 'read': return summarizeRead(obj);
    case 'edit': return summarizeEdit(obj);
    case 'exec': return summarizeExec(obj);
    default: return null;
  }
}

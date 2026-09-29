/**
 * lane-graph/bead.ts, what one tool call's bead says: its status mark, its
 * name and key argument, the result summary on its row, and what opening it
 * shows.
 *
 * The bead IS the status mark. There is no separate result row and no
 * separate live row: a running call spins on its own bead, a failed call's
 * bead is the ✕, and the result's one-line summary sits on the same row,
 * right-aligned before the time.
 *
 * Everything here is pure data (no Lines, no theme): paint.ts draws it.
 */

import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { stripDangerousAnsi } from '../ansi-sanitize.ts';

/** Text safe to put in a cell: no escape sequences at all, no control characters. */
export function cellText(text: string): string {
  return stripDangerousAnsi(text)
    // CSI (colors included), OSC, and two-byte escapes.
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/**
 * ok      ✓ done
 * warn    ! done, with something to look at (review findings, an expected non-zero exit, a partial edit)
 * err     ✕ failed
 * run     ◐ running (spins in place, the time counts up)
 * wait    ● waiting on the user (a permission prompt is open for it)
 * cancel  ○ cancelled (the row's text is struck through)
 * bg      ▶ a process it started keeps running in the background
 */
export type BeadStatus = 'ok' | 'warn' | 'err' | 'run' | 'wait' | 'cancel' | 'bg';

/** How a settled call's result reads (conversation-render-context.ts outcomeOfToolContent). */
export type CallOutcome = 'ok' | 'error' | 'cancelled';

export interface BeadStatusInput {
  /** Undefined while no result has arrived. */
  readonly outcome: CallOutcome | undefined;
  /** The result text, when settled. */
  readonly content?: string | undefined;
  /** A permission prompt is open for this call. */
  readonly waiting: boolean;
  /** The call's owner (the turn, or the agent whose lane it is on) is still working. */
  readonly ownerActive: boolean;
  /** The call asked for a background process. */
  readonly background: boolean;
  /** The settled result carries something to look at (see needsAttention). */
  readonly attention: boolean;
}

/**
 * The status a bead shows. An unsettled call whose owner stopped working never
 * got a result, so it reads as cancelled rather than spinning forever.
 */
export function beadStatus(input: BeadStatusInput): BeadStatus {
  if (input.outcome === undefined) {
    if (input.waiting) return 'wait';
    return input.ownerActive ? 'run' : 'cancel';
  }
  if (input.outcome === 'error') return 'err';
  if (input.outcome === 'cancelled') return 'cancel';
  if (input.background) return 'bg';
  return input.attention ? 'warn' : 'ok';
}

/**
 * Extract the most meaningful argument from a tool call for display.
 */
function extractKeyArg(toolCall: ToolCall): string {
  const args = toolCall.arguments;
  // Path-based tools
  if (typeof args.path === 'string') return args.path;
  if (typeof args.file === 'string') return args.file;
  if (typeof args.query === 'string') return args.query;
  if (typeof args.title === 'string') return args.title;
  // Edit: the first edit's path
  if (Array.isArray(args.edits) && args.edits.length > 0) {
    const first = args.edits[0];
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).path === 'string') {
      const paths = new Set(args.edits.map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>).path : undefined)).filter((p): p is string => typeof p === 'string'));
      return paths.size > 1 ? `${(first as Record<string, unknown>).path as string} +${paths.size - 1} more` : (first as Record<string, unknown>).path as string;
    }
  }
  // Array-based (read/write)
  if (Array.isArray(args.files) && args.files.length > 0) {
    const first = args.files[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).path === 'string')
      return (first as Record<string, unknown>).path as string;
  }
  // Exec
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  if (Array.isArray(args.commands) && args.commands.length > 0) {
    const first = args.commands[0];
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).cmd === 'string')
      return (first as Record<string, unknown>).cmd as string;
  }
  // Find/grep
  if (typeof args.pattern === 'string') return args.pattern;
  if (Array.isArray(args.queries) && args.queries.length > 0) {
    const first = args.queries[0];
    if (first && typeof first === 'object') {
      const firstRecord = first as Record<string, unknown>;
      if (typeof firstRecord.query === 'string') return firstRecord.query;
      if (typeof firstRecord.pattern === 'string') return firstRecord.pattern;
    }
  }
  // Fetch
  if (Array.isArray(args.urls) && args.urls.length > 0) {
    const first = args.urls[0];
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).url === 'string')
      return (first as Record<string, unknown>).url as string;
  }
  // Agent
  if (typeof args.task === 'string') return args.task.slice(0, 40);
  if (typeof args.mode === 'string') return args.mode;
  // Fallback: first string value
  for (const val of Object.values(args)) {
    if (typeof val === 'string' && val.length > 0) return val.slice(0, 40);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function parseObject(content: string | undefined): Json | null {
  if (!content) return null;
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The tool family: an MCP tool's last name segment, lowercased. */
export function toolFamily(name: string): string {
  return (name.includes('__') ? name.split('__').pop()! : name).toLowerCase();
}

/** The name drawn on the bead row. */
export function beadName(call: Pick<ToolCall, 'name'>): string {
  return cellText(call.name.includes('__') ? call.name.split('__').pop()! : call.name);
}

/** The key argument drawn after the name (the path, the command, the pattern). */
export function beadArgument(call: ToolCall): string {
  return cellText(extractKeyArg(call)).replace(/\s+/g, ' ').trim();
}

/** True when the call asked for a process to keep running in the background. */
export function isBackgroundCall(call: ToolCall): boolean {
  const args = call.arguments;
  if (args.background === true) return true;
  if (Array.isArray(args.commands)) {
    return args.commands.length > 0 && args.commands.every((c) => c !== null && typeof c === 'object' && (c as Json).background === true);
  }
  return false;
}

/** The error text of a failed result (after the "Error: " prefix). */
function errorText(content: string): string {
  return content.replace(/^Error:\s*/, '');
}

// ---------------------------------------------------------------------------
// Exec results
// ---------------------------------------------------------------------------

interface ExecCommandResult {
  readonly cmd?: string;
  readonly exitCode: number | null | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly skipped: boolean;
  readonly droppedLines: number;
}

function execCommands(obj: Json): ExecCommandResult[] {
  const one = (o: Json): ExecCommandResult => ({
    cmd: str(o.cmd),
    exitCode: o.exit_code === null ? null : num(o.exit_code),
    stdout: str(o.stdout) ?? '',
    stderr: str(o.stderr) ?? '',
    timedOut: o.timed_out === true,
    skipped: o.skipped === true,
    droppedLines: (num(o.stdout_dropped_lines) ?? 0) + (num(o.stderr_dropped_lines) ?? 0),
  });
  if (Array.isArray(obj.commands)) {
    return obj.commands.filter((c): c is Json => c !== null && typeof c === 'object').map(one);
  }
  if ('exit_code' in obj || 'stdout' in obj || 'stderr' in obj) return [one(obj)];
  return [];
}

/** "4 pass", "2 fail": test-runner totals read off the output, when it printed them. */
function testTotals(text: string): string | undefined {
  const pass = /(\d+)\s+pass(?:ed|ing)?\b/i.exec(text);
  const fail = /(\d+)\s+fail(?:ed|ing|ures?)?\b/i.exec(text);
  if (!pass && !fail) return undefined;
  const failCount = fail ? Number(fail[1]) : 0;
  if (failCount > 0) return `${failCount} failing`;
  return pass ? `${pass[1]} pass` : undefined;
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

/**
 * A result that settled without failing but still has something the user
 * should look at: a command that exited non-zero, an edit with failed items,
 * or a test run with failures.
 */
export function needsAttention(call: ToolCall, content: string): boolean {
  const family = toolFamily(call.name);
  const obj = parseObject(content);
  if (family === 'exec' && obj) {
    return execCommands(obj).some((c) => (c.exitCode !== undefined && c.exitCode !== null && c.exitCode !== 0) || c.timedOut);
  }
  if (family === 'edit') {
    if (obj) return (num(obj.failed) ?? 0) > 0;
    const m = /Edits applied: \d+, failed: (\d+)/.exec(content);
    return m !== null && Number(m[1]) > 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export type SummaryTone = 'faint' | 'good' | 'warn' | 'bad';

export interface BeadSummary {
  readonly text: string;
  readonly tone: SummaryTone;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Added and removed line counts of a unified diff. */
function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

function countSummary(counts: { added: number; removed: number }): string {
  const parts: string[] = [];
  if (counts.added > 0 || counts.removed === 0) parts.push(`+${counts.added}`);
  if (counts.removed > 0) parts.push(`−${counts.removed}`);
  return parts.join(' ');
}

/** Match entries (file, line, text) found anywhere in a find result. */
function findEntries(value: unknown, out: Array<{ file: string; line?: number; text?: string }>, depth = 0): void {
  if (depth > 4 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') out.push({ file: item });
      else if (item && typeof item === 'object') {
        const rec = item as Json;
        const file = str(rec.file) ?? str(rec.path);
        if (file !== undefined) out.push({ file, line: num(rec.line), text: str(rec.text) ?? str(rec.name) });
        else findEntries(item, out, depth + 1);
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Json)) {
    if (key === 'relationships' || key === 'warnings' || key.startsWith('_')) continue;
    findEntries(child, out, depth + 1);
  }
}

/**
 * The one-line result summary on a bead's row, or null when the row should
 * carry none (a running call, or a shape with nothing honest to say).
 */
export function beadSummary(call: ToolCall, status: BeadStatus, content: string | undefined): BeadSummary | null {
  const summary = rawSummary(call, status, content);
  return summary ? { ...summary, text: cellText(summary.text) } : null;
}

function rawSummary(call: ToolCall, status: BeadStatus, content: string | undefined): BeadSummary | null {
  if (status === 'run') return null;
  if (status === 'wait') return { text: 'waiting for you', tone: 'warn' };
  if (status === 'cancel') return { text: 'cancelled', tone: 'faint' };
  if (content === undefined) return null;
  if (status === 'err') {
    const totals = testTotals(content);
    if (totals) return { text: totals, tone: 'bad' };
    const first = errorText(content).split('\n')[0] ?? '';
    const execExit = /exit(?: code)? (\d+)/i.exec(first);
    return { text: execExit ? `exit ${execExit[1]}` : first, tone: 'bad' };
  }
  const family = toolFamily(call.name);
  const obj = parseObject(content);

  if (status === 'bg') {
    const pid = obj ? num(obj.pid) ?? num(obj.process_id) : undefined;
    const port = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):(\d{2,5})\b/.exec(content)?.[1];
    return { text: ['in background', port ? `:${port}` : pid !== undefined ? `pid ${pid}` : undefined].filter(Boolean).join(' · '), tone: 'good' };
  }

  switch (family) {
    case 'read': {
      if (!obj) return textReadSummary(call, content);
      const summary = (obj.summary && typeof obj.summary === 'object') ? obj.summary as Json : obj;
      const files = num(summary.files_read);
      const lines = num(summary.total_lines);
      if (files !== undefined && files > 1) return { text: `${plural(files, 'file')}${lines !== undefined ? ` · ${plural(lines, 'line')}` : ''}`, tone: 'faint' };
      if (lines !== undefined) return { text: plural(lines, 'line'), tone: 'faint' };
      break;
    }
    case 'find': {
      if (!obj) return textFindSummary(content);
      const entries: Array<{ file: string }> = [];
      findEntries(obj, entries);
      const count = num(obj.count) ?? entries.length;
      const files = new Set(entries.map((e) => e.file)).size;
      if (count === 0) return { text: 'no matches', tone: 'faint' };
      return { text: files > 1 ? `${plural(count, 'match').replace('matchs', 'matches')} in ${files} files` : plural(count, 'match').replace('matchs', 'matches'), tone: 'faint' };
    }
    case 'edit': {
      const diff = editDiff(call, content);
      const failed = obj ? num(obj.failed) ?? 0 : Number(/failed: (\d+)/.exec(content)?.[1] ?? 0);
      if (failed > 0) return { text: `${failed} failed`, tone: 'warn' };
      if (diff) return { text: countSummary(diffCounts(diff.text)), tone: 'good' };
      break;
    }
    case 'write': {
      const written = writtenFiles(call);
      if (written.length > 0) {
        const lines = written.reduce((n, f) => n + f.content.split('\n').length, 0);
        return { text: written.length > 1 ? `${plural(written.length, 'file')} · +${lines}` : `+${lines}`, tone: 'good' };
      }
      if (obj) {
        const bytes = num(obj.bytes_written);
        if (bytes !== undefined) return { text: formatBytes(bytes), tone: 'good' };
      }
      break;
    }
    case 'exec': {
      if (!obj) return textExecSummary(content);
      const commands = execCommands(obj);
      if (commands.length === 0) break;
      if (commands.length > 1) {
        const failing = commands.filter((c) => c.exitCode !== 0 && !c.skipped).length;
        return failing > 0
          ? { text: `${commands.length} commands · ${failing} failed`, tone: 'warn' }
          : { text: `${commands.length} commands · exit 0`, tone: 'faint' };
      }
      const c = commands[0]!;
      if (c.timedOut) return { text: 'timed out', tone: 'warn' };
      const totals = testTotals(`${c.stdout}\n${c.stderr}`);
      const exit = c.exitCode === null || c.exitCode === undefined ? 'no exit code' : `exit ${c.exitCode}`;
      return { text: totals ? `${totals} · ${exit}` : exit, tone: c.exitCode === 0 || c.exitCode === undefined ? 'faint' : 'warn' };
    }
    case 'fetch': {
      return { text: formatBytes(Buffer.byteLength(content, 'utf8')), tone: 'faint' };
    }
    default:
      break;
  }
  if (obj) return null;
  const shaped = shapedTextSummary(call, content);
  if (shaped) return shaped;
  const first = content.split('\n').find((line) => line.trim().length > 0);
  return first ? { text: first.trim(), tone: 'faint' } : null;
}

/**
 * A multi-line text result whose shape says what it is, whatever the tool
 * (a result whose call is unknown carries no tool name to go by): a unified
 * diff reads as its line counts, test output as its totals, grep-style lines
 * as their match count. Anything else keeps its first line.
 */
function shapedTextSummary(call: ToolCall, content: string): BeadSummary | null {
  const lines = textLines(content);
  if (lines.length < 2) return null;
  const diff = /^@@ /m.test(content) && /^(\+\+\+|---) /m.test(content) ? editDiff(call, content) : null;
  if (diff) return { text: countSummary(diffCounts(diff.text)), tone: 'good' };
  const totals = testTotals(content);
  if (totals) return { text: totals, tone: /failing/.test(totals) ? 'warn' : 'faint' };
  if (lines.every((l) => MATCH_LINE.test(l))) return textFindSummary(content);
  return null;
}

/** Non-empty lines of a text result (trailing blank lines dropped). */
function textLines(content: string): string[] {
  const trimmed = content.replace(/\s+$/, '');
  return trimmed === '' ? [] : trimmed.split('\n');
}

/** The paths a read call asked for, from its arguments. */
function readPaths(call: ToolCall): string[] {
  const args = call.arguments;
  const out: string[] = [];
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === 'string') out.push(f);
      else if (f && typeof f === 'object' && typeof (f as Json).path === 'string') out.push((f as Json).path as string);
    }
  }
  if (out.length === 0 && typeof args.path === 'string') out.push(args.path);
  if (out.length === 0 && typeof args.file === 'string') out.push(args.file);
  return out;
}

/**
 * A read whose result is the file text itself (an imported or older session,
 * an MCP read) says how much it read, like a structured read does: never the
 * file's first line.
 */
function textReadSummary(call: ToolCall, content: string): BeadSummary {
  const lines = textLines(content).length;
  const files = new Set(readPaths(call)).size;
  if (lines === 0) return { text: 'empty', tone: 'faint' };
  return { text: files > 1 ? `${plural(files, 'file')} · ${plural(lines, 'line')}` : plural(lines, 'line'), tone: 'faint' };
}

/** `path:line: text` (grep style) or `path:line:col: text`. */
const MATCH_LINE = /^(.+?):(\d+)(?::\d+)?[:\s-]/;

/** A find whose result is grep-style text lines: how many matches in how many files, or how many files. */
function textFindSummary(content: string): BeadSummary {
  const lines = textLines(content).filter((l) => l.trim().length > 0);
  if (lines.length === 0 || /^no (matches|results|files)\b/i.test(lines[0]!.trim())) return { text: 'no matches', tone: 'faint' };
  const matches = lines.map((l) => MATCH_LINE.exec(l)).filter((m): m is RegExpExecArray => m !== null);
  if (matches.length === 0) return { text: plural(lines.length, 'file'), tone: 'faint' };
  const files = new Set(matches.map((m) => m[1])).size;
  const count = plural(matches.length, 'match').replace('matchs', 'matches');
  return { text: files > 1 ? `${count} in ${files} files` : count, tone: 'faint' };
}

/** A command whose result is its bare output: test totals when it printed them, otherwise how much it printed. */
function textExecSummary(content: string): BeadSummary {
  const totals = testTotals(content);
  if (totals) return { text: totals, tone: /failing/.test(totals) ? 'warn' : 'faint' };
  const lines = textLines(content).length;
  return { text: lines === 0 ? 'no output' : `${plural(lines, 'line')} of output`, tone: 'faint' };
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export type BodyTone = 'text' | 'muted' | 'faint' | 'good' | 'bad' | 'warn';

export type BeadBody =
  /** A unified diff. `numbered` is false when line numbers are unknown (built from the call's own find/replace). */
  | { readonly kind: 'diff'; readonly diff: string; readonly numbered: boolean; readonly path: string | undefined }
  /** Terminal output, one entry per line. */
  | { readonly kind: 'output'; readonly lines: ReadonlyArray<{ readonly text: string; readonly tone: BodyTone }>; readonly footer?: string }
  /** A short list (files read, matches found). */
  | { readonly kind: 'list'; readonly items: ReadonlyArray<{ readonly text: string; readonly detail?: string }> }
  /** A failure, wrapped in full. */
  | { readonly kind: 'error'; readonly text: string }
  /** Plain text lines (a result that is text, or a flattened object). */
  | { readonly kind: 'text'; readonly lines: readonly string[] };

/** The files a write call wrote, with their content. */
function writtenFiles(call: ToolCall): Array<{ path: string; content: string }> {
  const args = call.arguments;
  const out: Array<{ path: string; content: string }> = [];
  const push = (rec: Json): void => {
    const path = str(rec.path) ?? str(rec.file);
    const content = str(rec.content);
    if (path !== undefined && content !== undefined) out.push({ path, content });
  };
  if (Array.isArray(args.files)) for (const f of args.files) if (f && typeof f === 'object') push(f as Json);
  if (out.length === 0) push(args);
  return out;
}

/**
 * The diff an edit made: the unified diff the edit tool printed when it ran
 * with a diff output format, otherwise one built from the call's own
 * find/replace pairs (then line numbers are unknown and the body shows none).
 */
function editDiff(call: ToolCall, content: string | undefined): { text: string; numbered: boolean; path: string | undefined } | null {
  if (content && /^@@ /m.test(content) && /^(\+\+\+|---) /m.test(content)) {
    // The edit tool prints its own "--- path (N replacement(s)) ---" banners around each
    // file's diff: start at the real diff header, and drop any banner lines inside it.
    let start = content.search(/^diff --git /m);
    if (start < 0) start = content.search(/^--- \S+\n\+\+\+ /m);
    const text = (start >= 0 ? content.slice(start) : content)
      .split('\n')
      .filter((line) => !/^--- .* ---$/.test(line) && !/^\s*WARN: /.test(line) && !/^\[diff truncated/.test(line))
      .join('\n');
    const path = /^\+\+\+ (?:b\/)?(.+)$/m.exec(text)?.[1];
    return { text, numbered: true, path };
  }
  const edits = Array.isArray(call.arguments.edits) ? call.arguments.edits.filter((e): e is Json => e !== null && typeof e === 'object') : [];
  const usable = edits.filter((e) => typeof e.find === 'string' && typeof e.replace === 'string');
  if (usable.length === 0) return null;
  const byPath = new Map<string, Json[]>();
  for (const edit of usable) {
    const path = str(edit.path) ?? 'file';
    byPath.set(path, [...(byPath.get(path) ?? []), edit]);
  }
  const chunks: string[] = [];
  for (const [path, list] of byPath) {
    chunks.push(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`);
    for (const edit of list) {
      const find = (edit.find as string).split('\n');
      const replace = (edit.replace as string).split('\n');
      // Shared leading and trailing lines are context, not change.
      let head = 0;
      while (head < find.length && head < replace.length && find[head] === replace[head]) head++;
      let tail = 0;
      while (tail < find.length - head && tail < replace.length - head && find[find.length - 1 - tail] === replace[replace.length - 1 - tail]) tail++;
      const near = num((edit.hints as Json | undefined)?.near_line) ?? 1;
      chunks.push(`@@ -${near},${find.length} +${near},${replace.length} @@`);
      for (const line of find.slice(0, head)) chunks.push(` ${line}`);
      for (const line of find.slice(head, find.length - tail)) chunks.push(`-${line}`);
      for (const line of replace.slice(head, replace.length - tail)) chunks.push(`+${line}`);
      for (const line of find.slice(find.length - tail)) chunks.push(` ${line}`);
    }
  }
  return { text: `${chunks.join('\n')}\n`, numbered: false, path: byPath.size === 1 ? [...byPath.keys()][0] : undefined };
}

function flattenObject(obj: Json, prefix = '', out: string[] = [], depth = 0): string[] {
  for (const [key, value] of Object.entries(obj)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      const lines = value.split('\n');
      out.push(`${label}  ${lines[0] ?? ''}`);
      for (const line of lines.slice(1)) out.push(`  ${line}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out.push(`${label}  ${String(value)}`);
    } else if (Array.isArray(value)) {
      const scalars = value.filter((v) => typeof v === 'string' || typeof v === 'number');
      if (scalars.length === value.length && value.length <= 8) out.push(`${label}  ${scalars.join(', ')}`);
      else out.push(`${label}  ${plural(value.length, 'item')}`);
    } else if (typeof value === 'object' && depth < 2) {
      flattenObject(value as Json, label, out, depth + 1);
    }
  }
  return out;
}

/**
 * What opening a bead shows, or null when there is nothing inside (then the
 * row carries no ▸).
 */
export function beadBody(call: ToolCall, status: BeadStatus, content: string | undefined): BeadBody | null {
  const body = rawBody(call, status, content);
  if (!body) return null;
  switch (body.kind) {
    case 'list': return { kind: 'list', items: body.items.map((i) => ({ text: cellText(i.text), detail: i.detail !== undefined ? cellText(i.detail) : undefined })) };
    case 'text': return { kind: 'text', lines: body.lines.map(cellText) };
    case 'error': return { kind: 'error', text: body.text.split('\n').map(cellText).join('\n') };
    default: return body;
  }
}

function rawBody(call: ToolCall, status: BeadStatus, content: string | undefined): BeadBody | null {
  const family = toolFamily(call.name);
  if (family === 'edit') {
    const diff = editDiff(call, content);
    if (status === 'err' && content !== undefined) return { kind: 'error', text: errorText(content) };
    if (diff) return { kind: 'diff', diff: diff.text, numbered: diff.numbered, path: diff.path };
  }
  if (family === 'write') {
    const files = writtenFiles(call);
    if (status === 'err' && content !== undefined) return { kind: 'error', text: errorText(content) };
    if (files.length > 0) {
      const text = files.map((f) => {
        const lines = f.content.replace(/\n$/, '').split('\n');
        return [`diff --git a/${f.path} b/${f.path}`, '--- /dev/null', `+++ b/${f.path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
      }).join('\n');
      return { kind: 'diff', diff: `${text}\n`, numbered: true, path: files.length === 1 ? files[0]!.path : undefined };
    }
  }
  if (content === undefined) return null;
  if (status === 'err') return { kind: 'error', text: errorText(content) };
  // Any result that is itself a unified diff opens as one.
  if (/^--- \S/m.test(content) && /^\+\+\+ \S/m.test(content) && /^@@ /m.test(content)) {
    const diff = editDiff(call, content);
    if (diff) return { kind: 'diff', diff: diff.text, numbered: diff.numbered, path: diff.path };
  }
  if (status === 'cancel') {
    // Keep the partial output's own indentation: drop only blank lines around it.
    const partial = content.split('\n').slice(1).join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
    return partial ? { kind: 'text', lines: partial.split('\n') } : null;
  }
  const obj = parseObject(content);

  if (family === 'exec' && obj) {
    const commands = execCommands(obj);
    if (commands.length > 0) {
      const lines: Array<{ text: string; tone: BodyTone }> = [];
      let dropped = 0;
      for (const c of commands) {
        if (commands.length > 1 && c.cmd) lines.push({ text: `$ ${c.cmd}`, tone: 'muted' });
        for (const text of c.stdout.replace(/\n$/, '').split('\n')) if (c.stdout !== '') lines.push({ text: cellText(text), tone: 'text' });
        for (const text of c.stderr.replace(/\n$/, '').split('\n')) if (c.stderr !== '') lines.push({ text: cellText(text), tone: c.exitCode === 0 ? 'muted' : 'bad' });
        dropped += c.droppedLines;
      }
      const exits = commands.map((c) => (c.skipped ? 'skipped' : c.timedOut ? 'timed out' : c.exitCode === null || c.exitCode === undefined ? 'no exit code' : `exit ${c.exitCode}`));
      const footer = [commands.length === 1 ? exits[0] : `${plural(commands.length, 'command')}`, dropped > 0 ? `${dropped} lines trimmed by the tool` : undefined].filter(Boolean).join(' · ');
      if (lines.length === 0) return { kind: 'output', lines: [{ text: 'no output', tone: 'faint' }], footer };
      return { kind: 'output', lines, footer };
    }
  }
  if (family === 'read' && obj && Array.isArray(obj.files)) {
    const items = obj.files.filter((f): f is Json => f !== null && typeof f === 'object').map((f) => {
      const path = str(f.path) ?? str(f.resolvedPath) ?? '?';
      const lines = num(f.lineCount);
      const error = str(f.error);
      return { text: path, detail: error ? error : lines !== undefined ? plural(lines, 'line') : undefined };
    });
    if (items.length > 0) return { kind: 'list', items };
  }
  if (family === 'find' && obj) {
    const entries: Array<{ file: string; line?: number; text?: string }> = [];
    findEntries(obj, entries);
    if (entries.length > 0) {
      return {
        kind: 'list',
        items: entries.map((e) => ({ text: e.line !== undefined ? `${e.file}:${e.line}` : e.file, detail: e.text?.trim() })),
      };
    }
  }
  if (obj) {
    const lines = flattenObject(obj);
    return lines.length > 0 ? { kind: 'text', lines } : null;
  }
  const trimmed = content.replace(/\n+$/, '');
  if (trimmed.trim() === '') return null;
  // A JSON array or other structured text still never shows raw: one entry per line.
  if (trimmed.trimStart().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return { kind: 'text', lines: parsed.map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? flattenObject(v as Json).join('  ') : String(v))) };
      }
    } catch {
      // Not JSON after all, falls through to plain text.
    }
  }
  return { kind: 'text', lines: trimmed.split('\n').map((l) => cellText(l)) };
}

/** Compact duration for a bead row: 0.2s, 1.4s, 38s, 2m 14s, 1h 02m. */
export function formatBeadTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, '0')}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** Compact dollars: $0.12, $1.40, $12. */
export function formatCost(usd: number): string {
  if (usd >= 10) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

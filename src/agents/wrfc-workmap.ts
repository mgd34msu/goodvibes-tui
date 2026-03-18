import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../utils/logger.ts';

export interface WorkmapEntry {
  ts: string;
  wrfcId: string;
  event: 'engineer_complete' | 'review_complete' | 'fix_started' | 'gate_result' | 'chain_passed' | 'chain_failed';
  agentId?: string;
  task?: string;        // original task (on first engineer_complete only)
  score?: number;       // review score
  passed?: boolean;     // review passed or gate passed
  issues?: Array<{ severity: string; description: string; file?: string }>;  // review issues (truncated)
  gate?: string;        // gate name
  gateOutput?: string;  // gate output (truncated to 200 chars)
  attempt?: number;     // fix attempt number
  reason?: string;      // failure reason
}

export class WrfcWorkmap {
  private filePath: string;

  constructor(sessionId: string) {
    this.filePath = join(process.cwd(), '.goodvibes', 'tui', 'sessions', `${sessionId}_workmap.jsonl`);
  }

  private dirCreated = false;

  append(entry: WorkmapEntry): void {
    try {
      if (!this.dirCreated) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.dirCreated = true;
      }
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      logger.debug('WrfcWorkmap: append failed', { error: String(err) });
    }
  }

  /** Read all entries, optionally filtered by wrfcId */
  read(wrfcId?: string): WorkmapEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      const entries = lines.map(line => {
        try { return JSON.parse(line) as WorkmapEntry; } catch { logger.debug('WrfcWorkmap: malformed JSONL line skipped'); return null; }
      }).filter((e): e is WorkmapEntry => e !== null);
      if (wrfcId) return entries.filter(e => e.wrfcId === wrfcId);
      return entries;
    } catch {
      return [];
    }
  }

  /** Get all unique WRFC chain IDs with their latest status */
  listChains(): Array<{ wrfcId: string; task?: string; status: string; lastScore?: number; events: number }> {
    const entries = this.read();
    const chains = new Map<string, { task?: string; status: string; lastScore?: number; events: number }>();
    for (const e of entries) {
      const existing = chains.get(e.wrfcId) ?? { status: 'active', events: 0 };
      existing.events++;
      if (e.task) existing.task = e.task;
      if (e.score !== undefined) existing.lastScore = e.score;
      if (e.event === 'chain_passed') existing.status = 'passed';
      if (e.event === 'chain_failed') existing.status = 'failed';
      chains.set(e.wrfcId, existing);
    }
    return Array.from(chains.entries()).map(([wrfcId, data]) => ({ wrfcId, ...data }));
  }

  /** Static: find the most recent workmap file in sessions dir */
  static findLatest(sessionsDir?: string): string | null {
    const dir = sessionsDir ?? join(process.cwd(), '.goodvibes', 'tui', 'sessions');
    if (!existsSync(dir)) return null;
    try {
      const files = readdirSync(dir)
        .filter((f: string) => f.endsWith('_workmap.jsonl'))
        .map((f: string) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
      return files.length > 0 ? join(dir, files[0].name) : null;
    } catch { return null; }
  }
}

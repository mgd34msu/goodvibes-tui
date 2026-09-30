/**
 * (d) A WRFC chain through the built binary reaches its fix phase and merges.
 *
 * The user asks for a reviewed fix; the scripted model plays every role the
 * way a real one would, through real tool calls: the main conversation spawns
 * an engineer with reviewMode=wrfc, the engineer writes src/math.ts with the
 * bug still in it, the first chain review fails with one finding, the fix
 * engineer writes the correction, the item review and the chain's second
 * review pass, and the passed chain lands the fix on the workspace's branch.
 *
 * Fails when: a failing review does not start a fix (no fix-engineer turn),
 * the fix never merges (src/math.ts on main still subtracts), or the chain
 * ends without a second review.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  firstUserText, hasToolResult, inputAreaVisible, launchTui, makeHome, offeredTools, openingText,
  startStubModel, waitFor, type ModelReply, type TuiSession,
} from './harness.ts';

const PROMPT = 'use a reviewed wrfc chain to repair the add function';
const TASK = 'Fix add() in src/math.ts so it returns the sum of its two arguments.';
const BUGGY = 'export function add(a: number, b: number): number {\n  return a - b;\n}\n';
const STILL_BUGGY = '/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a - b;\n}\n';
const FIXED = '/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n';

function fenced(report: Record<string, unknown>): string {
  return ['```json', JSON.stringify(report), '```'].join('\n');
}

function engineerReport(summary: string): ModelReply {
  return { text: fenced({
    version: 1, archetype: 'engineer', summary, gatheredContext: [], plannedActions: [],
    appliedChanges: [summary], filesCreated: [], filesModified: ['src/math.ts'], filesDeleted: [],
    decisions: [], issues: [], uncertainties: [], constraints: [],
  }) };
}

function reviewerReport(passed: boolean): ModelReply {
  return { text: fenced({
    version: 1, archetype: 'reviewer', summary: passed ? 'add() returns the sum' : 'add() still subtracts',
    score: passed ? 10 : 4, passed, dimensions: [],
    issues: passed ? [] : [{ severity: 'major', description: 'add() still returns a - b; it must return a + b.', file: 'src/math.ts', line: 3, pointValue: 6 }],
    constraintFindings: [],
    acceptanceChecklist: [{ item: 'add is exported from src/math.ts', verified: true, evidence: 'read src/math.ts' }],
  }) };
}

function write(content: string): ModelReply {
  return { toolCalls: [{ name: 'write', arguments: { files: [{ path: 'src/math.ts', content, mode: 'overwrite' }] } }] };
}

/** What the scripted model was asked to do, in order. */
const played: string[] = [];
let chainReviews = 0;

const model = startStubModel((request) => {
  const opening = openingText(request);
  const acted = hasToolResult(request);
  if (opening.includes('Assess the following work item')) {
    played.push('item-review');
    return reviewerReport(true);
  }
  if (opening.includes('WRFC Review Request')) {
    chainReviews += 1;
    played.push(`chain-review-${chainReviews}`);
    return reviewerReport(chainReviews > 1);
  }
  if (opening.includes('FIX THIS REVIEW FINDING')) {
    if (acted) return engineerReport('add() now returns a + b');
    played.push('fix-engineer');
    return write(FIXED);
  }
  // The engineer opens on the user's original ask, like the main conversation,
  // but is offered the file tools and not the agent tool.
  const tools = offeredTools(request);
  const asked = firstUserText(request).includes(PROMPT);
  if (asked && tools.includes('write') && !tools.includes('agent')) {
    if (acted) return engineerReport('documented add()');
    played.push('engineer');
    return write(STILL_BUGGY);
  }
  if (asked) {
    if (acted) return { text: 'The reviewed chain is running.' };
    played.push('main');
    return { toolCalls: [{ name: 'agent', arguments: { mode: 'spawn', task: TASK, template: 'engineer', reviewMode: 'wrfc' } }] };
  }
  return { text: 'E2E side request' };
});

let tui: TuiSession | null = null;
afterAll(() => { tui?.stop(); model.stop(); });

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return out.stdout;
}

describe('WRFC chain', () => {
  test('a failing review starts a fix, the re-review passes, and the fix merges', async () => {
    const home = await makeHome(model);
    mkdirSync(join(home.workspace, 'src'), { recursive: true });
    writeFileSync(join(home.workspace, 'src', 'math.ts'), BUGGY);
    spawnSync('git', ['add', '-A'], { cwd: home.workspace, env: { PATH: process.env['PATH'] ?? '', HOME: home.home } });
    spawnSync('git', ['commit', '-q', '-m', 'add math'], { cwd: home.workspace, env: { PATH: process.env['PATH'] ?? '', HOME: home.home } });
    const commitsBefore = Number(git(home.workspace, 'rev-list', '--count', 'HEAD').trim());
    // Nobody answers permission prompts here: foreground and background tool
    // calls run the way a user who allowed them runs them.
    home.setTuiSetting('permissions.mode', 'allow-all');
    home.setTuiSetting('permissions.backgroundAgents', 'allow-all');
    home.setTuiSetting('wrfc.autoCommit', true);

    tui = launchTui(home, { cols: 120, rows: 40 });
    await tui.waitForScreen('the input area', inputAreaVisible, 45_000);
    tui.type(PROMPT);
    tui.key('Enter');

    await waitFor('the second chain review', () => played.includes('chain-review-2'), 150_000, 250);
    const landed = await waitFor('the fix on the workspace branch', () => {
      const onDisk = readFileSync(join(home.workspace, 'src', 'math.ts'), 'utf8');
      return onDisk === FIXED && git(home.workspace, 'show', 'HEAD:src/math.ts') === FIXED ? onDisk : false;
    }, 60_000, 250);

    expect(played.slice(0, 4)).toEqual(['main', 'engineer', 'chain-review-1', 'fix-engineer']);
    expect(played).toContain('item-review');
    expect(landed).toBe(FIXED);
    expect(Number(git(home.workspace, 'rev-list', '--count', 'HEAD').trim())).toBeGreaterThan(commitsBefore);
    expect(git(home.workspace, 'status', '--porcelain', '--', 'src/math.ts').trim()).toBe('');
    expect(tui.alive()).toBe(true);
  }, 240_000);
});

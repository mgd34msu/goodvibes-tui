import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveEditorCommand, openComposerInEditor, type EditorSpawn } from '@/input/composer-editor.ts';

describe('resolveEditorCommand', () => {
  test('prefers $VISUAL over $EDITOR', () => {
    expect(resolveEditorCommand({ VISUAL: 'code -w', EDITOR: 'vi' })).toEqual({ cmd: 'code', args: ['-w'] });
  });
  test('falls back to $EDITOR', () => {
    expect(resolveEditorCommand({ EDITOR: 'nano' })).toEqual({ cmd: 'nano', args: [] });
  });
  test('returns null when neither is set', () => {
    expect(resolveEditorCommand({})).toBeNull();
    expect(resolveEditorCommand({ EDITOR: '   ' })).toBeNull();
  });
});

function harness(overrides: Partial<{ initial: string; env: NodeJS.ProcessEnv; spawn: EditorSpawn }> = {}) {
  const events: string[] = [];
  let draft = overrides.initial ?? 'initial draft';
  const messages: string[] = [];
  openComposerInEditor({
    readDraft: () => draft,
    writeDraft: (t) => { draft = t; },
    cwd: '/tmp',
    env: overrides.env ?? { EDITOR: 'fake' },
    suspend: () => events.push('suspend'),
    resume: () => events.push('resume'),
    notify: (m) => messages.push(m),
    spawn: overrides.spawn,
  });
  return { getDraft: () => draft, events, messages };
}

describe('openComposerInEditor', () => {
  test('round-trips the edited file back into the draft', () => {
    const spawn: EditorSpawn = (_cmd, args) => {
      const file = args[args.length - 1]!;
      writeFileSync(file, readFileSync(file, 'utf8') + ' + edited\n', 'utf8');
      return { status: 0 };
    };
    const h = harness({ initial: 'hello', spawn });
    expect(h.getDraft()).toBe('hello + edited'); // trailing newline stripped
    expect(h.events).toEqual(['suspend', 'resume']); // suspended around the launch
    expect(h.messages.some((m) => m.includes('updated'))).toBe(true);
  });

  test('does nothing when no editor is configured', () => {
    let spawned = false;
    const h = harness({ env: {}, spawn: () => { spawned = true; return { status: 0 }; } });
    expect(spawned).toBe(false);
    expect(h.getDraft()).toBe('initial draft');
    expect(h.messages[0]).toContain('$EDITOR');
  });

  test('leaves the draft unchanged on a non-zero editor exit', () => {
    const h = harness({ initial: 'keep me', spawn: () => ({ status: 1 }) });
    expect(h.getDraft()).toBe('keep me');
    expect(h.events).toEqual(['suspend', 'resume']);
    expect(h.messages.some((m) => m.includes('exited with code 1'))).toBe(true);
  });

  test('reports a spawn error and resumes the terminal', () => {
    const h = harness({ spawn: () => ({ status: null, error: new Error('ENOENT') }) });
    expect(h.events).toEqual(['suspend', 'resume']);
    expect(h.messages.some((m) => m.includes('Failed to launch'))).toBe(true);
  });
});

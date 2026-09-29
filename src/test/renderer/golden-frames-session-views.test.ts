// ---------------------------------------------------------------------------
// golden-frames-session-views.test.ts, an agent and a background process
// opened full screen, and the session chips row on the main screen.
//
// The concept page's agent-focus and process-focus scenes, rendered through
// the real view path (shell/session-views.ts) over fake agent and process
// managers at a fixed clock (helpers/session-view-scenes.ts). The layout audit
// runs on every frame here and again in golden-frames-audit.test.ts.
//
// Theme sets: golden-frames/ for goodvibes (this file), and
// golden-frames-goodvibes-neon/ through golden-frames-session-views-neon.test.ts.
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-session-views.test.ts
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-session-views-neon.test.ts
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC'; // the process view's clock times

import { describe, expect, test } from 'bun:test';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { activeTokens, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { auditFrame } from '../helpers/frame-audit.ts';
import { assertGoldenIn, encodeGolden } from '../helpers/golden-snapshot.ts';
import { makeViewScene, renderViewScreen } from '../helpers/session-view-scenes.ts';

const THEME = process.env['GOODVIBES_GOLDEN_THEME'] ?? 'goodvibes';
setActiveThemeName(THEME);
setActiveThemeMode('dark');
const DIR = new URL(THEME === 'goodvibes' ? './golden-frames/' : `./golden-frames-${THEME}/`, import.meta.url).pathname;

const FRAMES: ReadonlyArray<{ readonly name: string; readonly width: number; readonly height: number; readonly render: () => Line[] }> = [
  { name: 'agent-view-120x30', width: 120, height: 30, render: () => { const s = makeViewScene(); s.views.open({ kind: 'agent', id: 'eng' }); return renderViewScreen(s, 120, 30); } },
  { name: 'agent-view-80x24', width: 80, height: 24, render: () => { const s = makeViewScene(); s.views.open({ kind: 'agent', id: 'eng' }); return renderViewScreen(s, 80, 24); } },
  { name: 'agent-view-child-stop-armed', width: 120, height: 30, render: () => {
    const s = makeViewScene(); s.views.open({ kind: 'agent', id: 'tester' }); s.views.pressStop(); return renderViewScreen(s, 120, 30);
  } },
  { name: 'process-view-120x30', width: 120, height: 30, render: () => { const s = makeViewScene(); s.views.open({ kind: 'process', id: 'bg-1' }); return renderViewScreen(s, 120, 30); } },
  { name: 'process-view-80x24', width: 80, height: 24, render: () => { const s = makeViewScene(); s.views.open({ kind: 'process', id: 'bg-1' }); return renderViewScreen(s, 80, 24); } },
  { name: 'process-view-search', width: 120, height: 30, render: () => {
    const s = makeViewScene(); s.views.open({ kind: 'process', id: 'bg-1' }); s.views.startSearch(); s.views.searchType('client'); return renderViewScreen(s, 120, 30);
  } },
  { name: 'session-chips-main-120', width: 120, height: 8, render: () => renderViewScreen(makeViewScene(), 120, 8) },
  { name: 'session-chips-main-80', width: 80, height: 8, render: () => renderViewScreen(makeViewScene(), 80, 8) },
];

describe(`golden-frames : session views (${THEME})`, () => {
  for (const frame of FRAMES) {
    test(frame.name, () => {
      const lines = frame.render();
      expect(lines).toHaveLength(frame.height);
      expect(lines.every((l) => l.length === frame.width)).toBe(true);
      assertGoldenIn(DIR, frame.name, lines);
      expect(encodeGolden(frame.name, frame.render())).toBe(encodeGolden(frame.name, lines));
      expect(auditFrame(lines, frame.width, activeTokens()).map((i) => `${i.kind} row ${i.row}: ${i.detail}`)).toEqual([]);
    });
  }
});

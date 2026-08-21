/**
 * The footer's context-info line carries a persistent `web:<url>` segment when
 * the web surface is enabled (webSurfaceUrl defined); undefined renders no
 * segment, matching the plain `spine:`/`notify:`/`N tools` context style.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText } from '../setup.ts';

const W = 160;

function footerText(webSurfaceUrl: string | undefined): string {
  const lines = UIFactory.createFooter(
    W,
    '> prompt',
    { up: 0, down: 0 },
    false,             // showExitNotice
    0,                 // lastCopyTime
    'claude-opus-4',   // model
    5,                 // toolCount
    undefined,         // cursorPos
    '/workspace/proj', // workingDir
    'anthropic',       // provider
    0,                 // contextWindow
    undefined,         // compactThreshold
    false,             // dangerMode
    undefined,         // lastInputTokens
    undefined,         // commandArgsHint
    'balanced',        // hitlMode
    true,              // promptFocused
    undefined,         // composerMode
    undefined,         // composerStatus
    undefined,         // composerFlags
    undefined,         // composerPendingRisk
    false,             // compact
    undefined,         // sessionSpineStatus
    undefined,         // permissionMode
    webSurfaceUrl,     // webSurfaceUrl
  );
  return linesToText(lines).join('\n');
}

describe('footer: web-surface URL segment', () => {
  test('enabled: renders "web:<url>"', () => {
    const text = footerText('http://127.0.0.1:3423');
    expect(text).toContain('web:http://127.0.0.1:3423');
  });

  test('disabled/undefined: no web segment', () => {
    const text = footerText(undefined);
    expect(text).not.toContain('web:');
  });
});

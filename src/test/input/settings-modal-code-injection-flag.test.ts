/**
 * Wave-5 Stage B — the `agent-passive-code-injection` feature flag surfaces in the
 * settings modal flags section. buildFlagEntries maps every flag the FeatureFlagManager
 * knows about, so this pins that the SDK flag reaches the TUI's flags list (default off).
 */
import { describe, expect, test } from 'bun:test';
import { buildFlagEntries } from '../../input/settings-modal-data.ts';
import { createFeatureFlagManager } from '../../runtime/index.ts';

describe('settings modal — Stage B code-injection flag', () => {
  test('agent-passive-code-injection appears in the flags section, default off', () => {
    const manager = createFeatureFlagManager();
    const entries = buildFlagEntries(manager);
    const entry = entries.find((e) => e.flag.id === 'agent-passive-code-injection');
    expect(entry).toBeDefined();
    expect(entry!.flag.name).toContain('Code Injection');
    // Default off: an untouched manager reports the flag's disabled default state.
    expect(entry!.state).toBe('disabled');
  });
});

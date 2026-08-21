import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { applyRuntimeConfigValue } from '@pellux/goodvibes-terminal-shell';
import { buildPermissionProvenance, renderPermissionProvenance } from '../../input/commands/permissions-provenance.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function findRow(prov: ReturnType<typeof buildPermissionProvenance>, key: string) {
  const row = prov.rows.find((r) => r.key === key);
  if (!row) throw new Error(`missing row ${key}`);
  return row;
}

describe('permission provenance', () => {
  let root = '';
  beforeEach(() => { root = makeProjectTempDir('gv-prov'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('an unset value reports the built-in default and the session mode', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    const prov = buildPermissionProvenance(cm);
    expect(prov.sessionMode).toBe(String(cm.get('permissions.mode')));
    const mode = findRow(prov, 'permissions.mode');
    expect(mode.origin).toBe('built-in default');
    expect(mode.recorded).toBe(true);
    expect(mode.overridden).toBe(false);
  });

  test('a persisted value is attributed to the global config file with its path', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    cm.set('permissions.mode', 'custom'); // set() auto-persists to disk
    const mode = findRow(buildPermissionProvenance(cm), 'permissions.mode');
    expect(mode.value).toBe('custom');
    expect(mode.recorded).toBe(true);
    expect(mode.overridden).toBe(false);
    expect(mode.origin).toContain('config file');
    expect(mode.originPath).toBe(cm.getConfigPath());
  });

  test('a runtime --config override is labelled not-recorded-on-disk, not mis-attributed', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    // Mutates the in-memory config WITHOUT persisting, exactly what CLI --config does.
    applyRuntimeConfigValue(cm as never, 'permissions.mode', 'allow-all');
    const mode = findRow(buildPermissionProvenance(cm), 'permissions.mode');
    expect(mode.value).toBe('allow-all');
    expect(mode.overridden).toBe(true);
    expect(mode.recorded).toBe(false);
    expect(mode.origin).toContain('not recorded on disk');
    // The recorded on-disk / default value is preserved for the reader.
    expect(mode.recordedValue).not.toBe('allow-all');
  });

  test('render shows the legend and traces every permission tool rule', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    const text = renderPermissionProvenance(buildPermissionProvenance(cm));
    expect(text).toContain('session mode:');
    expect(text).toContain('Tool rule: exec');
    expect(text).toContain('origin not recorded');
    expect(text).toContain('origin:');
  });

  test('shipped credential-read rules surface honestly as shipped defaults, not config-key rows', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    const prov = buildPermissionProvenance(cm);
    expect(prov.shippedRules.length).toBeGreaterThan(0);
    const rule = prov.shippedRules.find((r) => r.id === 'shipped-credential-read-deny');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('deny');
    expect(rule!.pathPatterns.length).toBeGreaterThan(0);
    // Not a ConfigKey row, no shipped rule id should collide with a PERMISSION_KEYS entry.
    expect(prov.rows.some((r) => r.key === rule!.id)).toBe(false);

    const text = renderPermissionProvenance(prov);
    expect(text).toContain('Shipped policy rules');
    expect(text).toContain('shipped-credential-read-deny');
    expect(text).toContain('origin: shipped default (SDK-managed policy rule)');
  });
});

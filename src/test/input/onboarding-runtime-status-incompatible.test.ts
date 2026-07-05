/**
 * onboarding-runtime-status-incompatible.test.ts
 *
 * The SDK adopt-or-start path now reports a distinct `incompatible` host-service
 * mode: a GoodVibes daemon holds the configured port but speaks a wire version
 * this surface cannot adopt, so the TUI neither adopted it nor started a
 * competing daemon. These tests pin the TUI's honest surfacing of that mode —
 * it must never be mislabeled as an adopted/embedded ("running") service, must
 * report the port as occupied, and must not be treated as an active endpoint.
 */

import { describe, expect, test } from 'bun:test';
import {
  runtimePortDiagnostic,
  isRuntimeEndpointActive,
  isRuntimeEndpointOccupyingConfiguredPort,
  type OnboardingExternalServiceState,
} from '../../input/onboarding/onboarding-runtime-status.ts';
import type { HostServiceStatus } from '../../runtime/index.ts';

const binding = { label: 'GoodVibes daemon', host: '127.0.0.1', port: 3421 };

function incompatibleStatus(): HostServiceStatus {
  return {
    mode: 'incompatible',
    host: '127.0.0.1',
    port: 3421,
    baseUrl: 'http://127.0.0.1:3421',
    version: '0.35.0',
    authenticated: true,
    status: 'running',
    reason:
      'A GoodVibes daemon (version 0.35.0) is running on 127.0.0.1:3421, but this surface (version 0.38.0) speaks an incompatible wire version — not adopting, and not starting a second daemon on the occupied port.',
  };
}

function stateWith(status: HostServiceStatus): OnboardingExternalServiceState {
  return {
    daemonStatus: status,
    daemonRunning: false,
    daemonPortInUse: true,
  };
}

describe('incompatible daemon posture surfacing', () => {
  test('runtimePortDiagnostic states the version mismatch honestly, not "running"', () => {
    const message = runtimePortDiagnostic(binding, true, incompatibleStatus());
    expect(message).toContain('not wire-compatible');
    expect(message).toContain('not adopted');
    expect(message).toContain('0.35.0');
    // It must NOT claim an embedded/verified service is running for us.
    expect(message).not.toContain('embedded GoodVibes service is running');
    expect(message).not.toContain('was verified');
  });

  test('an incompatible daemon is NOT an active endpoint (it was not adopted)', () => {
    expect(isRuntimeEndpointActive(stateWith(incompatibleStatus()), 'daemon')).toBe(false);
  });

  test('an incompatible daemon DOES occupy the configured port', () => {
    expect(isRuntimeEndpointOccupyingConfiguredPort(stateWith(incompatibleStatus()), 'daemon')).toBe(true);
  });

  test('a verified external daemon remains active and occupying (regression guard)', () => {
    const external: HostServiceStatus = { ...incompatibleStatus(), mode: 'external' };
    const state = stateWith(external);
    expect(isRuntimeEndpointActive(state, 'daemon')).toBe(true);
    expect(isRuntimeEndpointOccupyingConfiguredPort(state, 'daemon')).toBe(true);
  });
});

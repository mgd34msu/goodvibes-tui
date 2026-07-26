// ---------------------------------------------------------------------------
// replication-policy-drift.test.ts — the two halves of one derivation.
//
// Cluster config replication decides WHICH credential belongs to a replicated
// setting by deriving the secret-store name from the config path. That
// derivation already existed in this repository (`buildGoodVibesSecretKey`) and
// had to be written a second time in the SDK, which cannot import from here.
//
// Two copies of a rule is a rule that drifts. If they ever disagree, a
// credential either fails to replicate — a machine wins a surface it cannot
// serve — or a secret nobody intended to share is selected by a name the SDK
// derived and this repository did not. This pins them together.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import {
  isReplicatedConfigPath,
  isReplicatedSecretKey,
  listReplicatedConfigPaths,
  replicatedSecretKeyFor,
} from '@pellux/goodvibes-sdk/platform/cluster';
import { buildGoodVibesSecretKey } from '../../config/secret-config.ts';

describe('the secret-name derivation', () => {
  test('agrees with this repository, for every path that replicates', () => {
    const paths = listReplicatedConfigPaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(replicatedSecretKeyFor(path), `${path} derives a different secret name in the SDK`)
        .toBe(buildGoodVibesSecretKey(path));
    }
  });

  test('agrees on the awkward shapes too, not just the simple ones', () => {
    for (const path of ['surfaces.slack.botToken', 'a.b-c.d_e', 'surfaces.ntfy.topic', 'x']) {
      expect(replicatedSecretKeyFor(path)).toBe(buildGoodVibesSecretKey(path));
    }
  });
});

describe('what this machine will accept from the group', () => {
  test('nothing machine-specific, so a replicated port can never collide', () => {
    // The concrete failure this rule exists to prevent: two daemons handed the
    // same control-plane port, the second of which cannot bind.
    expect(isReplicatedConfigPath('controlPlane.port')).toBe(false);
    expect(isReplicatedConfigPath('httpListener.port')).toBe(false);
    expect(isReplicatedConfigPath('cluster.port')).toBe(false);
    expect(isReplicatedConfigPath('cluster.enabled')).toBe(false);
  });

  test('and no client or user preference, whatever a peer claims', () => {
    expect(isReplicatedConfigPath('display.stream')).toBe(false);
    expect(isReplicatedConfigPath('provider.model')).toBe(false);
    expect(isReplicatedConfigPath('daemon.enabled')).toBe(false);
  });

  test('the group key material is not selectable as a replicated secret', () => {
    expect(isReplicatedSecretKey('cluster.groupMaterial')).toBe(false);
    expect(isReplicatedSecretKey(buildGoodVibesSecretKey('cluster.secret'))).toBe(false);
  });
});

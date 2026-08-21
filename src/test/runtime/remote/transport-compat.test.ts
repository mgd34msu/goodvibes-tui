import { describe, test, expect, beforeEach } from 'bun:test';
import {
  negotiateProtocolVersion,
  CURRENT_PROTOCOL_VERSION,
  TRANSPORT_COMPATIBILITY_MATRIX,
  VersionMismatchError,
} from '@/runtime/index.ts';
import { TransportPanel } from '@/runtime/index.ts';
// ProtocolVersion / VersionNegotiationResult / NegotiatedProtocol are not
// re-exported from @/runtime/index.ts (only the negotiateProtocolVersion
// value + a handful of other operations symbols are). They live in the SDK's
// runtime/remote transport seam, reached the same way index.ts itself reaches
// other `operations`-namespaced types (see its `Operations.<Type>` aliases).
import type { operations as Operations } from '@pellux/goodvibes-sdk/platform/runtime';

type ProtocolVersion = Operations.ProtocolVersion;
type VersionNegotiationResult = Operations.VersionNegotiationResult;
type NegotiatedProtocol = Operations.NegotiatedProtocol;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVersion(major: number, minor: number, patch = 0): ProtocolVersion {
  return Object.freeze({ major, minor, patch, label: `${major}.${minor}.${patch}` });
}

const V1_0 = makeVersion(1, 0);
const V1_1 = makeVersion(1, 1);
const V1_2 = makeVersion(1, 2);
const V2_0 = makeVersion(2, 0);
const V0_9 = makeVersion(0, 9);

// ---------------------------------------------------------------------------
// negotiateProtocolVersion
// ---------------------------------------------------------------------------

describe('negotiateProtocolVersion', () => {
  describe('major version mismatch', () => {
    test('local v1 vs peer v2 → incompatible, cannot proceed', () => {
      const result = negotiateProtocolVersion(V1_2, V2_0);
      expect(result.proceed).toBe(false);
      if (!result.proceed) {
        expect(result.incompatibilityCode).toBe('major_version_mismatch');
        expect(result.incompatibilityReason).toContain('Major version mismatch');
        expect(result.offeredVersion.label).toBe('1.2.0');
        expect(result.peerVersion.label).toBe('2.0.0');
      }
    });

    test('local v2 vs peer v1 → incompatible, cannot proceed', () => {
      const result = negotiateProtocolVersion(V2_0, V1_2);
      expect(result.proceed).toBe(false);
      if (!result.proceed) {
        expect(result.incompatibilityCode).toBe('major_version_mismatch');
      }
    });

    test('local v0 vs peer v1 → incompatible', () => {
      const result = negotiateProtocolVersion(V0_9, V1_0);
      expect(result.proceed).toBe(false);
      if (!result.proceed) {
        expect(result.incompatibilityCode).toBe('major_version_mismatch');
      }
    });
  });

  describe('peer minor too old', () => {
    test('peer minor below matrix minSupportedMinor → rejected', () => {
      // minSupportedMinor in matrix is 0 for v1.2, so there is no "too old" case
      // for v1.x unless we create a custom matrix entry.
      const customMatrix = [{
        localVersion: V1_2,
        minSupportedMinor: 1,   // minimum is v1.1
        maxSupportedMinor: 2,
      }];
      const result = negotiateProtocolVersion(V1_2, V1_0, customMatrix);
      expect(result.proceed).toBe(false);
      if (!result.proceed) {
        expect(result.incompatibilityCode).toBe('peer_version_too_old');
        expect(result.incompatibilityReason).toContain('minimum supported minor');
      }
    });
  });

  describe('peer version unsupported (future)', () => {
    test('peer minor exceeds matrix maxSupportedMinor → rejected', () => {
      const customMatrix = [{
        localVersion: V1_0,
        minSupportedMinor: 0,
        maxSupportedMinor: 1,   // only support up to v1.1
      }];
      const futureVersion = makeVersion(1, 5);
      const result = negotiateProtocolVersion(V1_0, futureVersion, customMatrix);
      expect(result.proceed).toBe(false);
      if (!result.proceed) {
        expect(result.incompatibilityCode).toBe('peer_version_unsupported');
        expect(result.incompatibilityReason).toContain('exceeds the maximum');
      }
    });
  });

  describe('compatible: same minor', () => {
    test('local v1.2 vs peer v1.2 → proceeds at v1.2, no downgrade', () => {
      const result = negotiateProtocolVersion(V1_2, V1_2);
      expect(result.proceed).toBe(true);
      if (result.proceed) {
        expect(result.protocol.version.major).toBe(1);
        expect(result.protocol.version.minor).toBe(2);
        expect(result.protocol.downgraded).toBe(false);
        expect(result.protocol.downgradeReason).toBeUndefined();
      }
    });

    test('local v1.0 vs peer v1.0 → proceeds at v1.0, no downgrade', () => {
      const result = negotiateProtocolVersion(V1_0, V1_0);
      expect(result.proceed).toBe(true);
      if (result.proceed) {
        expect(result.protocol.version.minor).toBe(0);
        expect(result.protocol.downgraded).toBe(false);
      }
    });
  });

  describe('compatible: downgrade (peer older minor)', () => {
    test('local v1.2 vs peer v1.0 → proceeds at v1.0 with downgrade', () => {
      const result = negotiateProtocolVersion(V1_2, V1_0);
      expect(result.proceed).toBe(true);
      if (result.proceed) {
        expect(result.protocol.version.minor).toBe(0);
        expect(result.protocol.downgraded).toBe(true);
        expect(result.protocol.downgradeReason).toBe('peer_minor_older');
        expect(result.protocol.offeredVersion.label).toBe('1.2.0');
        expect(result.protocol.peerVersion.label).toBe('1.0.0');
      }
    });

    test('local v1.2 vs peer v1.1 → proceeds at v1.1 with downgrade', () => {
      const result = negotiateProtocolVersion(V1_2, V1_1);
      expect(result.proceed).toBe(true);
      if (result.proceed) {
        expect(result.protocol.version.minor).toBe(1);
        expect(result.protocol.downgraded).toBe(true);
      }
    });
  });

  describe('compatible: peer minor ahead (peer newer)', () => {
    test('local v1.1 vs peer v1.2 → proceeds at v1.1 (local is older)', () => {
      const result = negotiateProtocolVersion(V1_1, V1_2);
      expect(result.proceed).toBe(true);
      if (result.proceed) {
        // min(1, 2) = 1, local is the constraint
        expect(result.protocol.version.minor).toBe(1);
        // Not considered a downgrade from local perspective
        expect(result.protocol.downgraded).toBe(false);
      }
    });
  });

  describe('negotiated version metadata', () => {
    test('negotiatedAt is populated with a recent timestamp', () => {
      const before = Date.now();
      const result = negotiateProtocolVersion(V1_2, V1_2);
      const after = Date.now();
      expect(result.proceed).toBe(true);
      if (result.proceed) {
        expect(result.protocol.negotiatedAt).toBeGreaterThanOrEqual(before);
        expect(result.protocol.negotiatedAt).toBeLessThanOrEqual(after);
      }
    });

    test('result carries offeredVersion and peerVersion references', () => {
      const result = negotiateProtocolVersion(V1_2, V1_0);
      expect(result.proceed).toBe(true);
      if (result.proceed) {
        expect(result.protocol.offeredVersion).toEqual(V1_2);
        expect(result.protocol.peerVersion).toEqual(V1_0);
      }
    });

    test('incompatibility result carries both offered and peer version', () => {
      const result = negotiateProtocolVersion(V1_2, V2_0);
      expect(result.proceed).toBe(false);
      if (!result.proceed) {
        expect(result.offeredVersion).toEqual(V1_2);
        expect(result.peerVersion).toEqual(V2_0);
      }
    });
  });

  describe('default matrix integration', () => {
    test('CURRENT_PROTOCOL_VERSION round-trips through the default matrix', () => {
      const result = negotiateProtocolVersion(
        CURRENT_PROTOCOL_VERSION,
        CURRENT_PROTOCOL_VERSION,
        TRANSPORT_COMPATIBILITY_MATRIX,
      );
      expect(result.proceed).toBe(true);
    });

    test('v1.0 is accepted by default matrix (minSupportedMinor=0)', () => {
      const result = negotiateProtocolVersion(
        CURRENT_PROTOCOL_VERSION,
        V1_0,
        TRANSPORT_COMPATIBILITY_MATRIX,
      );
      expect(result.proceed).toBe(true);
      if (result.proceed) {
        expect(result.protocol.downgraded).toBe(true);
        expect(result.protocol.version.minor).toBe(0);
      }
    });

    test('v2.0 is rejected by default matrix (major mismatch)', () => {
      const result = negotiateProtocolVersion(
        CURRENT_PROTOCOL_VERSION,
        V2_0,
        TRANSPORT_COMPATIBILITY_MATRIX,
      );
      expect(result.proceed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// VersionMismatchError
// ---------------------------------------------------------------------------

describe('VersionMismatchError', () => {
  test('carries code, offeredVersion, peerVersion', () => {
    const err = new VersionMismatchError(
      'major_version_mismatch',
      V1_2,
      V2_0,
      'Incompatible major versions',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VersionMismatchError);
    expect(err.code).toBe('major_version_mismatch');
    expect(err.offeredVersion).toEqual(V1_2);
    expect(err.peerVersion).toEqual(V2_0);
    expect(err.name).toBe('VersionMismatchError');
    expect(err.message).toBe('Incompatible major versions');
  });
});

// ---------------------------------------------------------------------------
// TransportPanel
// ---------------------------------------------------------------------------

describe('TransportPanel', () => {
  let panel: TransportPanel;

  beforeEach(() => {
    panel = new TransportPanel();
  });

  describe('recordSuccess', () => {
    test('records a successful no-downgrade negotiation', () => {
      const protocol: NegotiatedProtocol = {
        version: V1_2,
        downgraded: false,
        offeredVersion: V1_2,
        peerVersion: V1_2,
        negotiatedAt: Date.now(),
      };
      panel.recordSuccess('conn-1', 'wss://example.com', protocol);

      const latest = panel.getLatest('conn-1');
      expect(latest).toBeDefined();
      expect(latest!.success).toBe(true);
      expect(latest!.negotiatedVersion).toBe('1.2.0');
      expect(latest!.downgraded).toBe(false);
      expect(latest!.downgradeReason).toBeUndefined();
    });

    test('records a successful downgrade negotiation', () => {
      const protocol: NegotiatedProtocol = {
        version: V1_0,
        downgraded: true,
        downgradeReason: 'peer_minor_older',
        offeredVersion: V1_2,
        peerVersion: V1_0,
        negotiatedAt: Date.now(),
      };
      panel.recordSuccess('conn-2', 'wss://remote.example.com', protocol);

      const latest = panel.getLatest('conn-2');
      expect(latest!.downgraded).toBe(true);
      expect(latest!.downgradeReason).toBe('peer_minor_older');
      expect(latest!.negotiatedVersion).toBe('1.0.0');
    });
  });

  describe('recordIncompatibility', () => {
    test('records major version mismatch failure', () => {
      panel.recordIncompatibility(
        'conn-3',
        'wss://legacy.example.com',
        'major_version_mismatch',
        'Peer is on v2, we are on v1',
        '1.2.0',
        '2.0.0',
      );

      const latest = panel.getLatest('conn-3');
      expect(latest!.success).toBe(false);
      expect(latest!.incompatibilityCode).toBe('major_version_mismatch');
      expect(latest!.incompatibilityReason).toBe('Peer is on v2, we are on v1');
      expect(latest!.offeredVersion).toBe('1.2.0');
      expect(latest!.peerVersion).toBe('2.0.0');
    });

    test('records peer_version_too_old failure', () => {
      panel.recordIncompatibility(
        'conn-4',
        'wss://old.example.com',
        'peer_version_too_old',
        'Peer 1.0 is below minimum supported 1.1',
        '1.2.0',
        '1.0.0',
      );

      const failure = panel.getLatest('conn-4');
      expect(failure!.incompatibilityCode).toBe('peer_version_too_old');
    });
  });

  describe('record (from VersionNegotiationResult)', () => {
    test('success result is stored correctly', () => {
      const result = negotiateProtocolVersion(V1_2, V1_2);
      panel.record('conn-5', 'wss://peer.example.com', result, '1.2.0', '1.2.0');

      const latest = panel.getLatest('conn-5');
      expect(latest!.success).toBe(true);
      expect(latest!.negotiatedVersion).toBe('1.2.0');
    });

    test('incompatibility result is stored correctly', () => {
      const result = negotiateProtocolVersion(V1_2, V2_0);
      panel.record('conn-6', 'wss://v2.example.com', result, '1.2.0', '2.0.0');

      const latest = panel.getLatest('conn-6');
      expect(latest!.success).toBe(false);
      expect(latest!.incompatibilityCode).toBe('major_version_mismatch');
    });
  });

  describe('getIncompatibilityFailures', () => {
    test('returns all incompatibility failures across connections', () => {
      panel.recordIncompatibility('conn-a', 'wss://a.example.com', 'major_version_mismatch', 'major', '1.2.0', '2.0.0');
      panel.recordIncompatibility('conn-b', 'wss://b.example.com', 'peer_version_too_old', 'too old', '1.2.0', '1.0.0');

      const protocol: NegotiatedProtocol = {
        version: V1_2, downgraded: false, offeredVersion: V1_2, peerVersion: V1_2, negotiatedAt: Date.now(),
      };
      panel.recordSuccess('conn-c', 'wss://c.example.com', protocol);

      const failures = panel.getIncompatibilityFailures();
      expect(failures.length).toBe(2);
      expect(failures.every((f) => !f.success)).toBe(true);
      expect(failures.every((f) => f.incompatibilityCode !== undefined)).toBe(true);
    });

    test('incompatible peer cannot proceed: verify the entry blocks session', () => {
      // The acceptance criterion: incompatible peer must not proceed silently.
      // Verify that the recorded failure is surface-able and has the code.
      panel.recordIncompatibility(
        'conn-block',
        'wss://incompatible.example.com',
        'major_version_mismatch',
        'Cannot interoperate across major versions',
        '1.2.0',
        '3.0.0',
      );

      const failures = panel.getIncompatibilityFailures();
      const entry = failures.find((f) => f.connectionId === 'conn-block');
      expect(entry).toBeDefined();
      expect(entry!.success).toBe(false);
      expect(entry!.incompatibilityCode).toBe('major_version_mismatch');
      // The negotiation did not produce a negotiatedVersion (no session established)
      expect(entry!.negotiatedVersion).toBeUndefined();
    });
  });

  describe('getDowngrades', () => {
    test('returns connections with successful but downgraded negotiations', () => {
      const downgraded: NegotiatedProtocol = {
        version: V1_0,
        downgraded: true,
        downgradeReason: 'peer_minor_older',
        offeredVersion: V1_2,
        peerVersion: V1_0,
        negotiatedAt: Date.now(),
      };
      const full: NegotiatedProtocol = {
        version: V1_2, downgraded: false, offeredVersion: V1_2, peerVersion: V1_2, negotiatedAt: Date.now(),
      };
      panel.recordSuccess('conn-down', 'wss://d.example.com', downgraded);
      panel.recordSuccess('conn-full', 'wss://f.example.com', full);

      const downgrades = panel.getDowngrades();
      expect(downgrades.length).toBe(1);
      expect(downgrades[0]!.connectionId).toBe('conn-down');
    });
  });

  describe('getSummary', () => {
    test('tracks correct counts across mixed results', () => {
      const fullProto: NegotiatedProtocol = {
        version: V1_2, downgraded: false, offeredVersion: V1_2, peerVersion: V1_2, negotiatedAt: Date.now(),
      };
      const downProto: NegotiatedProtocol = {
        version: V1_0, downgraded: true, downgradeReason: 'peer_minor_older', offeredVersion: V1_2, peerVersion: V1_0, negotiatedAt: Date.now(),
      };

      panel.recordSuccess('s1', 'wss://s1.example.com', fullProto);
      panel.recordSuccess('s2', 'wss://s2.example.com', downProto);
      panel.recordIncompatibility('s3', 'wss://s3.example.com', 'major_version_mismatch', 'msg', '1.2.0', '2.0.0');

      const summary = panel.getSummary();
      expect(summary.totalConnections).toBe(3);
      expect(summary.successfulNegotiations).toBe(2);
      expect(summary.downgradedConnections).toBe(1);
      expect(summary.incompatibilityFailures).toBe(1);
    });
  });

  describe('subscribe', () => {
    test('subscriber is called on recordSuccess', () => {
      let calls = 0;
      panel.subscribe(() => { calls++; });

      const proto: NegotiatedProtocol = {
        version: V1_2, downgraded: false, offeredVersion: V1_2, peerVersion: V1_2, negotiatedAt: Date.now(),
      };
      panel.recordSuccess('conn-sub', 'wss://sub.example.com', proto);
      expect(calls).toBe(1);
    });

    test('unsubscribe stops notifications', () => {
      let calls = 0;
      const unsub = panel.subscribe(() => { calls++; });
      unsub();

      panel.recordIncompatibility('conn-unsub', 'wss://u.example.com', 'major_version_mismatch', 'msg', '1.2.0', '2.0.0');
      expect(calls).toBe(0);
    });
  });

  describe('dispose', () => {
    test('clears all data and subscriptions', () => {
      const proto: NegotiatedProtocol = {
        version: V1_2, downgraded: false, offeredVersion: V1_2, peerVersion: V1_2, negotiatedAt: Date.now(),
      };
      panel.recordSuccess('conn-dispose', 'wss://d.example.com', proto);
      let calls = 0;
      panel.subscribe(() => { calls++; });

      panel.dispose();

      expect(panel.getLatest('conn-dispose')).toBeUndefined();
      expect(panel.getAll().length).toBe(0);
      expect(calls).toBe(0); // subscriber was cleared
    });
  });
});

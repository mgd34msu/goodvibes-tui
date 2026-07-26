import { describe, expect, test } from 'bun:test';
import { buildCliDoctorFindings, buildCliExposureReport, renderCliStatus, resolveDoctorExitCode } from '../../cli/status.ts';
import type { CliStatusOptions } from '../../cli/status.ts';

type ConfigValues = Record<string, unknown>;

function makeOptions(overrides: ConfigValues = {}): CliStatusOptions {
  const values: ConfigValues = {
    'provider.provider': 'openai',
    'provider.model': 'openai:gpt-5.4',
    'provider.reasoningEffort': 'high',
    'permissions.mode': 'prompt',
    'storage.secretPolicy': 'preferred_secure',
    'service.enabled': true,
    'service.autostart': true,
    'service.restartOnFailure': true,
    'daemon.enabled': true,
    'danger.httpListener': false,
    'web.enabled': false,
    'controlPlane.enabled': true,
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'httpListener.hostMode': 'local',
    'httpListener.host': '127.0.0.1',
    'httpListener.port': 3422,
    'web.hostMode': 'local',
    'web.host': '127.0.0.1',
    'web.port': 3423,
    ...overrides,
  };

  return {
    configManager: {
      get: (key: string) => values[key],
    } as CliStatusOptions['configManager'],
    workingDirectory: '/project',
    homeDirectory: '/home/test',
    onboardingMarkers: {
      project: { scope: 'project', path: '/project/.goodvibes/tui/onboarding-checked.json', exists: false, payload: null },
      user: { scope: 'user', path: '/home/test/.goodvibes/tui/onboarding-checked.json', exists: false, payload: null },
      effective: null,
    },
    auth: {
      userStorePath: '/home/test/.goodvibes/tui/auth-users.json',
      userStorePresent: true,
      bootstrapCredentialPath: '/home/test/.goodvibes/tui/auth-bootstrap.txt',
      bootstrapCredentialPresent: false,
      operatorTokenPath: '/home/test/.goodvibes/daemon/operator-tokens.json',
      operatorTokenPresent: true,
    },
  };
}

describe('CLI status and doctor output', () => {
  test('renders operator-friendly labels for permission and secret policies', () => {
    const text = renderCliStatus(makeOptions({
      'permissions.mode': 'allow-all',
      'storage.secretPolicy': 'require_secure',
    }));

    expect(text).toContain('permissions: Allow everything (allow-all)');
    expect(text).toContain('secretPolicy: Require secure storage (require_secure)');
  });

  test('doctor findings include cause, impact, and action', () => {
    const text = renderCliStatus({
      ...makeOptions({
        'permissions.mode': 'allow-all',
        'danger.httpListener': true,
        'httpListener.hostMode': 'network',
        'httpListener.host': '0.0.0.0',
      }),
      doctor: true,
    });

    expect(text).toContain('[risk:security:allow-all-permissions]');
    expect(text).toContain('cause: permissions.mode is allow-all.');
    expect(text).toContain('impact: Powerful write, edit, network, and execution tools can run without a Human-in-the-Loop (HITL) approval prompt.');
    expect(text).toContain('action: Use Ask before powerful actions or Custom rules unless this is an intentionally trusted environment.');
    expect(text).toContain('[warning:network:network-http-listener-enabled]');
  });

  test('network auth posture is flagged when LAN surfaces have no local users or bootstrap is still present', () => {
    const findings = buildCliDoctorFindings({
      ...makeOptions({
        'web.enabled': true,
        'web.hostMode': 'network',
        'web.host': '0.0.0.0',
      }),
      auth: {
        userStorePath: '/home/test/.goodvibes/tui/auth-users.json',
        userStorePresent: false,
        bootstrapCredentialPath: '/home/test/.goodvibes/tui/auth-bootstrap.txt',
        bootstrapCredentialPresent: true,
        operatorTokenPath: '/home/test/.goodvibes/daemon/operator-tokens.json',
        operatorTokenPresent: false,
      },
    });

    expect(findings.map((finding) => finding.id)).toContain('network-surface-without-local-users');
    expect(findings.map((finding) => finding.id)).toContain('network-surface-with-bootstrap-credential');
  });

  test('treats the daemon as enabled by default when neither danger.daemon nor daemon.enabled is set', () => {
    // Same bug class as the onboarding daemon-default fix: danger.daemon has no
    // default of its own, so reading it directly (`=== true`) reports "disabled"
    // for a fresh install even though the daemon actually runs by default via
    // daemon.enabled. buildCliDoctorFindings must go through resolveDaemonEnabled
    // so a service-mode-off warning still fires for the daemon-backed surface.
    const findings = buildCliDoctorFindings(makeOptions({
      'danger.daemon': undefined,
      'controlPlane.enabled': false,
      'service.enabled': false,
    }));

    expect(findings.map((finding) => finding.id)).toContain('service-disabled-for-server-surfaces');
  });

  test('honors an explicit daemon.enabled=false setting', () => {
    const findings = buildCliDoctorFindings(makeOptions({
      'daemon.enabled': false,
      'controlPlane.enabled': false,
      'service.enabled': false,
    }));

    expect(findings.map((finding) => finding.id)).not.toContain('service-disabled-for-server-surfaces');
  });

  test('status can render a stable JSON contract with service lifecycle details', () => {
    const text = renderCliStatus({
      ...makeOptions(),
      outputFormat: 'json',
      service: {
        config: {
          enabled: true,
          autostart: true,
          restartOnFailure: true,
          daemonEnabled: true,
        },
        managed: {
          platform: 'manual',
          serviceName: 'goodvibes-tui',
          path: '/project/.goodvibes/tui/service/manual-service.txt',
          installed: true,
          autostart: true,
          running: true,
          pid: 123,
          logPath: '/project/.goodvibes/tui/service/manual.log',
          commandPreview: 'bun run src/daemon/cli.ts',
          suggestedCommands: ['bun run src/daemon/cli.ts'],
          lastAction: 'status',
          pidPath: '/project/.goodvibes/tui/service/manual.pid',
          lastError: null,
        },
        endpoints: [],
        log: {
          path: '/project/.goodvibes/tui/service/manual.log',
          exists: true,
          size: 128,
          modifiedAt: 1,
        },
        issues: [],
      },
    });

    const parsed = JSON.parse(text) as {
      title: string;
      provider: { provider: string };
      service: { lifecycle: { managed: { running: boolean; pid: number } } };
      surfaces: { controlPlane: { port: number } };
      findings: unknown[];
    };

    expect(parsed.title).toBe('GoodVibes status');
    expect(parsed.provider.provider).toBe('openai');
    expect(parsed.service.lifecycle.managed.running).toBe(true);
    expect(parsed.service.lifecycle.managed.pid).toBe(123);
    expect(parsed.surfaces.controlPlane.port).toBe(3421);
    expect(parsed.findings).toBeArray();
  });
});

describe('CLI exposure report', () => {
  test("an unrecognized hostMode ('LAN') is never presented as a definite loopback binding — bind row warns, reach is unknown, doctor flags it", () => {
    // Pins the verifier's probe: a hand-edited controlPlane.hostMode 'LAN'
    // used to render bind 'LAN 127.0.0.1:3421' with reach 'Local only' —
    // asserting the resolver's fallback as fact for a config the SDK cannot
    // bind at all (its resolver has no default case; the daemon throws
    // before binding). Every display surface now routes through the one
    // formatter seam.
    const options = makeOptions({ 'controlPlane.hostMode': 'LAN' });

    const report = buildCliExposureReport(options);
    const controlPlane = report.find((surface) => surface.id === 'controlPlane');
    expect(controlPlane?.bind).toContain('not a recognized host mode');
    expect(controlPlane?.bind).not.toBe('LAN 127.0.0.1:3421');
    expect(controlPlane?.reach).toContain('Unknown');

    const findings = buildCliDoctorFindings(options);
    const finding = findings.find((f) => f.id === 'unrecognized-host-mode-controlPlane');
    expect(finding).toBeDefined();
    expect(finding?.summary).toContain("'LAN'");
    expect(finding?.action).toContain('local, network, or custom');
    // The recognized surfaces stay clean.
    expect(findings.some((f) => f.id === 'unrecognized-host-mode-web')).toBe(false);
  });

  test('reports bind, auth mode, and origin allowlist per surface', () => {
    const report = buildCliExposureReport(makeOptions({
      'controlPlane.enabled': true,
      'controlPlane.hostMode': 'network',
      'controlPlane.host': '0.0.0.0',
      'controlPlane.cors.enabled': true,
      'controlPlane.cors.allowedOrigins': 'http://localhost:5173, https://app.example',
    }));

    const controlPlane = report.find((surface) => surface.id === 'controlPlane');
    expect(controlPlane?.networkFacing).toBe(true);
    expect(controlPlane?.bind).toBe('network 0.0.0.0:3421');
    // makeOptions has both a user store and an operator token present.
    expect(controlPlane?.authMode).toBe('local users + operator token');
    expect(controlPlane?.originAllowlist).toBe('CORS on, allowlist: http://localhost:5173, https://app.example');

    const web = report.find((surface) => surface.id === 'web');
    expect(web?.networkFacing).toBe(false);
    expect(web?.authMode).toBe('loopback (host-local trust)');
    expect(web?.originAllowlist).toBe('n/a (no origin allowlist for this surface)');
  });

  test('reports "none configured" auth for a network-facing surface with no auth material', () => {
    const report = buildCliExposureReport({
      ...makeOptions({
        'web.enabled': true,
        'web.hostMode': 'network',
        'web.host': '0.0.0.0',
      }),
      auth: {
        userStorePath: '/home/test/.goodvibes/tui/auth-users.json',
        userStorePresent: false,
        bootstrapCredentialPath: '/home/test/.goodvibes/tui/auth-bootstrap.txt',
        bootstrapCredentialPresent: false,
        operatorTokenPath: '/home/test/.goodvibes/daemon/operator-tokens.json',
        operatorTokenPresent: false,
      },
    });
    const web = report.find((surface) => surface.id === 'web');
    expect(web?.authMode).toBe('none configured');
  });

  test('the rendered status output includes the exposure section', () => {
    const text = renderCliStatus(makeOptions());
    expect(text).toContain('Exposure (report only — no changes made):');
    expect(text).toContain('originAllowlist:');
  });
});

describe('CLI doctor risky-combination and install findings', () => {
  test('flags a wildcard CORS origin on a network-facing control plane', () => {
    const findings = buildCliDoctorFindings(makeOptions({
      'controlPlane.enabled': true,
      'controlPlane.hostMode': 'network',
      'controlPlane.host': '0.0.0.0',
      'controlPlane.cors.enabled': true,
      'controlPlane.cors.allowedOrigins': 'https://trusted.example, *',
    }));
    expect(findings.map((finding) => finding.id)).toContain('control-plane-cors-wildcard-origin');
  });

  test('does not flag a wildcard when the control plane is loopback-bound', () => {
    const findings = buildCliDoctorFindings(makeOptions({
      'controlPlane.enabled': true,
      'controlPlane.hostMode': 'local',
      'controlPlane.host': '127.0.0.1',
      'controlPlane.cors.enabled': true,
      'controlPlane.cors.allowedOrigins': '*',
    }));
    expect(findings.map((finding) => finding.id)).not.toContain('control-plane-cors-wildcard-origin');
  });

  test('does not flag an explicit CORS allowlist without a wildcard', () => {
    const findings = buildCliDoctorFindings(makeOptions({
      'controlPlane.enabled': true,
      'controlPlane.hostMode': 'network',
      'controlPlane.host': '0.0.0.0',
      'controlPlane.cors.enabled': true,
      'controlPlane.cors.allowedOrigins': 'https://trusted.example',
    }));
    expect(findings.map((finding) => finding.id)).not.toContain('control-plane-cors-wildcard-origin');
  });

  test('maps install self-check findings into doctor findings with the repair command as the action', () => {
    const findings = buildCliDoctorFindings({
      ...makeOptions(),
      install: [
        {
          id: 'broken-daemon-path',
          summary: 'The background daemon binary could not be located.',
          detail: 'No daemon executable was found on the packaged search paths.',
          repairCommand: 'bun add -g @pellux/goodvibes-tui',
        },
      ],
    });
    const mapped = findings.find((finding) => finding.id === 'install-broken-daemon-path');
    expect(mapped).toBeDefined();
    expect(mapped?.area).toBe('install');
    expect(mapped?.action).toBe('Repair this install by running: bun add -g @pellux/goodvibes-tui');
  });
});

describe('resolveDoctorExitCode', () => {
  test('exits 0 with no findings at all', () => {
    expect(resolveDoctorExitCode([])).toBe(0);
  });

  test('exits 0 for a healthy install carrying only advisory (warning) findings', () => {
    // makeOptions()'s default fixture has no onboarding marker, which alone
    // produces a 'warning'-severity finding — a healthy, usable install must
    // never report failure for that.
    const findings = buildCliDoctorFindings(makeOptions());
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.severity === 'warning')).toBe(true);
    expect(resolveDoctorExitCode(findings)).toBe(0);
  });

  test('exits 1 when any finding is a must-fix (risk) finding, strict or not', () => {
    const findings = buildCliDoctorFindings(makeOptions({ 'permissions.mode': 'allow-all' }));
    expect(findings.some((finding) => finding.severity === 'risk')).toBe(true);
    expect(resolveDoctorExitCode(findings, false)).toBe(1);
    expect(resolveDoctorExitCode(findings, true)).toBe(1);
  });

  test('--strict flips advisory-only findings to a failure too', () => {
    const findings = buildCliDoctorFindings(makeOptions());
    expect(findings.every((finding) => finding.severity === 'warning')).toBe(true);
    expect(resolveDoctorExitCode(findings, false)).toBe(0);
    expect(resolveDoctorExitCode(findings, true)).toBe(1);
  });

  test('--strict is still 0 when there are truly zero findings', () => {
    expect(resolveDoctorExitCode([], true)).toBe(0);
  });
});

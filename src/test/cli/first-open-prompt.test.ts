import { describe, it, expect } from 'bun:test';
import { decodeFirstOpenChoice, buildFirstOpenItems, selfRecordWorkspaceRegistration } from '../../cli/tui-startup.ts';

describe('buildFirstOpenItems', () => {
  it('offers a trust-only choice — the registration half is gone (registration self-records instead)', () => {
    const { title, items } = buildFirstOpenItems();
    expect(title).toContain('trust');
    expect(items.map((i) => i.id)).toEqual(['trusted', 'restricted']);
  });
});

describe('decodeFirstOpenChoice', () => {
  it('maps the chosen id to its trust level', () => {
    expect(decodeFirstOpenChoice('trusted')).toBe('trusted');
    expect(decodeFirstOpenChoice('restricted')).toBe('restricted');
  });

  it('Escape/enter-through takes the safe default: restricted', () => {
    expect(decodeFirstOpenChoice(null)).toBe('restricted');
  });

  it('an unrecognized id also defaults to restricted', () => {
    expect(decodeFirstOpenChoice('anything-else')).toBe('restricted');
  });
});

describe('selfRecordWorkspaceRegistration', () => {
  it('registers, labeled "via TUI", when the registry resolution offers registration', async () => {
    let registerCalls: Array<string | undefined> = [];
    const manager = {
      evaluate: async () => ({
        root: '/project', status: 'unknown' as const, coveredBy: null, viaWorktreeLink: false,
        broad: false, offerRegister: true, reason: 'unknown',
      }),
      register: async (label?: string) => {
        registerCalls.push(label);
        return { registered: true as const, result: { record: {} as never, alreadyRegistered: false } };
      },
    };
    await selfRecordWorkspaceRegistration(manager);
    expect(registerCalls).toEqual(['via TUI']);
  });

  it('never registers when the resolution does not offer it (covered/declined/broad)', async () => {
    let registered = false;
    const manager = {
      evaluate: async () => ({
        root: '/project', status: 'declined' as const, coveredBy: null, viaWorktreeLink: false,
        broad: false, offerRegister: false, reason: 'declined',
      }),
      register: async () => {
        registered = true;
        return { registered: true as const, result: { record: {} as never, alreadyRegistered: false } };
      },
    };
    await selfRecordWorkspaceRegistration(manager);
    expect(registered).toBe(false);
  });

  it('is a safe no-op when no registration manager is wired', async () => {
    await expect(selfRecordWorkspaceRegistration(undefined)).resolves.toBeUndefined();
  });
});

import { describe, it, expect } from 'bun:test';
import { decodeFirstOpenChoice, buildFirstOpenItems } from '../../cli/tui-startup.ts';

describe('buildFirstOpenItems', () => {
  it('offers a single combined 2x2 surface when both halves apply (never two modals)', () => {
    const { title, items } = buildFirstOpenItems({ trustNeeded: true, registerNeeded: true });
    expect(title).toContain('trust');
    expect(items.map((i) => i.id)).toEqual(['trust-register', 'trust-only', 'restrict-register', 'restrict-only']);
  });

  it('offers only trust rows when registration is not needed', () => {
    const { items } = buildFirstOpenItems({ trustNeeded: true, registerNeeded: false });
    expect(items.map((i) => i.id)).toEqual(['trusted', 'restricted']);
  });

  it('offers only register rows when trust is already decided', () => {
    const { items } = buildFirstOpenItems({ trustNeeded: false, registerNeeded: true });
    expect(items.map((i) => i.id)).toEqual(['register', 'skip']);
  });
});

describe('decodeFirstOpenChoice', () => {
  const both = { trustNeeded: true, registerNeeded: true };

  it('maps each combined choice to its trust + register pair', () => {
    expect(decodeFirstOpenChoice('trust-register', both)).toEqual({ trust: 'trusted', register: 'yes' });
    expect(decodeFirstOpenChoice('trust-only', both)).toEqual({ trust: 'trusted', register: 'no' });
    expect(decodeFirstOpenChoice('restrict-register', both)).toEqual({ trust: 'restricted', register: 'yes' });
    expect(decodeFirstOpenChoice('restrict-only', both)).toEqual({ trust: 'restricted', register: 'no' });
  });

  it('Escape/enter-through on the combined prompt takes the safe default: restricted + decline', () => {
    expect(decodeFirstOpenChoice(null, both)).toEqual({ trust: 'restricted', register: 'no' });
  });

  it('trust-only prompt: trusted vs restricted; Escape defaults restricted, no register decision', () => {
    const trustOnly = { trustNeeded: true, registerNeeded: false };
    expect(decodeFirstOpenChoice('trusted', trustOnly)).toEqual({ trust: 'trusted' });
    expect(decodeFirstOpenChoice('restricted', trustOnly)).toEqual({ trust: 'restricted' });
    expect(decodeFirstOpenChoice(null, trustOnly)).toEqual({ trust: 'restricted' });
  });

  it('register-only prompt: register vs skip; Escape defaults to decline, no trust decision', () => {
    const registerOnly = { trustNeeded: false, registerNeeded: true };
    expect(decodeFirstOpenChoice('register', registerOnly)).toEqual({ register: 'yes' });
    expect(decodeFirstOpenChoice('skip', registerOnly)).toEqual({ register: 'no' });
    expect(decodeFirstOpenChoice(null, registerOnly)).toEqual({ register: 'no' });
  });
});

import { describe, expect, test } from 'bun:test';
import { WelcomePanel } from '../../panels/welcome-panel.ts';

describe('WelcomePanel', () => {
  test('renders guided product entrypoints', () => {
    const panel = new WelcomePanel();
    const text = panel.render(100, 18).flat().map((cell) => cell.char).join('');
    expect(text).toContain('Welcome To GoodVibes');
    expect(text).toContain('/setup onboarding');
    expect(text).toContain('/login provider <name> start');
    expect(text).toContain('/marketplace open');
    expect(text).toContain('/remote-setup');
    expect(text).toContain('/teleport export <path>');
  });
});

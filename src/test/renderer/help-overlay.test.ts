/**
 * Tests for renderHelpOverlay.
 */
import { describe, test, expect } from 'bun:test';
import { renderHelpOverlay } from '../../renderer/help-overlay.ts';
import type { SlashCommand } from '../../input/command-registry.ts';
import { lineToString, linesToText } from '../setup.ts';

const W = 120;

const SAMPLE_COMMANDS: SlashCommand[] = [
  { name: 'model', aliases: ['m'], description: 'Select LLM model', handler: () => {} },
  { name: 'help', aliases: ['h', '?'], description: 'Show help', handler: () => {} },
  { name: 'quit', aliases: ['q'], description: 'Exit application', handler: () => {} },
];

describe('renderHelpOverlay', () => {
  test('returns an array of Lines', () => {
    const lines = renderHelpOverlay(W);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    const lines = renderHelpOverlay(W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Help"', () => {
    const lines = renderHelpOverlay(W);
    const titleLine = lineToString(lines[0]);
    expect(titleLine).toContain('Help');
  });

  test('footer contains close hint', () => {
    const lines = renderHelpOverlay(W);
    const footerLine = lineToString(lines[lines.length - 1]);
    expect(footerLine).toContain('Esc');
  });

  test('contains Navigation section', () => {
    const lines = renderHelpOverlay(W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Navigation');
  });

  test('contains Editing section', () => {
    const lines = renderHelpOverlay(W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Editing');
  });

  test('contains Modals section', () => {
    const lines = renderHelpOverlay(W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Modals');
  });

  test('contains Commands section', () => {
    const lines = renderHelpOverlay(W, undefined, 14);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Commands');
  });

  test('includes Ctrl+F shortcut in navigation', () => {
    const lines = renderHelpOverlay(W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Ctrl+F');
  });

  test('includes PageUp/PageDn in navigation', () => {
    const lines = renderHelpOverlay(W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('PageUp');
  });

  test('includes ? toggle shortcut', () => {
    const lines = renderHelpOverlay(W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('?');
  });

  test('renders command list when commands provided', () => {
    const lines = renderHelpOverlay(W, SAMPLE_COMMANDS, 14);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('/model');
    expect(texts).toContain('/help');
    expect(texts).toContain('/quit');
  });

  test('shows command aliases when provided', () => {
    const lines = renderHelpOverlay(W, SAMPLE_COMMANDS, 14);
    const texts = linesToText(lines).join('\n');
    // /model has alias /m
    expect(texts).toContain('/m');
  });

  test('shows fallback command list when no commands provided', () => {
    const lines = renderHelpOverlay(W, undefined, 14);
    const texts = linesToText(lines).join('\n');
    // The fallback string includes known command names
    expect(texts).toContain('/help');
  });

  test('lines are correct at narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderHelpOverlay(narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });

  test('footer contains scroll hint', () => {
    const lines = renderHelpOverlay(W);
    const footerLine = lineToString(lines[lines.length - 1]);
    expect(footerLine).toContain('\u2191\u2193');
  });
});

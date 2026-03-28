/**
 * Shared effort level descriptions used across model picker, overlay renderer,
 * and command handler. Single source of truth — import from here.
 */
export const EFFORT_DESCRIPTIONS: Record<string, string> = {
  instant: 'Fastest, minimal reasoning',
  low:     'Quick with light reasoning',
  medium:  'Balanced speed and quality',
  high:    'Thorough, deep reasoning',
};

import { describe, expect, test } from 'bun:test';
import {
  getHookPointContract,
  listHookPointContracts,
  parseHookPath,
} from '../../hooks/index.ts';

describe('hook point contracts', () => {
  test('lists known contracts', () => {
    const contracts = listHookPointContracts();
    expect(contracts.length).toBeGreaterThan(5);
  });

  test('resolves exact or wildcard contract for a hook path', () => {
    const contract = getHookPointContract('Pre:tool:edit');
    expect(contract).not.toBeNull();
    expect(contract?.authority).toBe('intercept');
    expect(contract?.executionMode).toBe('blocking');
    expect(contract?.canDeny).toBe(true);
  });

  test('parses hook path into phase, category, and specific', () => {
    expect(parseHookPath('Lifecycle:workflow:failed')).toEqual({
      phase: 'Lifecycle',
      category: 'workflow',
      specific: 'failed',
    });
  });
});


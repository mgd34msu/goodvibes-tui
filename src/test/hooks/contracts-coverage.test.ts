import { describe, expect, test } from 'bun:test';
import { getHookPointContract } from '../../hooks/contracts.ts';

describe('hook contract coverage', () => {
  test('covers permission and transport lifecycle edges', () => {
    expect(getHookPointContract('Pre:permission:request')).toBeDefined();
    expect(getHookPointContract('Post:permission:decision')).toBeDefined();
    expect(getHookPointContract('Fail:permission:request')).toBeDefined();
    expect(getHookPointContract('Lifecycle:transport:connected')).toBeDefined();
    expect(getHookPointContract('Lifecycle:transport:failed')).toBeDefined();
    expect(getHookPointContract('Lifecycle:orchestration:graph-created')).toBeDefined();
    expect(getHookPointContract('Lifecycle:orchestration:node-failed')).toBeDefined();
    expect(getHookPointContract('Change:orchestration:recursion-guard')).toBeDefined();
    expect(getHookPointContract('Lifecycle:communication:sent')).toBeDefined();
    expect(getHookPointContract('Lifecycle:communication:delivered')).toBeDefined();
    expect(getHookPointContract('Change:communication:blocked')).toBeDefined();
  });
});

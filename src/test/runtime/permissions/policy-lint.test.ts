import { describe, expect, test } from 'bun:test';
import { lintPolicyConfig } from '../../../runtime/permissions/index.ts';
import type { PermissionsConfig } from '@pellux/goodvibes-sdk/platform/runtime/permissions/types';

describe('lintPolicyConfig', () => {
  test('flags duplicate rule ids and broad rules', () => {
    const config: PermissionsConfig = {
      mode: 'custom',
      rules: [
        {
          id: 'dup',
          type: 'prefix',
          origin: 'user',
          effect: 'allow',
          toolPattern: '*',
        },
        {
          id: 'dup',
          type: 'path-scope',
          origin: 'user',
          effect: 'allow',
          toolPattern: ['write'],
          pathPatterns: ['/**'],
        },
        {
          id: 'net',
          type: 'network-scope',
          origin: 'managed',
          effect: 'allow',
          toolPattern: ['fetch'],
          hostPatterns: ['*'],
        },
      ],
    };

    const findings = lintPolicyConfig(config);
    expect(findings.some((f) => f.message.includes('Duplicate policy rule id'))).toBe(true);
    expect(findings.some((f) => f.message.includes('overly broad path pattern'))).toBe(true);
    expect(findings.some((f) => f.message.includes('overly broad host pattern'))).toBe(true);
  });
});


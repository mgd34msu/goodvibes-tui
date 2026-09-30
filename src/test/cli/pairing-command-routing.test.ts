import { describe, expect, test } from 'bun:test';
import { readOptionValue } from '../../cli/management-utils.ts';

describe('readOptionValue takes the flag token verbatim', () => {
  test('the token includes its dashes, so lookups must too', () => {
    expect(readOptionValue(['--name', 'kitchen tablet'], '--name')).toBe('kitchen tablet');
    expect(readOptionValue(['--name=kitchen'], '--name')).toBe('kitchen');
    // The bare-word form silently never matches; `pair --name x` minted a
    // default-named token because of exactly this lookup.
    expect(readOptionValue(['--name', 'kitchen'], 'name')).toBeUndefined();
  });
});

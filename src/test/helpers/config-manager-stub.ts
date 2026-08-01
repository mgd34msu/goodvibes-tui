// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
/**
 * Typed test doubles for the parts of `ConfigManager` that read and write settings.
 *
 * Why these exist rather than each test hand-rolling its own object literal:
 * `ConfigManager.get` is declared as `<K extends ConfigKey>(key: K) => ConfigValue<K>`,
 * and `ConfigValue` is a large conditional type over the whole settings schema. A test
 * double that re-declares that generic signature by hand forces tsc to compare two
 * *deferred* `ConfigValue<K>` instantiations against each other, which exceeds its
 * instantiation-depth budget and aborts with TS2321 "Excessive stack depth comparing
 * types". The compiler reports only one such site per run, so patching whichever file
 * happens to fail just moves the error to the next one — and the threshold shifts as the
 * schema grows, so a suite that passes today fails on an unrelated commit tomorrow.
 *
 * The fix is to never re-declare the generic: build a plain non-generic lookup and assert
 * it onto the real member type exactly once, here. That is a shallow comparison tsc
 * completes without recursing through the schema.
 *
 * Values are keyed by dotted config path, e.g. `{ 'display.themeMode': 'dark' }`. Keys with
 * no entry read back as `undefined`, matching a real manager with nothing persisted.
 */
import type { ConfigManager, GoodVibesConfig } from '@pellux/goodvibes-sdk/platform/config';

/** A `get` that reads from `values`, for tests taking `Pick<ConfigManager, 'get'>`. */
export function configGetStub(values: Record<string, unknown> = {}): ConfigManager['get'] {
  return ((key: string) => values[key]) as ConfigManager['get'];
}

/** A `getCategory` that reads whole sections from `categories`. */
export function configGetCategoryStub(
  categories: Record<string, unknown> = {},
): ConfigManager['getCategory'] {
  return ((category: keyof GoodVibesConfig) => categories[category as string]) as ConfigManager['getCategory'];
}

/** A `setProjectValue` that writes back into `values`, so reads observe writes. */
export function configSetProjectValueStub(
  values: Record<string, unknown>,
): ConfigManager['setProjectValue'] {
  return ((key: string, value: unknown) => {
    values[key] = value;
  }) as ConfigManager['setProjectValue'];
}

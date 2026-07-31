/**
 * Pure logic for `/update`, re-exported from the platform's update-policy
 * modules so there is one mechanism everywhere: version comparison and the
 * release-tag redirect lookup from `platform/runtime/self-update`, install-kind
 * detection from `platform/runtime/operations`.
 *
 * The self-update download/verify/swap orchestration that USES these lives in
 * src/input/commands/update-runtime.ts; this module only decides "is there a
 * newer version" and "can this install be swapped in place".
 *
 * `fallbackUpdateCommand` is wrapped rather than re-exported: the platform's
 * takes the package name a package-managed install is upgraded through, and
 * that name is this product's own.
 */
export {
  compareVersions,
  normalizeVersion,
  parseReleaseTagFromLocation,
  resolveLatestReleaseTag,
  type UpdateFetchLike,
} from '@pellux/goodvibes-sdk/platform/runtime/self-update';

export {
  detectInstallKind,
  type InstallKind,
} from '@pellux/goodvibes-sdk/platform/runtime/operations';

import {
  fallbackUpdateCommand as platformFallbackUpdateCommand,
  type InstallKind as PlatformInstallKind,
} from '@pellux/goodvibes-sdk/platform/runtime/operations';

/** The package a package-managed install of this terminal is upgraded through. */
const TERMINAL_PACKAGE_NAME = '@pellux/goodvibes-tui';

/** The exact command to tell the user to run instead of a swap, for each non-binary install kind. */
export function fallbackUpdateCommand(kind: Exclude<PlatformInstallKind, 'binary'>): string {
  return platformFallbackUpdateCommand(kind, TERMINAL_PACKAGE_NAME);
}

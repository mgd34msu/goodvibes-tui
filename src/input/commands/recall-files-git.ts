/**
 * recall-files-git.ts — the git seam for memory file projection.
 *
 * The SDK owns the production seam now (`createMemoryProjectionGit`,
 * platform/state): it shells out to the system git, commits with a neutral
 * projection identity (never the operator's), tolerates an unchanged tree,
 * and — through `projectMemoryToFiles`'s ownership gate — only ever commits
 * to a repository whose toplevel IS the projection directory, initializing
 * one there when needed. A projection directory nested inside some other
 * checkout can never pollute that checkout. This module is a thin local
 * seam factory so command code keeps a single import site.
 */
import { createMemoryProjectionGit } from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryProjectionGit } from '@pellux/goodvibes-sdk/platform/state';

/** The projection git seam (see module note — SDK-owned behavior). */
export function createSyncGitSeam(): MemoryProjectionGit {
  return createMemoryProjectionGit();
}

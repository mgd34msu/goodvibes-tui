/**
 * Declarations for `scripts/postinstall.js`.
 *
 * The script is plain JS (it runs as an npm lifecycle hook, before any build
 * step exists), so `tsc` has nothing to read for it. Rather than hand-copying
 * signatures, which would silently drift, this re-exports the types straight
 * from the module postinstall.js itself re-exports at runtime, so the two can
 * never disagree.
 *
 * Consumed by `src/test/scripts/postinstall.test.ts`, which asserts the script
 * is wired to the same release-artifact helpers the app uses.
 */
export {
  CHECKSUM_MANIFEST_NAME,
  parseChecksumFile,
  resolveArtifactNames,
  sha256,
  verifyChecksum,
} from '../src/runtime/release-artifacts.ts';

/**
 * Provision the wake-word model as part of installing. Declared here rather than
 * re-exported from elsewhere because it is the script's own step: the SDK owns
 * the policy, this owns deciding whether an npm install should run it (a source
 * checkout and the --no-download switch both decline).
 *
 * Resolves for every outcome and never rejects, a wake-word model is not a
 * reason to fail an installation.
 */
export function installWakeWordModel(): Promise<void>;

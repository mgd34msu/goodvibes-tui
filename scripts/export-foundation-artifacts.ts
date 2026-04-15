import { join } from 'node:path';
import { syncFoundationArtifacts } from './project-surfaces.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

withWorkspaceLock('sync foundation artifacts', () => {
  syncFoundationArtifacts(join(import.meta.dir, '..'));
});

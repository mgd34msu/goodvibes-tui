import type { CommandRegistry } from '../command-registry.ts';
import { buildPermissionProvenance, renderPermissionProvenance } from './permissions-provenance.ts';

/**
 * `/permissions` — the permission provenance panel. Prints every
 * permission-relevant setting in effect and where each value came from
 * (default / config file / runtime override / session mode), plus the current
 * session mode. Read-only: it changes no config. See permissions-provenance.ts
 * for how origin is resolved from the platform's own ConfigManager.
 */
export function registerPermissionsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'permissions',
    aliases: ['perms'],
    description: 'Show permission settings in effect and where each value came from (provenance)',
    handler(_args, ctx) {
      const provenance = buildPermissionProvenance(ctx.platform.configManager);
      ctx.print(renderPermissionProvenance(provenance));
    },
  });
}

/**
 * modal-surface-registry.ts, the config-modal surfaces by name.
 *
 * Every settings-style modal (services, providers, plugins, hooks, memory and
 * the rest) is a ConfigModalSurface registered here once at startup, with the
 * old names that should open it (for example 'providers' and 'accounts' both
 * open 'providers-modal'). The config-modal host resolves a name through
 * getModalSurface; ctx.openModal and the view router (views.ts) resolve an old
 * name through getModalRedirect first.
 */

import type { ConfigModalSurface, ConfigModalSurfaceRegistry } from '../input/config-modal-types.ts';

export class ModalSurfaceRegistry implements ConfigModalSurfaceRegistry {
  private readonly surfaces = new Map<string, ConfigModalSurface>();
  private readonly redirects = new Map<string, string>();

  /** Register (or replace) the surface for its name. */
  registerModalSurface(surface: ConfigModalSurface): void {
    this.surfaces.set(surface.name, surface);
  }

  /** Make an old name open a modal (e.g. 'accounts' opens 'providers-modal'). */
  registerModalRedirect(name: string, modalName: string): void {
    this.redirects.set(name, modalName);
  }

  getModalSurface(name: string): ConfigModalSurface | undefined {
    return this.surfaces.get(name);
  }

  /** The modal an old name opens, or undefined. */
  getModalRedirect(name: string): string | undefined {
    return this.redirects.get(name);
  }

  /** Every old name that opens a modal, with the modal it opens. */
  listRedirects(): ReadonlyArray<readonly [string, string]> {
    return [...this.redirects.entries()];
  }
}

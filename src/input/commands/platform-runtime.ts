import type { CommandRegistry } from '../command-registry.ts';
import { registerPlatformSandboxRuntimeCommands } from './platform-sandbox-runtime.ts';

export function registerPlatformRuntimeCommands(registry: CommandRegistry): void {
  registerPlatformSandboxRuntimeCommands(registry);
}

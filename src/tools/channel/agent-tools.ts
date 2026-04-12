import { ChannelPluginRegistry } from '../../channels/index.ts';
import type { ToolRegistry } from '../registry.ts';

export function registerChannelAgentTools(
  registry: ToolRegistry,
  channelRegistry: ChannelPluginRegistry | null,
): number {
  if (!channelRegistry) return 0;
  let registered = 0;
  for (const tool of channelRegistry.listAgentTools()) {
    if (registry.has(tool.definition.name)) continue;
    registry.register(tool);
    registered += 1;
  }
  return registered;
}

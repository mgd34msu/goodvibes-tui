import { createMcpApi, type McpApi, type McpApiRegistry } from '../mcp/mcp-api.ts';

export function createRuntimeMcpApi(registry: McpApiRegistry): McpApi {
  return createMcpApi(registry);
}

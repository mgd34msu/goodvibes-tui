import { createMcpApi, type McpApi, type McpApiRegistry } from '@pellux/goodvibes-sdk/platform/mcp/mcp-api';

export function createRuntimeMcpApi(registry: McpApiRegistry): McpApi {
  return createMcpApi(registry);
}

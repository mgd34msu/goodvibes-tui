import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EventBus } from '../../core/event-bus.ts';
import { ToolRegistry } from '../../tools/registry.ts';
import { MockLLMProvider } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockChatResponse {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end' | 'tool_use';
}

// MockLLMProvider is imported from setup.ts for shared usage.
// _makeMockProvider retained below for tests that use bun:test mock() directly.
function _makeMockProvider(responses: MockChatResponse[]) {
  let idx = 0;
  return {
    name: 'mock',
    models: ['mock-model'],
    chat: mock(async (_params: unknown) => {
      const resp = responses[idx] ?? responses[responses.length - 1];
      idx++;
      return resp;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator', () => {
  let bus: EventBus;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    bus = new EventBus();
    toolRegistry = new ToolRegistry();
  });

  async function buildOrchestrator() {
    const { Orchestrator } = await import('../../core/orchestrator.ts');
    const { ConversationManager } = await import('../../core/conversation.ts');
    const { PermissionManager } = await import('../../permissions/manager.ts');
    const cm = new ConversationManager(() => 80);
    const pm = new PermissionManager(bus);
    const orch = new Orchestrator(bus, cm, () => 24, () => {}, toolRegistry, pm);
    return { orch, cm, pm };
  }

  describe('Orchestrator state', () => {
    test('isThinking starts false', async () => {
      const { orch } = await buildOrchestrator();
      expect(orch.isThinking).toBe(false);
    });

    test('messageQueue starts empty', async () => {
      const { orch } = await buildOrchestrator();
      expect(orch.messageQueue).toHaveLength(0);
    });

    test('usage starts at zero', async () => {
      const { orch } = await buildOrchestrator();
      expect(orch.usage.input).toBe(0);
      expect(orch.usage.output).toBe(0);
    });

    test('abort() does not throw when not thinking', async () => {
      const { orch } = await buildOrchestrator();
      expect(() => orch.abort()).not.toThrow();
    });

    test('getSpinner() returns a non-empty string', async () => {
      const { orch } = await buildOrchestrator();
      const spinner = orch.getSpinner();
      expect(typeof spinner).toBe('string');
      expect(spinner.length).toBeGreaterThan(0);
    });

    test('getSpinner() produces valid spinner frames at different positions', async () => {
      const { orch } = await buildOrchestrator();
      const frames = new Set<string>();
      for (let i = 0; i < 10; i++) {
        (orch as unknown as { thinkingFrame: number }).thinkingFrame = i;
        frames.add(orch.getSpinner());
      }
      // Should have multiple distinct spinner chars over 10 positions
      expect(frames.size).toBeGreaterThan(1);
    });
  });

  describe('handleUserInput - queue behavior', () => {
    test('queues input when already thinking and emits render:request', async () => {
      const { orch } = await buildOrchestrator();

      // Manually set thinking state to simulate in-flight request
      (orch as unknown as { isThinking: boolean }).isThinking = true;

      let renderCount = 0;
      bus.on('render:request', () => renderCount++);

      // This should queue, not call LLM (which would fail without a valid provider)
      orch.handleUserInput('queued message');

      expect(orch.messageQueue).toContain('queued message');
      expect(renderCount).toBeGreaterThan(0);
    });

    test('empty input string is ignored (does not queue)', async () => {
      const { orch } = await buildOrchestrator();
      (orch as unknown as { isThinking: boolean }).isThinking = true;

      orch.handleUserInput('   '); // whitespace only
      expect(orch.messageQueue).toHaveLength(0);
    });

    test('multiple queued messages accumulate in order', async () => {
      const { orch } = await buildOrchestrator();
      (orch as unknown as { isThinking: boolean }).isThinking = true;

      orch.handleUserInput('first');
      orch.handleUserInput('second');
      orch.handleUserInput('third');

      expect(orch.messageQueue).toEqual(['first', 'second', 'third']);
    });
  });

  describe('registerDelegateTool', () => {
    test('registers delegate tool into the ToolRegistry', async () => {
      const { orch } = await buildOrchestrator();

      const mockAcp = {
        spawn: mock(async (_task: unknown) => 'agent-id-123'),
      } as unknown as import('../../acp/manager.ts').AcpManager;

      orch.registerDelegateTool(mockAcp);

      expect(toolRegistry.has('delegate')).toBe(true);
    });

    test('delegate tool definition has required parameters', async () => {
      const { orch } = await buildOrchestrator();

      const mockAcp = {
        spawn: mock(async (_task: unknown) => 'agent-id'),
      } as unknown as import('../../acp/manager.ts').AcpManager;

      orch.registerDelegateTool(mockAcp);

      const defs = toolRegistry.getToolDefinitions();
      const delegateDef = defs.find((d) => d.name === 'delegate');
      expect(delegateDef).toBeDefined();
      const params = delegateDef!.parameters as { required: string[] };
      expect(params.required).toContain('description');
      expect(params.required).toContain('context');
      expect(params.required).toContain('tools');
    });

    test('delegate tool execution calls acpManager.spawn', async () => {
      const { orch } = await buildOrchestrator();

      const spawnMock = mock(async (_task: unknown) => 'spawned-agent-id');
      const mockAcp = { spawn: spawnMock } as unknown as import('../../acp/manager.ts').AcpManager;

      orch.registerDelegateTool(mockAcp);

      const result = await toolRegistry.execute('call-x', 'delegate', {
        description: 'Run tests',
        context: 'Run all unit tests',
        tools: ['file_read'],
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('spawned-agent-id');
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    test('delegate tool returns failure when acpManager is null', async () => {
      const { orch } = await buildOrchestrator();

      // Register WITHOUT calling registerDelegateTool - then directly inject
      // We test the internal null-check by accessing the tool function after registration
      // First register with a real mock to get the tool registered
      const mockAcp = { spawn: mock(async () => 'id') } as unknown as import('../../acp/manager.ts').AcpManager;
      orch.registerDelegateTool(mockAcp);

      // Now manually clear the internal acpManager via type cast to simulate null scenario
      (orch as unknown as { acpManager: null }).acpManager = null;

      const result = await toolRegistry.execute('call-null', 'delegate', {
        description: 'task',
        context: 'ctx',
        tools: [],
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('not initialized');
    });
  });
});

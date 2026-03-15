import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { EventBus } from '../../core/event-bus.ts';
import { SelectionManager } from '../../input/selection.ts';

function makeInput(): InputHandler {
  const bus = new EventBus();
  const sel = new SelectionManager();
  return new InputHandler(bus, sel, () => 0, () => 20, () => ({
    getLineCount: () => 0, getAllLines: () => [], getSnapshot: () => [],
    addLine: () => {}, addLines: () => {}, clear: () => {},
  }) as any, () => {}, () => {});
}

// ---------------------------------------------------------------------------
// registerPaste — base64 prefix detection
// ---------------------------------------------------------------------------

describe('registerPaste base64 image detection', () => {
  test('detects PNG base64 prefix (iVBORw0KGgo)', () => {
    const ih = makeInput();
    const pngData = 'iVBORw0KGgo' + 'A'.repeat(200);
    const marker = ih.registerPaste(pngData);
    expect(marker).toMatch(/^\[IMAGE: img1, clipboard, \d+KB\]$/);
    const registry = ih.getImageAttachments();
    expect(registry.size).toBe(1);
    const entry = registry.get('img1')!;
    expect(entry.mediaType).toBe('image/png');
    expect(entry.data).toBe(pngData);
  });

  test('detects JPEG base64 prefix (/9j/)', () => {
    const ih = makeInput();
    const jpegData = '/9j/' + 'A'.repeat(200);
    const marker = ih.registerPaste(jpegData);
    expect(marker).toMatch(/^\[IMAGE: img1, clipboard, \d+KB\]$/);
    const registry = ih.getImageAttachments();
    const entry = registry.get('img1')!;
    expect(entry.mediaType).toBe('image/jpeg');
  });

  test('detects WebP base64 prefix (UklGR)', () => {
    const ih = makeInput();
    const webpData = 'UklGR' + 'A'.repeat(200);
    const marker = ih.registerPaste(webpData);
    expect(marker).toMatch(/^\[IMAGE: img1, clipboard, \d+KB\]$/);
    const registry = ih.getImageAttachments();
    const entry = registry.get('img1')!;
    expect(entry.mediaType).toBe('image/webp');
  });

  test('detects GIF base64 prefix (R0lGOD)', () => {
    const ih = makeInput();
    const gifData = 'R0lGOD' + 'A'.repeat(200);
    const marker = ih.registerPaste(gifData);
    expect(marker).toMatch(/^\[IMAGE: img1, clipboard, \d+KB\]$/);
    const registry = ih.getImageAttachments();
    const entry = registry.get('img1')!;
    expect(entry.mediaType).toBe('image/gif');
  });

  test('short base64-looking strings are not treated as images', () => {
    const ih = makeInput();
    const shortData = 'iVBORw0KGgo' + 'A'.repeat(10);
    const result = ih.registerPaste(shortData);
    // Too short — returned as-is (not a marker)
    expect(result).not.toMatch(/^\[IMAGE:/);
    expect(ih.getImageAttachments().size).toBe(0);
  });

  test('plain text paste returns text directly when <= 8 lines', () => {
    const ih = makeInput();
    const result = ih.registerPaste('hello world');
    expect(result).toBe('hello world');
    expect(ih.getImageAttachments().size).toBe(0);
  });

  test('IDs increment per paste', () => {
    const ih = makeInput();
    const pngData = 'iVBORw0KGgo' + 'A'.repeat(200);
    const m1 = ih.registerPaste(pngData);
    const m2 = ih.registerPaste(pngData);
    expect(m1).toContain('img1');
    expect(m2).toContain('img2');
    expect(ih.getImageAttachments().size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// expandPrompt — via private accessor
// ---------------------------------------------------------------------------

describe('expandPrompt', () => {
  test('with no images returns plain string', () => {
    const ih = makeInput();
    const result = (ih as any).expandPrompt('hello world') as string;
    expect(typeof result).toBe('string');
    expect(result).toBe('hello world');
  });

  test('with TEXT marker expands to content string', () => {
    const ih = makeInput();
    // Manually inject into pasteRegistry
    (ih as any).pasteRegistry.set('p1', 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9');
    const result = (ih as any).expandPrompt('before [TEXT: p1, 9 lines] after') as string;
    expect(typeof result).toBe('string');
    expect(result).toContain('line1');
    expect(result).toContain('line9');
  });

  test('with IMAGE marker returns ContentPart[]', () => {
    const ih = makeInput();
    const pngData = 'iVBORw0KGgo' + 'A'.repeat(200);
    const marker = ih.registerPaste(pngData);
    // marker = "[IMAGE: img1, clipboard, NKB]"
    const result = (ih as any).expandPrompt(`describe this ${marker}`) as any[];
    expect(Array.isArray(result)).toBe(true);
    const textParts = result.filter((p: any) => p.type === 'text');
    const imageParts = result.filter((p: any) => p.type === 'image');
    expect(textParts.length).toBeGreaterThanOrEqual(1);
    expect(imageParts.length).toBe(1);
    expect(imageParts[0].mediaType).toBe('image/png');
    expect(imageParts[0].data).toBe(pngData);
  });

  test('expandPrompt maps image IDs from markers to registry (not positional)', () => {
    const ih = makeInput();
    const pngData = 'iVBORw0KGgo' + 'A'.repeat(200);
    const gifData = 'R0lGOD' + 'A'.repeat(200);
    const m1 = ih.registerPaste(pngData);
    const m2 = ih.registerPaste(gifData);
    // Use m2 first, then m1 — reverse of insertion order
    const result = (ih as any).expandPrompt(`${m2} text ${m1}`) as any[];
    expect(Array.isArray(result)).toBe(true);
    const imageParts = result.filter((p: any) => p.type === 'image');
    expect(imageParts.length).toBe(2);
    // First image in text is m2 (GIF), second is m1 (PNG)
    expect(imageParts[0].mediaType).toBe('image/gif');
    expect(imageParts[1].mediaType).toBe('image/png');
  });
});

// ---------------------------------------------------------------------------
// addUserMessage — ContentPart[] storage
// ---------------------------------------------------------------------------

describe('addUserMessage with ContentPart[]', () => {
  test('stores ContentPart[] in conversation messages', async () => {
    const { ConversationManager } = await import('../../core/conversation.ts');
    const cm = new ConversationManager(() => 80);
    const parts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mediaType: string }> = [
      { type: 'text', text: 'describe this' },
      { type: 'image', data: 'abc123', mediaType: 'image/png' },
    ];
    cm.addUserMessage(parts);
    const messages = cm.getMessagesForLLM();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(Array.isArray(messages[0].content)).toBe(true);
    const content = messages[0].content as typeof parts;
    expect(content[0].type).toBe('text');
    expect(content[1].type).toBe('image');
  });

  test('getMessagesForLLM passes ContentPart[] through unchanged', async () => {
    const { ConversationManager } = await import('../../core/conversation.ts');
    const cm = new ConversationManager(() => 80);
    const parts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mediaType: string }> = [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'base64data', mediaType: 'image/webp' },
    ];
    cm.addUserMessage(parts);
    const msgs = cm.getMessagesForLLM();
    const content = msgs[0].content as typeof parts;
    expect(content).toHaveLength(2);
    expect((content[1] as any).data).toBe('base64data');
    expect((content[1] as any).mediaType).toBe('image/webp');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator capability check strips images for non-multimodal models
// ---------------------------------------------------------------------------

describe('Orchestrator capability check for non-multimodal models', () => {
  test('strips images and adds warning when model lacks multimodal capability', async () => {
    const { EventBus } = await import('../../core/event-bus.ts');
    const { ToolRegistry } = await import('../../tools/registry.ts');
    const { Orchestrator } = await import('../../core/orchestrator.ts');
    const { ConversationManager } = await import('../../core/conversation.ts');
    const { PermissionManager } = await import('../../permissions/manager.ts');
    const { providerRegistry } = await import('../../providers/registry.ts');

    const bus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const cm = new ConversationManager(() => 80);
    const pm = new PermissionManager(bus);
    const orch = new Orchestrator(bus, cm, () => 24, () => {}, toolRegistry, pm);

    // Inject a non-multimodal model into providerRegistry for this test
    const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);
    const originalGetForModel = providerRegistry.getForModel.bind(providerRegistry);
    let systemMessages: string[] = [];
    const origAddSystem = cm.addSystemMessage.bind(cm);
    cm.addSystemMessage = (msg: string) => {
      systemMessages.push(msg);
      origAddSystem(msg);
    };

    // Patch getCurrentModel to return a non-multimodal model
    providerRegistry.getCurrentModel = () => ({
      id: 'test-model',
      displayName: 'Test Model',
      provider: 'test',
      capabilities: { multimodal: false, tools: true, streaming: false, contextWindow: 8192, reasoning: false },
    } as any);

    // Patch getForModel to return a mock provider that returns a valid response
    providerRegistry.getForModel = () => ({
      name: 'mock',
      models: ['test-model'],
      chat: async () => ({
        content: 'ok',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end' as const,
      }),
    });

    const content = [
      { type: 'text' as const, text: 'describe this' },
      { type: 'image' as const, data: 'abc', mediaType: 'image/png' },
    ];

    await orch.handleUserInput('describe this', content);

    // Restore
    providerRegistry.getCurrentModel = originalGetCurrentModel;
    providerRegistry.getForModel = originalGetForModel;

    expect(systemMessages.some(m => m.includes('does not support image input'))).toBe(true);
  });
});

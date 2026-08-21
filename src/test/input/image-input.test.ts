import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@pellux/goodvibes-terminal-shell';
import { InfiniteBuffer } from '@pellux/goodvibes-terminal-shell';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createPermissionConfigReader, PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { getTestProviderRegistry, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { handleClipboardPaste } from '../../input/handler-content-actions.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

type InputHandlerImageTestAccess = {
  pasteRegistry: Map<string, string>;
  expandPrompt(text: string): string | ContentPart[];
};

function asImageTestAccess(input: InputHandler): InputHandlerImageTestAccess {
  return input as unknown as InputHandlerImageTestAccess;
}

function makeInput(): InputHandler {
  const sel = new SelectionManager();
  const history = new InfiniteBuffer();
  return new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
}

function createConfigManager(): ConfigManager {
  const root = makeProjectTempDir('gv-image-input');
  return new ConfigManager({ surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

// ---------------------------------------------------------------------------
// registerPaste, base64 prefix detection
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
    // Too short, returned as-is (not a marker)
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

describe('handleClipboardPaste', () => {
  test('inserts an image marker from an explicit clipboard image source', () => {
    let undoCount = 0;
    let renderCount = 0;
    const state = {
      prompt: 'describe ',
      cursorPos: 'describe '.length,
      pasteRegistry: new Map<string, string>(),
      nextPasteId: 1,
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextImageId: 1,
      saveUndoState: () => { undoCount++; },
      ensureInputCursorVisible: () => {},
      requestRender: () => { renderCount++; },
    };

    const result = handleClipboardPaste(state, process.cwd(), {
      pasteImageFromClipboard: () => ({ mediaType: 'image/png', data: 'iVBORw0KGgo' + 'A'.repeat(200) }),
      pasteFromClipboard: () => '',
    });

    expect(result.pasted).toBe(true);
    expect(result.kind).toBe('image');
    expect(result.prompt).toMatch(/^describe \[IMAGE: img1, clipboard, \d+KB\]$/);
    expect(result.nextImageId).toBe(2);
    expect(state.imageRegistry.get('img1')?.mediaType).toBe('image/png');
    expect(undoCount).toBe(1);
    expect(renderCount).toBe(1);
  });

  test('falls back to text clipboard and stores long text markers', () => {
    const longText = Array.from({ length: 10 }, (_, idx) => `line ${idx + 1}`).join('\n');
    const state = {
      prompt: '',
      cursorPos: 0,
      pasteRegistry: new Map<string, string>(),
      nextPasteId: 1,
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
      requestRender: () => {},
    };

    const result = handleClipboardPaste(state, process.cwd(), {
      pasteImageFromClipboard: () => null,
      pasteFromClipboard: () => longText,
    });

    expect(result.pasted).toBe(true);
    expect(result.kind).toBe('text');
    expect(result.prompt).toBe('[TEXT: p1, 10 lines]');
    expect(result.nextPasteId).toBe(2);
    expect(state.pasteRegistry.get('p1')).toBe(longText);
  });

  test('does not save undo state when no supported clipboard content exists', () => {
    let undoCount = 0;
    const state = {
      prompt: 'unchanged',
      cursorPos: 3,
      pasteRegistry: new Map<string, string>(),
      nextPasteId: 1,
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextImageId: 1,
      saveUndoState: () => { undoCount++; },
      ensureInputCursorVisible: () => {},
      requestRender: () => {},
    };

    const result = handleClipboardPaste(state, process.cwd(), {
      pasteImageFromClipboard: () => null,
      pasteFromClipboard: () => '',
    });

    expect(result.pasted).toBe(false);
    expect(result.kind).toBe('none');
    expect(result.prompt).toBe('unchanged');
    expect(undoCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// expandPrompt, via private accessor
// ---------------------------------------------------------------------------

describe('expandPrompt', () => {
  test('with no images returns plain string', () => {
    const ih = makeInput();
    const result = asImageTestAccess(ih).expandPrompt('hello world');
    expect(typeof result).toBe('string');
    expect(result).toBe('hello world');
  });

  test('with TEXT marker expands to content string', () => {
    const ih = makeInput();
    // Manually inject into pasteRegistry
    asImageTestAccess(ih).pasteRegistry.set('p1', 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9');
    const result = asImageTestAccess(ih).expandPrompt('before [TEXT: p1, 9 lines] after');
    expect(typeof result).toBe('string');
    expect(result).toContain('line1');
    expect(result).toContain('line9');
  });

  test('with IMAGE marker returns ContentPart[]', () => {
    const ih = makeInput();
    const pngData = 'iVBORw0KGgo' + 'A'.repeat(200);
    const marker = ih.registerPaste(pngData);
    // marker = "[IMAGE: img1, clipboard, NKB]"
    const result = asImageTestAccess(ih).expandPrompt(`describe this ${marker}`);
    expect(Array.isArray(result)).toBe(true);
    const content = result as ContentPart[];
    const textParts = content.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text');
    const imageParts = content.filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image');
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
    // Use m2 first, then m1, reverse of insertion order
    const result = asImageTestAccess(ih).expandPrompt(`${m2} text ${m1}`);
    expect(Array.isArray(result)).toBe(true);
    const imageParts = (result as ContentPart[]).filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image');
    expect(imageParts.length).toBe(2);
    // First image in text is m2 (GIF), second is m1 (PNG)
    expect(imageParts[0].mediaType).toBe('image/gif');
    expect(imageParts[1].mediaType).toBe('image/png');
  });
});

// ---------------------------------------------------------------------------
// addUserMessage, ContentPart[] storage
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
    expect(content[1].type).toBe('image');
    if (content[1].type !== 'image') throw new Error('expected image content part');
    expect(content[1].data).toBe('base64data');
    expect(content[1].mediaType).toBe('image/webp');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator capability check strips images for non-multimodal models
// ---------------------------------------------------------------------------

describe('Orchestrator capability check for non-multimodal models', () => {
  test('strips images and adds warning when model lacks multimodal capability', async () => {
    const { ToolRegistry } = await import('@pellux/goodvibes-sdk/platform/tools');
    const { Orchestrator } = await import('@pellux/goodvibes-sdk/platform/core');
    const { ConversationManager } = await import('../../core/conversation.ts');
    const { RuntimeEventBus } = await import('@/runtime/index.ts');

    const runtimeBus = new RuntimeEventBus();
    const toolRegistry = new ToolRegistry();
    const cm = new ConversationManager(() => 80);
    const configManager = createConfigManager();
    const policyRuntimeState = new PolicyRuntimeState();
    const pm = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(configManager), policyRuntimeState);
    const orch = new Orchestrator({
      conversation: cm,
      getViewportHeight: () => 24,
      scrollToEnd: () => {},
      toolRegistry,
      permissionManager: pm,
      getSystemPrompt: () => '',
      runtimeBus,
      services: {
        agentManager: new AgentManager({ configManager }),
        wrfcController: { listChains: () => [] },
      },
    });
    orch.setCoreServices({
      providerRegistry: getTestProviderRegistry(),
      configManager,
    });
    const providerRegistry = getTestProviderRegistry();

    // Inject a non-multimodal model into provider registry for this test
    const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);
    const mockBackingProvider = providerRegistry.get('openrouter');
    if (!mockBackingProvider) throw new Error('Expected openrouter provider in test registry');
    const originalChat = mockBackingProvider.chat.bind(mockBackingProvider);
    let systemMessages: string[] = [];
    const origAddSystem = cm.addSystemMessage.bind(cm);
    cm.addSystemMessage = (msg: string) => {
      systemMessages.push(msg);
      origAddSystem(msg);
    };

    // Patch getCurrentModel to return a non-multimodal model
    providerRegistry.getCurrentModel = () => ({
      id: 'test-model',
      registryKey: 'openrouter:test-model',
      displayName: 'Test Model',
      description: '',
      provider: 'openrouter',
      contextWindow: 8192,
      selectable: true,
      capabilities: { multimodal: false, toolCalling: true, codeEditing: false, reasoning: false },
    });

    // Patch the resolved provider instance to return a fast canned response.
    mockBackingProvider.chat = async () => ({
      content: 'ok',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'completed' as const,
    });

    const content = [
      { type: 'text' as const, text: 'describe this' },
      { type: 'image' as const, data: 'abc', mediaType: 'image/png' },
    ];

    await orch.handleUserInput('describe this', content);

    // Restore
    providerRegistry.getCurrentModel = originalGetCurrentModel;
    mockBackingProvider.chat = originalChat;

    expect(systemMessages.some(m => m.includes('does not support image input'))).toBe(true);
  });
});

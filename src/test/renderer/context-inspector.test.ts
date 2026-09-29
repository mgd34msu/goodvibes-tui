import { describe, test, expect, beforeEach } from 'bun:test';
import { ContextInspectorModal, renderContextInspector } from '../../renderer/context-inspector.ts';
import { ConversationManager } from '../../core/conversation';
import { layerText } from '../helpers/surface-frame.ts';
import type { SurfaceLayer } from '../../renderer/surface-kit.ts';

function linesToText(layer: SurfaceLayer): string[] {
  return layerText(layer);
}
import { estimateTokens, estimateConversationTokens } from '@pellux/goodvibes-sdk/platform/core';

const W = 120;
const H = 40;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConversation(): ConversationManager {
  return new ConversationManager(() => W);
}

// ─── ContextInspectorModal state ──────────────────────────────────────────────────

describe('ContextInspectorModal state', () => {
  test('initially inactive', () => {
    const modal = new ContextInspectorModal();
    expect(modal.active).toBe(false);
  });

  test('open() sets active=true', () => {
    const modal = new ContextInspectorModal();
    modal.open();
    expect(modal.active).toBe(true);
  });

  test('close() sets active=false', () => {
    const modal = new ContextInspectorModal();
    modal.open();
    modal.close();
    expect(modal.active).toBe(false);
  });
});

// ─── renderContextInspector ───────────────────────────────────────────────────

describe('renderContextInspector', () => {
  test('renders empty state when no messages', () => {
    const conv = makeConversation();
    const lines = renderContextInspector(conv, W, H);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('No messages');
  });

  test('the layer stays inside the screen', () => {
    const conv = makeConversation();
    const layer = renderContextInspector(conv, W, H);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(W);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(H);
  });

  test('renders title Context inspector', () => {
    const conv = makeConversation();
    const lines = renderContextInspector(conv, W, H);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Context inspector');
  });

  test('renders total token count when messages present', () => {
    const conv = makeConversation();
    conv.addUserMessage('Hello world, how are you today?');
    const lines = renderContextInspector(conv, W, H);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Total ~');
    expect(text).toContain('token');
  });

  test('renders message count', () => {
    const conv = makeConversation();
    conv.addUserMessage('First message');
    conv.addUserMessage('Second message');
    const lines = renderContextInspector(conv, W, H);
    const text = linesToText(lines).join('\n');
    // Should mention message count (2 messages from user adds 2 user entries)
    expect(text).toMatch(/\d+ message/);
  });

  test('renders role labels', () => {
    const conv = makeConversation();
    conv.addUserMessage('Hello');
    const lines = renderContextInspector(conv, W, H);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('user:');
  });

  test('renders percentage for each message', () => {
    const conv = makeConversation();
    conv.addUserMessage('Hello from the user, this is a fairly long message to ensure tokens are counted.');
    const lines = renderContextInspector(conv, W, H);
    const text = linesToText(lines).join('\n');
    // Should have a percentage like 100.0%
    expect(text).toMatch(/\d+\.\d+%/);
  });

  test('shows context window capacity when provided', () => {
    const conv = makeConversation();
    conv.addUserMessage('Hello');
    const lines = renderContextInspector(conv, W, H, 128000);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('128,000');
  });

  test('shows WARNING when context is 80%+ full', () => {
    const conv = makeConversation();
    // Add a message that would be 80%+ of a tiny context window
    conv.addUserMessage('Hello world');
    // Pass a very small contextWindow so usage exceeds 80%
    const lines = renderContextInspector(conv, W, H, 3); // 3 tokens, content is ~3 tokens
    const text = linesToText(lines).join('\n');
    expect(text).toContain('80% full or more');
  });

  test('marks large consumers (>10%) with highlight marker', () => {
    const conv = makeConversation();
    // A very large message to ensure it exceeds 10%
    conv.addUserMessage('A'.repeat(400));
    conv.addUserMessage('x'); // tiny message
    const lines = renderContextInspector(conv, W, H);
    const text = linesToText(lines).join('\n');
    // The large message entry carries the amber ● marker.
    expect(text).toMatch(/●\s*user: A/);
  });

  test('shows compaction hint when large consumers exist', () => {
    const conv = makeConversation();
    conv.addUserMessage('A'.repeat(400));
    const lines = renderContextInspector(conv, W, H);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('compact');
  });

  test('the title row carries the esc keycap', () => {
    const conv = makeConversation();
    const lines = renderContextInspector(conv, W, H);
    expect(linesToText(lines)[2]).toContain('esc');
  });

  // ── Estimator unification regression (TASK-054) ─────────────────────────────────

  test('estimator unification: SDK estimateConversationTokens agrees with per-message SDK estimateTokens sum', () => {
    // Prove the two SDK functions agree, same formula, consistent output.
    const messages = [
      { role: 'user' as const, content: 'Hello world, this is the first message.' },
      { role: 'assistant' as const, content: 'I understand your message completely.' },
      { role: 'user' as const, content: 'A'.repeat(200) },
    ];
    const conversationTotal = estimateConversationTokens(messages);
    const perMessageSum = messages.reduce((sum, m) => {
      const text = typeof m.content === 'string' ? m.content : '';
      return sum + estimateTokens(text);
    }, 0);
    // Both estimators must agree exactly, single formula, no divergence.
    expect(conversationTotal).toBe(perMessageSum);
    expect(conversationTotal).toBeGreaterThan(0);
  });

  test('estimator unification: inspector total matches estimateConversationTokens for same messages', () => {
    const conv = makeConversation();
    const content = 'Testing token estimator unification across all surfaces.';
    conv.addUserMessage(content);
    const lines = renderContextInspector(conv, W, H);
    const text = linesToText(lines).join('\n');
    // Inspector uses SDK estimateTokens per-message; total should match SDK's conversation estimator.
    const msgs = conv.getMessagesForLLM();
    const expectedTotal = estimateConversationTokens(msgs);
    // The inspector renders the total, verify it shows the expected number.
    expect(text).toContain(expectedTotal.toLocaleString());
  });

  test('a long conversation opens on the newest messages; up scrolls back to older ones', () => {
    const conv = makeConversation();
    for (let i = 0; i < 60; i++) conv.addUserMessage(`Message ${i}`);
    const modal = new ContextInspectorModal();
    modal.open();
    const newest = linesToText(renderContextInspector(conv, W, 24, 0, modal)).join('\n');
    expect(newest).toContain('Message 59');
    expect(newest).not.toContain('Message 0 ');
    expect(newest).toMatch(/\d+ more ↑/);
    modal.scrollBy(1000); // clamped to the oldest page
    const oldest = linesToText(renderContextInspector(conv, W, 24, 0, modal)).join('\n');
    expect(oldest).toContain('Message 0');
    expect(oldest).toMatch(/\d+ more ↓/);
  });
});

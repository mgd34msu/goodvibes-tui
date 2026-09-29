/**
 * kit-modal-fixtures.ts, deterministic example frames for the modals drawn
 * with the modal surface kit in this batch (config-modal surfaces, the
 * generic picker and its recovery questions, help, keyboard shortcuts,
 * context inspector, bookmarks, block actions, profiles, the MCP workspace
 * and onboarding). The kit audit test runs every one of them at several
 * screen sizes.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles';
import type { SurfaceLayer } from '../../renderer/surface-kit.ts';
import { ConfigModal } from '../../input/config-modal.ts';
import type { ConfigModalSurface } from '../../input/config-modal-types.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { renderSelectionModalOverlay } from '../../renderer/selection-modal-overlay.ts';
import { renderHelpOverlay, renderShortcutsOverlay } from '../../renderer/help-overlay.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import type { SlashCommand } from '../../input/command-registry.ts';
import { OverlayFilter } from '../../input/overlay-filter.ts';
import { ContextInspectorModal, renderContextInspector } from '../../renderer/context-inspector.ts';
import { ConversationManager } from '../../core/conversation';
import { BookmarkModal } from '../../input/bookmark-modal.ts';
import { renderBookmarkModal } from '../../renderer/bookmark-modal.ts';
import { BlockActionsMenu } from '../../renderer/block-actions.ts';
import { renderBlockActionsMenu } from '../../renderer/block-actions-overlay.ts';
import { ProfilePickerModal } from '../../input/profile-picker-modal.ts';
import { renderProfilePickerModal } from '../../renderer/profile-picker-modal.ts';
import { McpWorkspace } from '../../input/mcp-workspace.ts';
import { renderMcpWorkspace } from '../../renderer/mcp-workspace.ts';
import { OnboardingWizardController } from '../../input/onboarding/onboarding-wizard.ts';
import { renderOnboardingWizard } from '../../renderer/onboarding/onboarding-wizard.ts';
import {
  RECOVERY_OFFER_TITLE,
  RECOVERY_RETIRE_TITLE,
  buildRecoveryOfferItems,
  buildRecoveryRetireItems,
  describeRecoverySnapshot,
} from '../../runtime/recovery-prompt.ts';
import { marketplaceModalGoldenSurface } from '../../panels/modals/marketplace-modal.ts';
import { hooksModalGoldenSurface } from '../../panels/modals/hooks-modal.ts';
import { securityModalGoldenSurface } from '../../panels/modals/security-modal.ts';
import { keybindingsModalGoldenSurface } from '../../panels/modals/keybindings-modal.ts';
import { pairingModalGoldenSurface } from '../../panels/modals/pairing-modal.ts';
import { memoryModalGoldenSurface } from '../../panels/modals/memory-modal.ts';
import { workPlanModalGoldenSurface } from '../../panels/modals/work-plan-modal.ts';
import { devicesModalGoldenSurface } from '../../panels/modals/devices-modal.ts';
import { createTestManagers } from './test-managers.ts';

export interface KitFrame {
  readonly name: string;
  readonly layer: SurfaceLayer | null;
}

const KEYBINDINGS = new KeybindingsManager({ configPath: '/nonexistent/kit-fixtures-keybindings.json' });

const COMMANDS: SlashCommand[] = [
  { name: 'model', description: 'Select provider or model', handler: () => {} },
  { name: 'sessions', description: 'Browse and resume saved sessions', handler: () => {} },
  { name: 'settings', description: 'Settings and config browser', handler: () => {} },
  { name: 'hooks', description: 'Hook workbench and runtime activity', handler: () => {} },
  { name: 'compact', description: 'Compact the conversation history', handler: () => {} },
];

const FIXED_NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const RECOVERY_FACTS = describeRecoverySnapshot(
  { sessionId: 'a1b2c3d4', timestamp: FIXED_NOW - 3 * 3_600_000, title: 'Refactoring the transcript journal rebind path across sessions' } as never,
  { nowMs: FIXED_NOW, bytes: 1_234_567 },
);

async function configFrame(factory: () => ConfigModalSurface | Promise<ConfigModalSurface>, W: number, H: number): Promise<SurfaceLayer> {
  const modal = new ConfigModal();
  modal.open(await factory(), () => {});
  await Promise.resolve();
  modal.syncStructure();
  const layer = renderConfigModal(modal, W, H);
  modal.close();
  return layer;
}

function pickerFrame(W: number, H: number): SurfaceLayer {
  const modal = new SelectionModal();
  modal.open('Select a theme', [
    { id: 'a', label: 'goodvibes', detail: 'The default theme: calm surfaces and the brand gradient', category: 'Bundled' },
    { id: 'b', label: 'goodvibes-neon', detail: 'The original neon look', category: 'Bundled' },
    { id: 'c', label: 'tokyonight', category: 'Bundled' },
    { id: 'd', label: 'system', detail: 'Follows the terminal palette', category: 'Adaptive' },
  ], { preSelectId: 'b' });
  return renderSelectionModalOverlay(modal, W, H);
}

function recoveryFrame(W: number, H: number, retire: boolean): SurfaceLayer {
  const modal = new SelectionModal();
  modal.open(
    retire ? RECOVERY_RETIRE_TITLE : RECOVERY_OFFER_TITLE,
    retire ? buildRecoveryRetireItems(RECOVERY_FACTS) : buildRecoveryOfferItems(RECOVERY_FACTS),
    { allowSearch: false, primaryVerbLabel: 'Choose' },
  );
  return renderSelectionModalOverlay(modal, W, H);
}

function contextFrame(W: number, H: number): SurfaceLayer {
  const conv = new ConversationManager(() => W);
  for (let i = 0; i < 14; i++) {
    conv.addUserMessage(`Question ${i}: ${'please look at the retry backoff and explain '.repeat(i % 3 + 1)}`);
    conv.addAssistantMessage(`Answer ${i}: ${'the backoff doubles each attempt. '.repeat(i === 5 ? 80 : 4)}`);
  }
  return renderContextInspector(conv, W, H, 128_000, new ContextInspectorModal());
}

function bookmarkFrame(W: number, H: number): SurfaceLayer {
  const manager = createTestManagers().bookmarkManager;
  manager.clear();
  for (let i = 0; i < 12; i++) manager.toggle(`block-${i}`, `tool output ${i}: exec npm test in packages/core`);
  const modal = new BookmarkModal(manager);
  modal.open();
  modal.selectedIndex = 2;
  return renderBookmarkModal(modal, W, H);
}

function blockActionsFrame(W: number, H: number): SurfaceLayer | null {
  const menu = new BlockActionsMenu();
  menu.open({ blockIndex: 0, type: 'diff', startLine: 5, lineCount: 12, rawContent: 'x', collapseKey: 'k0' } as never);
  return renderBlockActionsMenu(menu, W, H);
}

function profileFrame(W: number, H: number): SurfaceLayer {
  const modal = new ProfilePickerModal(new ProfileManager(join(tmpdir(), 'gv-kit-fixtures-profiles')));
  modal.active = true;
  modal.profiles = [
    { name: 'work-profile', timestamp: 1700000000000, filePath: '/x/work-profile.json' },
    { name: 'minimal-profile', timestamp: 1700100000000, filePath: '/x/minimal-profile.json' },
  ];
  modal.deleteConfirmationTarget = 'minimal-profile';
  modal.selectedIndex = 1;
  return renderProfilePickerModal(modal, W, H);
}

function mcpFrame(W: number, H: number, form: boolean): SurfaceLayer {
  const workspace = new McpWorkspace();
  workspace.active = true;
  if (form) workspace.openAddForm();
  return renderMcpWorkspace(workspace, W, H);
}

function onboardingFrame(W: number, H: number): SurfaceLayer {
  const wizard = new OnboardingWizardController();
  wizard.open('new');
  return renderOnboardingWizard(wizard, W, H);
}

/** Every example frame at one screen size. */
export async function buildKitFrames(W: number, H: number): Promise<KitFrame[]> {
  const help = new OverlayFilter();
  const keys = new OverlayFilter();
  const keysFiltered = new OverlayFilter();
  keysFiltered.query = 'panel';
  return [
    { name: 'config-marketplace', layer: await configFrame(marketplaceModalGoldenSurface, W, H) },
    { name: 'config-hooks', layer: await configFrame(hooksModalGoldenSurface, W, H) },
    { name: 'config-security', layer: await configFrame(securityModalGoldenSurface, W, H) },
    { name: 'config-keybindings', layer: await configFrame(keybindingsModalGoldenSurface, W, H) },
    { name: 'config-pairing', layer: await configFrame(pairingModalGoldenSurface, W, H) },
    { name: 'config-memory', layer: await configFrame(memoryModalGoldenSurface, W, H) },
    { name: 'config-work-plan', layer: await configFrame(workPlanModalGoldenSurface, W, H) },
    { name: 'config-devices', layer: await configFrame(devicesModalGoldenSurface, W, H) },
    { name: 'picker', layer: pickerFrame(W, H) },
    { name: 'recovery-offer', layer: recoveryFrame(W, H, false) },
    { name: 'recovery-retire', layer: recoveryFrame(W, H, true) },
    { name: 'help', layer: renderHelpOverlay(W, H, KEYBINDINGS, COMMANDS, 0, help) },
    { name: 'shortcuts', layer: renderShortcutsOverlay(W, H, KEYBINDINGS, 0, keys) },
    { name: 'shortcuts-filtered', layer: renderShortcutsOverlay(W, H, KEYBINDINGS, 0, keysFiltered) },
    { name: 'context-inspector', layer: contextFrame(W, H) },
    { name: 'bookmarks', layer: bookmarkFrame(W, H) },
    { name: 'block-actions', layer: blockActionsFrame(W, H) },
    { name: 'profiles', layer: profileFrame(W, H) },
    { name: 'mcp-browse', layer: mcpFrame(W, H, false) },
    { name: 'mcp-form', layer: mcpFrame(W, H, true) },
    { name: 'onboarding', layer: onboardingFrame(W, H) },
  ];
}

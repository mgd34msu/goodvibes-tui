import type { PanelManager } from '../panel-manager.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';

// (the purge) — group B: 'knowledge' and 'memory' migrated to the
// 'knowledge-modal' / 'memory-modal' config-modal surfaces. Both surfaces and
// their panel→modal redirects are registered centrally in registerBuiltinModals
// (src/panels/builtin-modals.ts). This registrar is intentionally empty
// post-migration, kept as a stable call site invoked from registerBuiltinPanels.
export function registerKnowledgePanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  void manager;
  void deps;
}

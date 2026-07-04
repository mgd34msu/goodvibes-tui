import type { PanelManager } from '../panel-manager.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';

// W6.1 (the purge) — group B: 'knowledge' and 'memory' migrated to the
// 'knowledge' / 'memory' config-modals. Their panel→modal redirects are
// registered centrally in registerOperationsPanels via
// registerEcosystemModalRedirects (src/panels/modals/modal-surface.ts); config
// + dispatch registration with the WO-A host is the one-call
// registerEcosystemModals step. This registrar is intentionally empty
// post-migration, kept as a stable call site invoked from registerBuiltinPanels.
export function registerKnowledgePanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  void manager;
  void deps;
}

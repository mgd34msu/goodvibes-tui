import {
  ECOSYSTEM_MODAL_REDIRECTS,
  type BoundModalSurface,
  type EcosystemModalRegistrar,
} from './modal-surface.ts';
import { bindMarketplaceModal, type MarketplaceModalDeps } from './marketplace-modal.ts';
import { bindPluginsModal, type PluginsModalDeps } from './plugins-modal.ts';
import { bindSkillsModal, type SkillsModalDeps } from './skills-modal.ts';
import { bindHooksModal, type HooksModalDeps } from './hooks-modal.ts';
import { bindSecurityModal, type SecurityModalDeps } from './security-modal.ts';
import { bindPolicyModal, type PolicyModalDeps } from './policy-modal.ts';
import { bindKnowledgeModal, type KnowledgeModalDeps } from './knowledge-modal.ts';
import { bindMemoryModal, type MemoryModalDeps } from './memory-modal.ts';
import { bindWorkPlanModal, type WorkPlanModalDeps } from './work-plan-modal.ts';
import { bindKeybindingsModal, type KeybindingsModalDeps } from './keybindings-modal.ts';
import { bindPairingModal, type PairingModalDeps } from './pairing-modal.ts';
import { bindPlanningModal, type PlanningModalDeps } from './planning-modal.ts';

// ---------------------------------------------------------------------------
// registerEcosystemModals — the ONE integration call (W6.1 group B).
//
// The WO-A config-modal host, once landed, wires this with a single import +
// a single call: it binds every migrated ecosystem/governance surface to its
// live deps and registers each surface's config + dispatch under its name,
// plus the panel→modal redirects. Per-surface deps are supplied nested (not a
// flat union) because two surfaces — marketplace and security — both name a
// `readModel` field of different snapshot types, which a flat union cannot
// express.
//
// The redirect side is ALSO registered independently at runtime today via
// registerEcosystemModalRedirects (called from registerOperationsPanels), so
// `/panel open <id>` and saved layouts resolve on this branch before the host
// lands. registerModalRedirect is idempotent (Map.set), so calling both is
// safe.
// ---------------------------------------------------------------------------

/** Live deps for every migrated group-B surface, nested per surface. */
export interface EcosystemModalDeps {
  readonly marketplace: MarketplaceModalDeps;
  readonly plugins: PluginsModalDeps;
  readonly skills: SkillsModalDeps;
  readonly hooks: HooksModalDeps;
  readonly security: SecurityModalDeps;
  readonly policy: PolicyModalDeps;
  readonly knowledge: KnowledgeModalDeps;
  readonly memory: MemoryModalDeps;
  readonly workPlan: WorkPlanModalDeps;
  readonly keybindings: KeybindingsModalDeps;
  readonly pairing: PairingModalDeps;
  readonly planning: PlanningModalDeps;
}

/**
 * Build every group-B modal surface, bound to its live deps. Order is stable
 * and matches ECOSYSTEM_MODAL_REDIRECTS for easy cross-checking.
 */
export function buildEcosystemModalSurfaces(deps: EcosystemModalDeps): readonly BoundModalSurface[] {
  return [
    bindMarketplaceModal(deps.marketplace),
    bindPluginsModal(deps.plugins),
    bindSkillsModal(deps.skills),
    bindHooksModal(deps.hooks),
    bindSecurityModal(deps.security),
    bindPolicyModal(deps.policy),
    bindKnowledgeModal(deps.knowledge),
    bindMemoryModal(deps.memory),
    bindWorkPlanModal(deps.workPlan),
    bindKeybindingsModal(deps.keybindings),
    bindPairingModal(deps.pairing),
    bindPlanningModal(deps.planning),
  ];
}

/**
 * Register every migrated group-B surface (config + dispatch) with the host's
 * registrar, plus the panel→modal redirects. This is the single call the
 * integrator wires from the WO-A host (builtin-modals.ts) once it exists.
 */
export function registerEcosystemModals(registrar: EcosystemModalRegistrar, deps: EcosystemModalDeps): void {
  for (const surface of buildEcosystemModalSurfaces(deps)) {
    registrar.registerModal(surface);
  }
  for (const [panelId, modalName] of ECOSYSTEM_MODAL_REDIRECTS) {
    registrar.registerModalRedirect(panelId, modalName);
  }
}

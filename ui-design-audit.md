# Design Audit: Panels, Modals, Subagent Monitor — UI Redesign Track

**Generated**: 2026-06-11 ~23:00 | Surface quality score: 6.0/10 | Verdict: chrome infrastructure is GOOD (polish.ts 718L, ScrollableListPanel, ModalFactory) — the problem is inconsistent ADOPTION, the missing frame, and a 4-idiom agent monitor.

## Headline findings
- CRITICAL: agent-detail-modal renders FABRICATED token counts (toolCallCount × 400) with the authority of real metrics (agent-detail-modal.ts:14,106,153,179)
- CRITICAL: no cancel/kill from any agent view except WRFC panel + process-modal — inspecting a runaway agent gives you [Esc] Close
- HIGH: zero shared keymap-footer helper; 52 inline footers across 31 files; one panel duplicates the same footer 4×; many panels advertise no keys at all
- HIGH: three competing selection-highlight mechanisms (gutter / buildPanelListRow / hand-rolled bg)
- HIGH: cockpit has no roster, no per-agent cost, no actions — it's gauges that tell you to go elsewhere
- MED: panels have NO border while modals get full frames — two design languages, the core of "looks horrible"; 49 panels declare private palettes alongside DEFAULT_PANEL_PALETTE; dead pre-migration helpers in agent-logs; selector strips overflow at >5 agents

## The Redesign Track (UI-1 … UI-8)
- UI-1: buildKeymapFooter helper in polish.ts + migrate all 31 footer sites | M
- UI-2: panel FRAME standard (bordered title bar matching modal language) + summary-strip anatomy; reference: agent-logs (base-class use) + cockpit (section discipline) | M
- UI-3: one canonical selection treatment (buildPanelListRow marker+selectBg); kill the other two | M
- UI-4: real tokens in agent-detail (cost-tracker source) + delete the ×400 fabrication (= substrate TASK-044) | S/M
- UI-5: cancel binding on every agent surface (= substrate TASK-043) | M
- UI-6: cockpit roster section per the audit's screen sketch (columnar rows, tree via process-modal's appendAgentSubtree, status dots, aggregate header; pressure pills demoted) (= F2 + TASK-046/047) | L
- UI-7: modal key/value section renderer (kill flat text dumps + manual space alignment); scroll gutter affordance | M
- UI-8: palette sourcing consolidation via extendPalette (sourcing only; values = TASK-023); migrate 23 hand-rolled panels onto base classes; delete agent-logs dead helpers after call-graph check | M/L

Full ASCII anatomy sketches for panel/modal/cockpit standards are in the audit output (activity log reference); reference implementations named per surface.

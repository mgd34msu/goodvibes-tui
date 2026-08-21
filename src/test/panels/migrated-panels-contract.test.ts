// ---------------------------------------------------------------------------
// migrated-panels-contract.test.ts
//
// Thin runner (decongestion): every migrated panel's BasePanel
// contract test now lives in its own module under
// src/test/panels/contract/<panel-id>.contract.ts so a work order touching
// one panel edits only that panel's module. This file imports every
// contract module (registering their describe/test blocks with bun:test)
// and asserts that the contract-module count matches the expected registry
// size, preserving the module/registry parity check.
//
// (the purge): 13 contract modules were removed along with their
// panels (RETIRE-INTO-FLEET: incident-review, routes, ops-control,
// automation-control, approval, communication, worktree, control-plane,
// wrfc, plan-dashboard, orchestration, tasks; DELETE: system-messages),
// see .goodvibes/audit/2026-07-04-wave6-briefs.json. Count dropped
// from 28 to 15.
//
// (config-modal migration, same wave): services, subscription, and
// settings-sync were migrated to config-modal surfaces and their contract
// modules removed; sandbox, remote, and provider-health were also migrated
// to modals but never had contract modules of their own. Count dropped
// from 15 to 12.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import './contract/skills-panel.contract.ts';
import './contract/plugins-panel.contract.ts';
import './contract/local-auth-panel.contract.ts';
import './contract/git-panel.contract.ts';
import './contract/diff-panel.contract.ts';
import './contract/token-budget-panel.contract.ts';

// (the purge), the two config-modal migrations combined: removed
// the services/subscription/settings-sync contract modules (sandbox, remote,
// provider-health had none of their own), and removed marketplace, hooks,
// security, knowledge-graph, memory, and project-planning as those panels
// migrated to config-modal surfaces under src/panels/modals/ (golden-tested in
// ecosystem-modals-golden.test.ts + config-modal-surfaces-*.test.ts). The
// skills/plugins panel classes are retained (shared non-class exports) so their
// contract modules stay. Surviving modules: skills, plugins, local-auth, git,
// diff, token-budget. Count dropped from 15 → 6.

// One entry per registered panel covered by this contract suite. Kept as an
// explicit count (rather than trusting a bare directory listing on its own)
// so a stray file left in contract/ without being wired up above still fails
// the parity check below instead of silently losing coverage.
const CONTRACT_MODULE_COUNT = 6;

describe('migrated panels: contract module registry parity', () => {
  test('one contract module exists per registered panel', () => {
    const contractDir = join(dirname(fileURLToPath(import.meta.url)), 'contract');
    const filesOnDisk = readdirSync(contractDir).filter((f) => f.endsWith('.contract.ts'));
    expect(filesOnDisk.length).toBe(CONTRACT_MODULE_COUNT);
  });
});

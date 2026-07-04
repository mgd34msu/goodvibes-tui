// ---------------------------------------------------------------------------
// migrated-panels-contract.test.ts
//
// Thin runner (WO-006 decongestion): every migrated panel's BasePanel
// contract test now lives in its own module under
// src/test/panels/contract/<panel-id>.contract.ts so a work order touching
// one panel edits only that panel's module. This file imports every
// contract module (registering their describe/test blocks with bun:test)
// and asserts that the contract-module count matches the expected registry
// size, preserving the module/registry parity check from before the split.
//
// W6.1 (the purge): 13 contract modules were removed along with their
// panels (RETIRE-INTO-FLEET: incident-review, routes, ops-control,
// automation-control, approval, communication, worktree, control-plane,
// wrfc, plan-dashboard, orchestration, tasks; DELETE: system-messages) —
// see .goodvibes/audit/2026-07-04-wave6-briefs.json (W6.1). Count dropped
// from 28 to 15.
//
// W6.1 (config-modal migration, same wave): services, subscription, and
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
import './contract/hooks-panel.contract.ts';
import './contract/security-panel.contract.ts';
import './contract/plugins-panel.contract.ts';
import './contract/local-auth-panel.contract.ts';
import './contract/git-panel.contract.ts';
import './contract/diff-panel.contract.ts';
import './contract/token-budget-panel.contract.ts';
import './contract/project-planning-panel.contract.ts';
import './contract/memory-panel.contract.ts';
import './contract/knowledge-graph-panel.contract.ts';
import './contract/marketplace-panel.contract.ts';

// One entry per registered panel covered by this contract suite. Kept as an
// explicit count (rather than trusting a bare directory listing on its own)
// so a stray file left in contract/ without being wired up above still fails
// the parity check below instead of silently losing coverage.
const CONTRACT_MODULE_COUNT = 12;

describe('migrated panels — contract module registry parity', () => {
  test('one contract module exists per registered panel', () => {
    const contractDir = join(dirname(fileURLToPath(import.meta.url)), 'contract');
    const filesOnDisk = readdirSync(contractDir).filter((f) => f.endsWith('.contract.ts'));
    expect(filesOnDisk.length).toBe(CONTRACT_MODULE_COUNT);
  });
});

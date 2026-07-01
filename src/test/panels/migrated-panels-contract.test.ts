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
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import './contract/incident-review-panel.contract.ts';
import './contract/watchers-panel.contract.ts';
import './contract/routes-panel.contract.ts';
import './contract/skills-panel.contract.ts';
import './contract/hooks-panel.contract.ts';
import './contract/security-panel.contract.ts';
import './contract/settings-sync-panel.contract.ts';
import './contract/subscription-panel.contract.ts';
import './contract/plugins-panel.contract.ts';
import './contract/local-auth-panel.contract.ts';
import './contract/services-panel.contract.ts';
import './contract/ops-control-panel.contract.ts';
import './contract/automation-control-panel.contract.ts';
import './contract/approval-panel.contract.ts';
import './contract/communication-panel.contract.ts';
import './contract/agent-logs-panel.contract.ts';
import './contract/worktree-panel.contract.ts';
import './contract/control-plane-panel.contract.ts';
import './contract/provider-accounts-panel.contract.ts';
import './contract/git-panel.contract.ts';
import './contract/diff-panel.contract.ts';
import './contract/wrfc-panel.contract.ts';
import './contract/token-budget-panel.contract.ts';
import './contract/plan-dashboard-panel.contract.ts';
import './contract/project-planning-panel.contract.ts';
import './contract/system-messages-panel.contract.ts';
import './contract/orchestration-panel.contract.ts';
import './contract/memory-panel.contract.ts';
import './contract/knowledge-graph-panel.contract.ts';
import './contract/marketplace-panel.contract.ts';
import './contract/tasks-panel.contract.ts';

// One entry per registered panel covered by this contract suite. Kept as an
// explicit count (rather than trusting a bare directory listing on its own)
// so a stray file left in contract/ without being wired up above still fails
// the parity check below instead of silently losing coverage.
const CONTRACT_MODULE_COUNT = 31;

describe('migrated panels — contract module registry parity', () => {
  test('one contract module exists per registered panel', () => {
    const contractDir = join(dirname(fileURLToPath(import.meta.url)), 'contract');
    const filesOnDisk = readdirSync(contractDir).filter((f) => f.endsWith('.contract.ts'));
    expect(filesOnDisk.length).toBe(CONTRACT_MODULE_COUNT);
  });
});

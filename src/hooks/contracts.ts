import { matchesEventPath } from './matcher.ts';
import type { HookCategory, HookEventPath, HookPhase } from './types.ts';

export type HookExecutionMode = 'blocking' | 'non_blocking' | 'background';
export type HookAuthority = 'intercept' | 'observe' | 'defer' | 'chain';

export interface HookPointContract {
  pattern: HookEventPath;
  description: string;
  authority: HookAuthority;
  executionMode: HookExecutionMode;
  canDeny: boolean;
  canMutateInput: boolean;
  canInjectContext: boolean;
  timeoutMs: number;
  failurePolicy: 'fail_open' | 'fail_closed' | 'log_only';
}

const CONTRACTS: HookPointContract[] = [
  {
    pattern: 'Pre:tool:*',
    description: 'Intercept a tool call before execution.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: true,
    canInjectContext: true,
    timeoutMs: 30_000,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:tool:*',
    description: 'Observe a successful tool execution.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:tool:*',
    description: 'Observe a failed tool execution.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Post:file:*',
    description: 'Observe file mutations or file-oriented tool success.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:file:*',
    description: 'Observe file-related failures.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Pre:llm:chat',
    description: 'Intercept outbound LLM chat requests.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 30_000,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:llm:chat',
    description: 'Observe successful LLM responses.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:llm:chat',
    description: 'Observe failed LLM requests.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Pre:mcp:call',
    description: 'Intercept an MCP tool call before invocation.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 15_000,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:mcp:call',
    description: 'Observe a successful MCP tool call.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:mcp:call',
    description: 'Observe a failed MCP tool call.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Pre:compact:*',
    description: 'Intercept compaction before it mutates runtime context.',
    authority: 'intercept',
    executionMode: 'blocking',
    canDeny: true,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 15_000,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:compact:*',
    description: 'Observe successful compaction.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:compact:*',
    description: 'Observe compaction failures.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: true,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:session:*',
    description: 'Observe session lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:agent:*',
    description: 'Observe agent lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:workflow:*',
    description: 'Observe workflow lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:orchestration:*',
    description: 'Observe orchestration graph and node lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:communication:*',
    description: 'Observe structured communication delivery and blocked-route lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:orchestration:*',
    description: 'Observe orchestration guard rails, recursion limits, and graph mutations.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:communication:*',
    description: 'Observe communication routing changes, policy blocks, and message flow anomalies.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 30_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Pre:permission:request',
    description: 'Observe a permission escalation before the shell prompt resolves it.',
    authority: 'observe',
    executionMode: 'blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 15_000,
    failurePolicy: 'fail_open',
  },
  {
    pattern: 'Post:permission:decision',
    description: 'Observe the final permission decision for a tool or transport action.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Fail:permission:request',
    description: 'Observe permission prompt failures and resolution errors.',
    authority: 'observe',
    executionMode: 'non_blocking',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:mcp:*',
    description: 'Observe MCP server lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Lifecycle:transport:*',
    description: 'Observe ACP, daemon, and remote transport lifecycle changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:config:*',
    description: 'Observe configuration changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:file:*',
    description: 'Observe external file state changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
  {
    pattern: 'Change:budget:*',
    description: 'Observe budget threshold changes.',
    authority: 'observe',
    executionMode: 'background',
    canDeny: false,
    canMutateInput: false,
    canInjectContext: false,
    timeoutMs: 15_000,
    failurePolicy: 'log_only',
  },
];

function specificityScore(pattern: string): number {
  return pattern.split(':').reduce((score, segment) => score + (segment === '*' ? 0 : 1), 0);
}

export function listHookPointContracts(): HookPointContract[] {
  return [...CONTRACTS];
}

export function getHookPointContract(path: HookEventPath): HookPointContract | null {
  let best: HookPointContract | null = null;
  let bestScore = -1;
  for (const contract of CONTRACTS) {
    if (!matchesEventPath(contract.pattern, path)) continue;
    const score = specificityScore(contract.pattern);
    if (score > bestScore) {
      best = contract;
      bestScore = score;
    }
  }
  return best;
}

export function parseHookPath(path: HookEventPath): {
  phase: HookPhase;
  category: HookCategory;
  specific: string;
} {
  const [phase, category, ...specificParts] = path.split(':');
  return {
    phase: phase as HookPhase,
    category: category as HookCategory,
    specific: specificParts.join(':'),
  };
}

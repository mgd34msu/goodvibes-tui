import { randomUUID } from 'node:crypto';
import { PersistentStore } from '../state/persistent-store.ts';
import type {
  ChannelConversationKind,
  ChannelGroupPolicyRecord,
  ChannelIngressPolicyInput,
  ChannelPolicyAuditRecord,
  ChannelPolicyDecision,
  ChannelPolicyRecord,
  ChannelSurface,
} from './types.ts';

interface ChannelPolicySnapshot extends Record<string, unknown> {
  readonly policies: readonly ChannelPolicyRecord[];
  readonly audit: readonly ChannelPolicyAuditRecord[];
}

const MAX_AUDIT_RECORDS = 500;

function defaultPolicy(surface: ChannelSurface): ChannelPolicyRecord {
  return {
    surface,
    enabled: true,
    requireMention: false,
    allowDirectMessages: true,
    allowGroupMessages: true,
    allowThreadMessages: true,
    dmPolicy: 'inherit',
    groupPolicy: 'inherit',
    allowTextCommandsWithoutMention: false,
    allowlistUserIds: [],
    allowlistChannelIds: [],
    allowlistGroupIds: [],
    allowedCommands: [],
    groupPolicies: [],
    updatedAt: Date.now(),
    metadata: {},
  };
}

function normalizeGroupPolicy(policy: ChannelGroupPolicyRecord): ChannelGroupPolicyRecord {
  return {
    ...policy,
    metadata: policy.metadata ?? {},
  };
}

function normalizeConversationKind(input: ChannelIngressPolicyInput): ChannelConversationKind {
  if (input.conversationKind) return input.conversationKind;
  if (input.threadId) return 'thread';
  if (input.groupId) return 'group';
  if (input.channelId) return 'channel';
  return 'service';
}

function firstCommand(text: string | undefined, explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim().toLowerCase();
  if (!text) return '';
  return text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
}

function commandAllowed(command: string, allowedCommands: readonly string[]): boolean {
  if (allowedCommands.length === 0 || !command) return true;
  return allowedCommands.map((entry) => entry.toLowerCase()).includes(command);
}

export class ChannelPolicyManager {
  private readonly store: PersistentStore<ChannelPolicySnapshot>;
  private readonly policies = new Map<ChannelSurface, ChannelPolicyRecord>();
  private readonly audit: ChannelPolicyAuditRecord[] = [];
  private loaded = false;

  constructor(
    options: {
      readonly store?: PersistentStore<ChannelPolicySnapshot>;
      readonly storePath?: string;
    },
  ) {
    if (options.store) {
      this.store = options.store;
      return;
    }
    if (!options.storePath) {
      throw new Error('ChannelPolicyManager requires an explicit store or storePath');
    }
    this.store = new PersistentStore<ChannelPolicySnapshot>(options.storePath);
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    const snapshot = await this.store.load();
    this.policies.clear();
    this.audit.length = 0;
    for (const policy of snapshot?.policies ?? []) {
      this.policies.set(policy.surface, {
        ...defaultPolicy(policy.surface),
        ...policy,
        allowDirectMessages: policy.allowDirectMessages ?? true,
        allowGroupMessages: policy.allowGroupMessages ?? true,
        allowThreadMessages: policy.allowThreadMessages ?? true,
        dmPolicy: policy.dmPolicy ?? 'inherit',
        groupPolicy: policy.groupPolicy ?? 'inherit',
        allowTextCommandsWithoutMention: policy.allowTextCommandsWithoutMention ?? false,
        allowlistGroupIds: policy.allowlistGroupIds ?? [],
        groupPolicies: (policy.groupPolicies ?? []).map(normalizeGroupPolicy),
        metadata: policy.metadata ?? {},
      });
    }
    this.audit.push(...(snapshot?.audit ?? []));
    this.loaded = true;
  }

  listPolicies(): ChannelPolicyRecord[] {
    return [...this.policies.values()].sort((a, b) => a.surface.localeCompare(b.surface));
  }

  listAudit(limit = 100): ChannelPolicyAuditRecord[] {
    return this.audit.slice(0, Math.max(1, limit));
  }

  getPolicy(surface: ChannelSurface): ChannelPolicyRecord {
    return this.policies.get(surface) ?? defaultPolicy(surface);
  }

  async upsertPolicy(
    surface: ChannelSurface,
    patch: Partial<Omit<ChannelPolicyRecord, 'surface' | 'updatedAt'>>,
  ): Promise<ChannelPolicyRecord> {
    await this.start();
    const existing = this.getPolicy(surface);
    const next: ChannelPolicyRecord = {
      ...existing,
      ...patch,
      surface,
      updatedAt: Date.now(),
      allowDirectMessages: patch.allowDirectMessages ?? existing.allowDirectMessages,
      allowGroupMessages: patch.allowGroupMessages ?? existing.allowGroupMessages,
      allowThreadMessages: patch.allowThreadMessages ?? existing.allowThreadMessages,
      dmPolicy: patch.dmPolicy ?? existing.dmPolicy,
      groupPolicy: patch.groupPolicy ?? existing.groupPolicy,
      allowTextCommandsWithoutMention: patch.allowTextCommandsWithoutMention ?? existing.allowTextCommandsWithoutMention,
      allowlistUserIds: patch.allowlistUserIds ?? existing.allowlistUserIds,
      allowlistChannelIds: patch.allowlistChannelIds ?? existing.allowlistChannelIds,
      allowlistGroupIds: patch.allowlistGroupIds ?? existing.allowlistGroupIds,
      allowedCommands: patch.allowedCommands ?? existing.allowedCommands,
      groupPolicies: (patch.groupPolicies ?? existing.groupPolicies).map(normalizeGroupPolicy),
      metadata: patch.metadata ?? existing.metadata,
    };
    this.policies.set(surface, next);
    await this.persist();
    return next;
  }

  async evaluateIngress(input: ChannelIngressPolicyInput): Promise<ChannelPolicyDecision> {
    await this.start();
    const policy = this.getPolicy(input.surface);
    const conversationKind = normalizeConversationKind(input);
    const matchedGroupPolicy = policy.groupPolicies.find((entry) => (
      (entry.groupId && input.groupId && entry.groupId === input.groupId)
      || (entry.channelId && input.channelId && entry.channelId === input.channelId)
      || (entry.workspaceId && input.workspaceId && entry.workspaceId === input.workspaceId)
    ));
    const requireMention = matchedGroupPolicy?.requireMention ?? policy.requireMention;
    const allowTextCommandsWithoutMention = matchedGroupPolicy?.allowTextCommandsWithoutMention
      ?? policy.allowTextCommandsWithoutMention;
    const allowlistUserIds = matchedGroupPolicy?.allowlistUserIds ?? policy.allowlistUserIds;
    const allowlistChannelIds = matchedGroupPolicy?.allowlistChannelIds ?? policy.allowlistChannelIds;
    const allowlistGroupIds = matchedGroupPolicy?.allowlistGroupIds ?? policy.allowlistGroupIds;
    const allowedCommands = matchedGroupPolicy?.allowedCommands ?? policy.allowedCommands;
    const allowGroupMessages = matchedGroupPolicy?.allowGroupMessages ?? policy.allowGroupMessages;
    const allowThreadMessages = matchedGroupPolicy?.allowThreadMessages ?? policy.allowThreadMessages;
    const command = firstCommand(input.text, input.controlCommand);
    const isAuthorizedControlCommand = commandAllowed(command, allowedCommands);
    const bypassMention =
      (conversationKind === 'group' || conversationKind === 'channel' || conversationKind === 'thread')
      && requireMention
      && !input.mentioned
      && !input.hasAnyMention
      && allowTextCommandsWithoutMention
      && Boolean(command)
      && isAuthorizedControlCommand;
    let allowed = true;
    let reason = 'allowed';
    if (!policy.enabled) {
      allowed = false;
      reason = 'surface-disabled';
    } else if (conversationKind === 'direct' && (policy.dmPolicy === 'deny' || !policy.allowDirectMessages)) {
      allowed = false;
      reason = 'direct-messages-disabled';
    } else if ((conversationKind === 'group' || conversationKind === 'channel') && (policy.groupPolicy === 'deny' || !allowGroupMessages)) {
      allowed = false;
      reason = 'group-messages-disabled';
    } else if (conversationKind === 'thread' && !allowThreadMessages) {
      allowed = false;
      reason = 'thread-messages-disabled';
    } else if (allowlistGroupIds.length > 0 && input.groupId && !allowlistGroupIds.includes(input.groupId)) {
      allowed = false;
      reason = 'group-not-allowlisted';
    } else if (allowlistGroupIds.length > 0 && !input.groupId) {
      allowed = false;
      reason = 'missing-group-identity';
    } else if (allowlistUserIds.length > 0 && input.userId && !allowlistUserIds.includes(input.userId)) {
      allowed = false;
      reason = 'user-not-allowlisted';
    } else if (allowlistUserIds.length > 0 && !input.userId) {
      allowed = false;
      reason = 'missing-user-identity';
    } else if (allowlistChannelIds.length > 0 && input.channelId && !allowlistChannelIds.includes(input.channelId)) {
      allowed = false;
      reason = 'channel-not-allowlisted';
    } else if (allowlistChannelIds.length > 0 && !input.channelId) {
      allowed = false;
      reason = 'missing-channel-identity';
    } else if (requireMention && !input.mentioned && !bypassMention) {
      allowed = false;
      reason = 'mention-required';
    } else if (!commandAllowed(command, allowedCommands)) {
      allowed = false;
      reason = 'command-not-allowed';
    }

    this.audit.unshift({
      id: `policy-audit-${randomUUID().slice(0, 8)}`,
      surface: input.surface,
      createdAt: Date.now(),
      allowed,
      reason,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      conversationKind,
      ...(matchedGroupPolicy?.id ? { matchedGroupPolicyId: matchedGroupPolicy.id } : {}),
      ...(input.text ? { text: input.text.slice(0, 200) } : {}),
      metadata: input.metadata ?? {},
    });
    if (this.audit.length > MAX_AUDIT_RECORDS) {
      this.audit.length = MAX_AUDIT_RECORDS;
    }
    await this.persist();

    return {
      allowed,
      reason,
      policy,
      ...(matchedGroupPolicy ? { matchedGroupPolicy } : {}),
      matchedScope: matchedGroupPolicy ? 'group' : 'surface',
      effectiveRequireMention: requireMention,
      effectiveAllowedCommands: allowedCommands,
    };
  }

  private async persist(): Promise<void> {
    await this.store.persist({
      policies: this.listPolicies(),
      audit: [...this.audit],
    });
  }
}

/**
 * render.ts — turning the daemon's answers into lines a person reads.
 *
 * Every function here is pure: structured data in, strings out. The verb layer
 * decided what is true; this decides how to say it. That split is what lets
 * `--json` print the same data with no second code path, and what lets the TUI
 * and a web UI render the same answers their own way.
 */
import { generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing';
import type {
  CreateGroupResult,
  DiscoveredGroup,
  ForgetNodeResult,
  GroupStatusReport,
  JoinGroupResult,
  JoinKeyResult,
  NodesResult,
} from '@pellux/goodvibes-sdk/platform/cluster';

/** How long ago, in words. Never a raw timestamp — nobody reads epoch millis. */
export function describeAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * `cluster status`.
 *
 * Leads with the thing the operator came for — the role of THIS machine and
 * which surfaces it holds — and finishes with the one sentence of advice, if
 * there is anything to do.
 */
export function renderStatus(report: GroupStatusReport, now: number): string[] {
  if (report.membership !== 'member') {
    return [
      report.membership === 'no-group'
        ? 'this machine is not in a group'
        : 'this machine has group key material that could not be read',
      `machine: ${report.nodeName} (${report.nodeId})`,
      `version: ${report.version}`,
      ...(report.advice ? ['', report.advice] : []),
    ];
  }
  const lines = [
    `group:    ${report.groupName ?? '(unnamed)'}  [${report.groupId ?? 'unknown'}]`,
    `machine:  ${report.nodeName} (${report.nodeId})`,
    `members:  ${report.memberCount}`,
    `version:  ${report.version}`,
  ];

  if (report.surfaces === null) {
    lines.push('surfaces: not reported by this daemon');
  } else if (report.surfaces.length === 0) {
    lines.push('surfaces: none held by this machine right now');
  } else {
    lines.push('surfaces held by this machine:');
    for (const holding of report.surfaces) {
      lines.push(`  ${holding.surfaceId}  — ${holding.reason}`);
    }
  }

  lines.push(
    '',
    `group key: generation ${report.keyGeneration ?? 0}, rotates every ${report.rotationHours}h`,
    `           ${report.keyGenerationsHeld} of at most ${report.keyGenerationCap} generations kept; `
      + `accepting ${report.acceptedGenerations.join(' and ') || 'none'}`,
  );
  if (report.removedNodeCount > 0) {
    lines.push(`removed machines on record: ${report.removedNodeCount}`);
  }
  if (report.wire) {
    lines.push(
      `traffic:   ${report.wire.sent} sent, ${report.wire.received} received; dropped `
        + `${report.wire.droppedOtherGroup} from other groups, ${report.wire.droppedBadSignature} unverified, `
        + `${report.wire.droppedOldGeneration} on an old key, ${report.wire.droppedMalformed} malformed`
        + (report.wire.droppedNoGroup > 0
          ? `; ${report.wire.droppedNoGroup} not sent because this machine is in no group`
          : ''),
    );
  }
  if (report.advice) lines.push('', report.advice);
  // Deliberately absent, and it should stay absent: the join key, the group
  // key, any generation of it, and this machine's private keys. `cluster key`
  // is the only path to the join key and nothing shows the rest at all.
  void now;
  return lines;
}

/** `cluster nodes`. */
export function renderNodes(result: NodesResult, now: number): string[] {
  const lines = [`group: ${result.groupName}  [${result.groupId}]`, ''];
  if (result.members.length === 0) {
    lines.push('no machines in this group yet');
  } else {
    const width = Math.max(...result.members.map((member) => member.displayName.length), 12);
    lines.push(`${pad('MACHINE', width)}  ${pad('NODE ID', 38)}  LAST SEEN`);
    for (const member of result.members) {
      const suffix = member.isThisMachine ? '  (this machine)' : '';
      lines.push(
        `${pad(member.displayName, width)}  ${pad(member.nodeId, 38)}  ${describeAge(member.lastSeenAt, now)}${suffix}`,
      );
    }
  }
  if (result.removed.length > 0) {
    lines.push('', 'removed from this group:');
    for (const entry of result.removed) {
      lines.push(`  ${entry.nodeId}  ${describeAge(entry.removedAt, now)}  (${entry.reason})`);
    }
  }
  return lines;
}

/** `cluster create`. */
export function renderCreated(result: CreateGroupResult): string[] {
  return [
    `created the group "${result.groupName}"  [${result.groupId}]`,
    '',
    result.generatedKey
      ? 'a join key was generated for you. Run `cluster key` on this machine at any'
      : 'your join phrase is in use. Run `cluster key` on this machine at any',
    'time to see it again — it is not a one-time reveal.',
    '',
    'to add another machine: run `cluster join` on it and give it this key.',
    '',
    `the group name ("${result.groupName}") is visible to anything on this network that`,
    'is listening for goodvibes groups. Change it any time with `cluster rename`.',
  ];
}

/** `cluster join`. */
export function renderJoined(result: JoinGroupResult): string[] {
  return [
    `joined "${result.groupName}"  [${result.groupId}]`,
    `the group now has ${result.memberCount} machine${result.memberCount === 1 ? '' : 's'}.`,
  ];
}

/** `cluster forget`. */
export function renderForgotten(result: ForgetNodeResult): string[] {
  return [
    `removed ${result.displayName} (${result.nodeId}) from the group`,
    `the group key was replaced immediately, so that machine's copy no longer works.`,
    `${result.memberCount} machine${result.memberCount === 1 ? '' : 's'} remain${result.memberCount === 1 ? 's' : ''}.`,
  ];
}

/** The groups seen advertising themselves on this network. */
export function renderDiscovered(groups: readonly DiscoveredGroup[], now: number): string[] {
  if (groups.length === 0) {
    return [
      'no goodvibes groups are advertising themselves on this network',
      '',
      'if the machine you want to join is switched on and has clustering enabled,',
      'check that both machines are on the same network and that it is not blocking',
      'multicast. You can also join by id directly: cluster join --group <id> --key <key>',
    ];
  }
  const width = Math.max(...groups.map((group) => group.displayName.length), 10);
  const lines = [`${pad('GROUP', width)}  ${pad('ID', 18)}  MACHINES  VERSION  SEEN`];
  for (const group of groups) {
    lines.push(
      `${pad(group.displayName, width)}  ${pad(group.groupId, 18)}  ${pad(String(group.nodeCount), 8)}  `
        + `${pad(group.version, 7)}  ${describeAge(group.lastSeenAt, now)}`,
    );
  }
  return lines;
}

/**
 * Ask the terminal to put the join key on the clipboard, using OSC 52.
 *
 * OSC 52 is the only clipboard mechanism that works through SSH, which is the
 * case that matters: the operator is on a headless box in a cupboard. It is
 * also not universally supported and gives no acknowledgement, so this NEVER
 * claims success — it says what it attempted, and the key is printed either
 * way. Silently doing nothing would be the worst of the three options.
 */
export function clipboardEscapeSequence(value: string): string {
  return `]52;c;${Buffer.from(value, 'utf8').toString('base64')}`;
}

export interface JoinKeyRendering {
  /** Lines to print. */
  readonly lines: string[];
  /** The raw escape sequence to write, or null when the output is not a terminal. */
  readonly clipboardSequence: string | null;
}

export function renderJoinKey(result: JoinKeyResult, isTerminal: boolean): JoinKeyRendering {
  return {
    lines: [
      `join key for "${result.groupName}"  [${result.groupId}]`,
      '',
      `  ${result.joinKey}`,
      '',
      ...(isTerminal
        ? ['copied to the clipboard, if this terminal accepts clipboard writes over its connection.',
          'if nothing was copied, the key is printed above.']
        : ['(not a terminal, so no clipboard copy was attempted)']),
      '',
      `to add a machine: run  cluster join --group ${result.groupId} --key <the key above>`,
    ],
    clipboardSequence: isTerminal ? clipboardEscapeSequence(result.joinKey) : null,
  };
}

/**
 * The join key as a QR code, for typing it into a phone or a second terminal.
 *
 * This reuses the daemon's existing QR renderer verbatim — the same one the
 * pairing flow already prints to a terminal — rather than introducing any new
 * machinery for it. Opt-in behind `--qr`, because a QR block is tall and most
 * of the time the operator is copying the key with the mouse or the clipboard.
 */
export function renderJoinKeyQr(joinKey: string): string[] {
  return [renderQrToString(generateQrMatrix(joinKey))];
}

/** A refusal, in the shape every failing subcommand prints. */
export function renderFailure(error: string, fix: string): string[] {
  return [`cluster: ${error}`, `  ${fix}`];
}

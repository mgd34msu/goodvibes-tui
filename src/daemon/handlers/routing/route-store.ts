import { randomUUID } from 'node:crypto';
import { HandlerSqliteStore } from '../sqlite-store.ts';
import { HandlerError } from '../errors.ts';

/**
 * A persisted channel-to-profile routing assignment, in the exact shape the
 * `channels.routing.*` methods serve. Keyed on a composite `channelId`
 * (`surfaceKind` or `surfaceKind:routeId`). The SDK output schemas require
 * `surfaceKind`, `profileId`, `createdAt`, and `updatedAt`; `channelId`,
 * `routeId`, and `label` are carried through as optional refinements.
 */
export interface RoutingChannelRoute {
  assignmentId: string;
  /** Composite key: `surfaceKind` or `surfaceKind:routeId`. */
  channelId: string;
  surfaceKind: string;
  routeId?: string;
  profileId: string;
  label?: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/**
 * Per-route item shape emitted by `channels.routing.list`, matching the SDK
 * `CHANNEL_ROUTING_RULE_SCHEMA` exactly: properties
 * {id, createdAt, updatedAt, surfaceKind, routeId, profileId, label},
 * required [id, createdAt, updatedAt, surfaceKind, profileId], and
 * additionalProperties:false. The store's `assignmentId` is projected to `id`,
 * and the daemon-internal `channelId` is dropped (it is forbidden by the
 * schema's additionalProperties:false).
 */
export interface RoutingRouteListItem {
  id: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  surfaceKind: string;
  routeId?: string;
  profileId: string;
  label?: string;
}

/**
 * Project a stored route to the SDK `channels.routing.list` item shape. Pure;
 * only includes optional `routeId`/`label` when present so the payload never
 * carries `undefined`-valued or schema-forbidden keys.
 */
export function toRouteListItem(route: RoutingChannelRoute): RoutingRouteListItem {
  const item: RoutingRouteListItem = {
    id: route.assignmentId,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
    surfaceKind: route.surfaceKind,
    profileId: route.profileId,
  };
  if (route.routeId !== undefined) {
    item.routeId = route.routeId;
  }
  if (route.label !== undefined) {
    item.label = route.label;
  }
  return item;
}

/** Parsed components of a composite channelId. */
export interface ParsedChannelId {
  surfaceKind: string;
  routeId?: string;
}

export interface RouteUpsertInput {
  channelId: string;
  profileId: string;
  label?: string;
}

export interface RouteUpsertResult {
  route: RoutingChannelRoute;
  created: boolean;
}

export interface RouteListFilter {
  profileId?: string;
  surfaceKind?: string;
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS routes (
    assignmentId TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    surfaceKind TEXT NOT NULL,
    routeId TEXT,
    profileId TEXT NOT NULL,
    label TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_routes_surface_route ON routes (surfaceKind, routeId)`,
  // Enforce one assignment per channel — the upsert path relies on this.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_channel ON routes (channelId)`,
];

interface RouteRow {
  assignmentId: string;
  channelId: string;
  surfaceKind: string;
  routeId: string | null;
  profileId: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Parse a composite channelId into its `surfaceKind` and optional `routeId`.
 *
 * The channelId format is `surfaceKind` (surface-only / wildcard) or
 * `surfaceKind:routeId`. Everything after the FIRST colon is the routeId, so
 * route IDs may themselves contain colons (e.g. `slack:C123:thread`).
 */
export function parseChannelId(channelId: string): ParsedChannelId {
  const raw = typeof channelId === 'string' ? channelId.trim() : '';
  if (raw.length === 0) {
    throw new HandlerError('channelId is required', 'ROUTING_INVALID_CHANNEL_ID', 400);
  }
  const separator = raw.indexOf(':');
  if (separator === -1) {
    return { surfaceKind: raw };
  }
  const surfaceKind = raw.slice(0, separator).trim();
  const routeId = raw.slice(separator + 1).trim();
  if (surfaceKind.length === 0) {
    throw new HandlerError('channelId is missing a surfaceKind', 'ROUTING_INVALID_CHANNEL_ID', 400);
  }
  // A trailing colon with no routeId collapses to a surface-only assignment.
  return routeId.length === 0 ? { surfaceKind } : { surfaceKind, routeId };
}

/** Build a canonical composite channelId from its parts. */
export function buildChannelId(surfaceKind: string, routeId?: string): string {
  return routeId === undefined || routeId === '' ? surfaceKind : `${surfaceKind}:${routeId}`;
}

function rowToRoute(row: RouteRow): RoutingChannelRoute {
  const route: RoutingChannelRoute = {
    assignmentId: row.assignmentId,
    channelId: row.channelId,
    surfaceKind: row.surfaceKind,
    profileId: row.profileId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.routeId !== null && row.routeId !== '') route.routeId = row.routeId;
  if (row.label !== null && row.label !== '') route.label = row.label;
  return route;
}

/**
 * SQLite-backed store for channel-to-profile routing assignments.
 *
 * Wraps {@link HandlerSqliteStore} (file `channel-routes.sqlite`) and persists
 * after every mutation. The store owns the composite-key parsing so callers only
 * ever deal with `channelId` strings.
 */
export class RouteStore {
  private readonly store: HandlerSqliteStore;
  private initialized = false;

  constructor(options: { workingDirectory: string }) {
    this.store = new HandlerSqliteStore({
      workingDirectory: options.workingDirectory,
      fileName: 'channel-routes.sqlite',
      schema: SCHEMA,
    });
  }

  get dbPath(): string {
    return this.store.dbPath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    this.initialized = true;
  }

  close(): void {
    this.store.close();
    this.initialized = false;
  }

  private requireInit(): void {
    if (!this.initialized) {
      throw new HandlerError('RouteStore not initialized', 'ROUTING_STORE_UNINITIALIZED', 500);
    }
  }

  /** All assignments, ordered most-recently-updated first. */
  listAll(): RoutingChannelRoute[] {
    this.requireInit();
    const rows = this.store.all<RouteRow>(
      `SELECT assignmentId, channelId, surfaceKind, routeId, profileId, label, createdAt, updatedAt
       FROM routes ORDER BY updatedAt DESC, assignmentId ASC`,
    );
    return rows.map(rowToRoute);
  }

  /** Assignments filtered by optional profileId and/or surfaceKind. */
  list(filter: RouteListFilter = {}): RoutingChannelRoute[] {
    this.requireInit();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.profileId !== undefined && filter.profileId !== '') {
      clauses.push('profileId = ?');
      params.push(filter.profileId);
    }
    if (filter.surfaceKind !== undefined && filter.surfaceKind !== '') {
      clauses.push('surfaceKind = ?');
      params.push(filter.surfaceKind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.store.all<RouteRow>(
      `SELECT assignmentId, channelId, surfaceKind, routeId, profileId, label, createdAt, updatedAt
       FROM routes ${where} ORDER BY updatedAt DESC, assignmentId ASC`,
      params,
    );
    return rows.map(rowToRoute);
  }

  /** Lookup a single assignment by its composite channelId. */
  findByChannelId(channelId: string): RoutingChannelRoute | null {
    this.requireInit();
    const row = this.store.get<RouteRow>(
      `SELECT assignmentId, channelId, surfaceKind, routeId, profileId, label, createdAt, updatedAt
       FROM routes WHERE channelId = ?`,
      [channelId],
    );
    return row ? rowToRoute(row) : null;
  }

  /** Lookup a single assignment by its assignmentId. */
  findById(assignmentId: string): RoutingChannelRoute | null {
    this.requireInit();
    const row = this.store.get<RouteRow>(
      `SELECT assignmentId, channelId, surfaceKind, routeId, profileId, label, createdAt, updatedAt
       FROM routes WHERE assignmentId = ?`,
      [assignmentId],
    );
    return row ? rowToRoute(row) : null;
  }

  /**
   * Create or update the assignment for a channel.
   *
   * `created` is true when no prior assignment existed for the channelId, false
   * when an existing row was updated. The assignmentId is stable across updates
   * (it is preserved from the existing row). Persists to disk after the write.
   */
  async upsert(input: RouteUpsertInput): Promise<RouteUpsertResult> {
    this.requireInit();
    const profileId = typeof input.profileId === 'string' ? input.profileId.trim() : '';
    if (profileId.length === 0) {
      throw new HandlerError('profileId is required', 'ROUTING_INVALID_PROFILE_ID', 400);
    }
    const { surfaceKind, routeId } = parseChannelId(input.channelId);
    const channelId = buildChannelId(surfaceKind, routeId);
    const label = typeof input.label === 'string' && input.label.trim().length > 0
      ? input.label.trim()
      : null;
    const now = new Date().toISOString();

    const existing = this.findByChannelId(channelId);
    if (existing) {
      this.store.run(
        `UPDATE routes
         SET profileId = ?, label = ?, surfaceKind = ?, routeId = ?, updatedAt = ?
         WHERE assignmentId = ?`,
        [profileId, label, surfaceKind, routeId ?? null, now, existing.assignmentId],
      );
      await this.store.save();
      const route = this.findById(existing.assignmentId);
      if (!route) {
        throw new HandlerError('Failed to read back updated route', 'ROUTING_WRITE_FAILED', 500);
      }
      return { route, created: false };
    }

    const assignmentId = randomUUID();
    this.store.run(
      `INSERT INTO routes
        (assignmentId, channelId, surfaceKind, routeId, profileId, label, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [assignmentId, channelId, surfaceKind, routeId ?? null, profileId, label, now, now],
    );
    await this.store.save();
    const route = this.findById(assignmentId);
    if (!route) {
      throw new HandlerError('Failed to read back inserted route', 'ROUTING_WRITE_FAILED', 500);
    }
    return { route, created: true };
  }

  /**
   * Delete an assignment by assignmentId. Returns true when a row was removed,
   * false when no matching assignment existed. Persists to disk after a delete.
   */
  async delete(assignmentId: string): Promise<boolean> {
    this.requireInit();
    const id = typeof assignmentId === 'string' ? assignmentId.trim() : '';
    if (id.length === 0) {
      throw new HandlerError('assignmentId is required', 'ROUTING_INVALID_ASSIGNMENT_ID', 400);
    }
    const existing = this.findById(id);
    if (!existing) return false;
    this.store.run('DELETE FROM routes WHERE assignmentId = ?', [id]);
    await this.store.save();
    return true;
  }
}

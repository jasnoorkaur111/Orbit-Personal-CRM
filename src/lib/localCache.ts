/**
 * Local-first cache for Orbit — IndexedDB-backed mirror of the user's
 * Supabase data. Powers instant boot + offline reads.
 *
 * Pattern:
 *   1. App boot: read everything from cache → render dashboard immediately
 *   2. In background: delta-sync against Supabase (only rows where
 *      updated_at > lastSyncedAt) → splice into both store + cache
 *   3. Mutations: write to Supabase first (source of truth), then mirror
 *      into cache on success
 *
 * Cache is keyed per user_id, indexed on each table, so multi-account
 * works (login → see only your rows; logout → cache stays for next login).
 */

import Dexie, { type Table } from 'dexie';

// Generic row shape — all Supabase tables have these.
type Row = { id?: string; user_id?: string; updated_at?: string };

class OrbitCacheDb extends Dexie {
  contacts!: Table<Row, string>;
  events!: Table<Row, string>;
  tasks!: Table<Row, string>;
  connections!: Table<Row, string>;
  projects!: Table<Row, string>;
  project_contacts!: Table<Row, string>;
  email_stats!: Table<Row & { contact_id: string }, string>;
  meta!: Table<{ user_id: string; lastSyncedAt: string }, string>;

  constructor() {
    // v3 — bumped again. v2's fresh fetches were ALSO incomplete: the
    // connections query in fetchAll hit Supabase's silent 1000-row default
    // limit, so users with >1000 edges (anyone active) got a random subset
    // and the network graph rendered with ~1 line. v3 forces another full
    // sync after the paginate() fix in useCrmStore — see [[fetchAll-pagination]].
    super('orbit-cache-v3');
    this.version(1).stores({
      // Indexes — Dexie syntax: '&primaryKey, index1, index2'
      contacts: '&id, user_id, updated_at',
      events: '&id, user_id, updated_at',
      tasks: '&id, contact_id, user_id, updated_at',
      connections: '&id, user_id, from_contact_id, to_contact_id, updated_at',
      projects: '&id, user_id, updated_at',
      project_contacts: '&id, user_id, project_id, contact_id',
      email_stats: '&contact_id, user_id, last_synced_at',
      meta: '&user_id',
    });
  }
}

const db = new OrbitCacheDb();

// ── Per-user scoped read/write helpers ──

/** Hydrate everything for a user from the cache. Returns null if cold cache. */
export async function loadCache(userId: string) {
  if (typeof window === 'undefined') return null;
  try {
    const [contacts, events, tasks, connections, projects, project_contacts, email_stats, metaRow] =
      await Promise.all([
        db.contacts.where('user_id').equals(userId).toArray(),
        db.events.where('user_id').equals(userId).toArray(),
        db.tasks.where('user_id').equals(userId).toArray(),
        db.connections.where('user_id').equals(userId).toArray(),
        db.projects.where('user_id').equals(userId).toArray(),
        db.project_contacts.where('user_id').equals(userId).toArray(),
        db.email_stats.where('user_id').equals(userId).toArray(),
        db.meta.get(userId),
      ]);
    if (contacts.length === 0) return null;        // cold cache → need full sync
    return {
      contacts,
      events,
      tasks,
      connections,
      projects,
      project_contacts,
      email_stats,
      lastSyncedAt: metaRow?.lastSyncedAt || null,
    };
  } catch (e) {
    console.warn('[localCache] read failed, falling back to network:', e);
    return null;
  }
}

/** Upsert a batch of rows into a cached table. Used by both full + delta sync paths. */
type TableName =
  | 'contacts' | 'events' | 'tasks' | 'connections'
  | 'projects' | 'project_contacts' | 'email_stats';

export async function upsertRows(table: TableName, rows: any[]) {
  if (typeof window === 'undefined' || !rows?.length) return;
  try {
    await (db as any)[table].bulkPut(rows);
  } catch (e) {
    console.warn(`[localCache] upsert ${table} failed:`, e);
  }
}

/** Replace the full cache for a user (used after a full sync). */
export async function saveCacheSnapshot(
  userId: string,
  snapshot: {
    contacts: any[];
    events: any[];
    tasks: any[];
    connections: any[];
    projects: any[];
    project_contacts: any[];
    email_stats: any[];
    lastSyncedAt: string;
  },
) {
  if (typeof window === 'undefined') return;
  try {
    await db.transaction(
      'rw',
      [db.contacts, db.events, db.tasks, db.connections, db.projects, db.project_contacts, db.email_stats, db.meta],
      async () => {
        // Wipe this user's rows from each table, then write fresh
        await Promise.all([
          db.contacts.where('user_id').equals(userId).delete(),
          db.events.where('user_id').equals(userId).delete(),
          db.tasks.where('user_id').equals(userId).delete(),
          db.connections.where('user_id').equals(userId).delete(),
          db.projects.where('user_id').equals(userId).delete(),
          db.project_contacts.where('user_id').equals(userId).delete(),
          db.email_stats.where('user_id').equals(userId).delete(),
        ]);
        if (snapshot.contacts.length) await db.contacts.bulkPut(snapshot.contacts);
        if (snapshot.events.length) await db.events.bulkPut(snapshot.events);
        if (snapshot.tasks.length) await db.tasks.bulkPut(snapshot.tasks);
        if (snapshot.connections.length) await db.connections.bulkPut(snapshot.connections);
        if (snapshot.projects.length) await db.projects.bulkPut(snapshot.projects);
        if (snapshot.project_contacts.length) await db.project_contacts.bulkPut(snapshot.project_contacts);
        if (snapshot.email_stats.length) await db.email_stats.bulkPut(snapshot.email_stats);
        await db.meta.put({ user_id: userId, lastSyncedAt: snapshot.lastSyncedAt });
      },
    );
  } catch (e) {
    console.warn('[localCache] saveSnapshot failed:', e);
  }
}

/** Update just the high-water-mark timestamp after a delta sync. */
export async function bumpLastSynced(userId: string, ts: string) {
  if (typeof window === 'undefined') return;
  try { await db.meta.put({ user_id: userId, lastSyncedAt: ts }); }
  catch (e) { console.warn('[localCache] bumpLastSynced failed:', e); }
}

/** Wipe all cache (e.g. after sign-out). */
export async function clearCache() {
  if (typeof window === 'undefined') return;
  try { await db.delete(); }
  catch (e) { console.warn('[localCache] clear failed:', e); }
}

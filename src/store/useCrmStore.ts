import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { loadCache, saveCacheSnapshot, upsertRows, bumpLastSynced, clearCache } from '@/lib/localCache';

// Dedupe concurrent fetchAll() calls — on first boot we get 4 cascaded
// invocations (cache delta + sync-graph + sync-email-stats + sync-calendar-pairs)
// and without this they all hit Supabase, re-render the store 4×, and
// produce a visible "double refresh" flash. With this, the second through
// fourth callers just await the same in-flight promise.
let inFlightFull: Promise<void> | null = null;
let inFlightDelta: Promise<void> | null = null;

export interface ContactResearch {
  confirmed: {
    name: string; role?: string; company?: string; location?: string;
    linkedinUrl?: string; photoUrl?: string; sourceUrl: string;
    rationale: string; confidence: 'high' | 'medium' | 'low';
  };
  signals: { text: string; category: 'professional' | 'interest' | 'recent' | 'mutual' | 'personal' | 'context'; source: string; sourceUrl: string }[];
  summary: string;
  prebrief: string;
  lastResearched: string;
}

export interface ContactSynthesis {
  relationship_type: string;
  tempo: string;
  common_topics: string[];
  cadence_signal: string | null;
  prebrief: string[];
  hooks: string[];
  approach: string | null;
  avoid: string | null;
  evidence_count: number;
  synthesized_at: string;
}

export interface Contact {
  id: string;
  name: string;
  company?: string;
  role?: string;
  email?: string;
  /** Additional emails that resolve to this contact (used for attendee/organizer matching + import dedup). */
  email_aliases?: string[] | null;
  phone?: string;
  linkedin?: string;
  photo?: string;
  is_direct?: boolean;
  is_self?: boolean;
  /** When false, contact is in the Discovered tray (auto-imported, no real signal yet). Hidden from Network/People by default. */
  is_promoted?: boolean;
  notes: string;
  color?: string;
  tags?: string[];
  last_contacted?: string;
  created_at: string;
  connections: string[];
  tasks: Task[];
  research?: ContactResearch | null;
  synthesis?: ContactSynthesis | null;
  synthesized_at?: string | null;
  email_stats?: EmailStats | null;
}

export interface EmailStats {
  emails_sent: number;
  emails_received: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_cc_names?: string[] | null;
  last_outbound_cc_names?: string[] | null;
  last_inbound_subject?: string | null;
  last_outbound_subject?: string | null;
  first_seen_at: string | null;
  thread_count: number;
  last_synced_at: string;
}

export interface Task {
  id: string;
  contact_id: string;
  title: string;
  description?: string;
  type: 'follow-up' | 'send' | 'meeting' | 'other';
  due_date?: string;
  completed: boolean;
  created_at: string;
  project_id?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  end_time?: string;
  contact_id?: string;
  description?: string;
  source: string;
  external_id?: string;
  project_id?: string;
  organizer_email?: string;
  attendees?: { name: string; email: string }[];
  enrichment?: {
    participants?: { name: string; evidence: string }[];
    event_type?: string;
    topic_tags?: string[];
    sentiment?: string;
    follow_up?: string | null;
  };
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  color?: string;
  status: 'active' | 'archived';
  created_at: string;
  contactIds: string[];
}

interface CrmState {
  contacts: Contact[];
  events: CalendarEvent[];
  projects: Project[];
  activeProjectFilter: string | null;
  selectedContactId: string | null;
  /** When set, the contact is mid-pop animation — graph node scales+fades,
   *  panel content dims, then the real delete fires. Cleared once the row is
   *  actually gone. Both delete entry points go through deleteWithPop. */
  pendingDeleteId: string | null;
  pendingDeleteStartedAt: number | null;
  loading: boolean;
  calendarSyncing: boolean;
  /** ISO timestamp of the high-water mark from the last successful fetch.
   *  Passed back into fetchAll({since}) by safeSync so we only hydrate rows
   *  that changed since then — keeps the graph from re-rendering everything
   *  every 15 min. Null on first load → full pull. */
  lastSyncedAt: string | null;

  fetchAll: (opts?: { since?: string }) => Promise<void>;
  /** Hydrate state from IndexedDB cache for instant boot. Returns true on
   *  cache hit (caller should follow up with fetchAll({since: lastSyncedAt})
   *  to pull deltas). Returns false on cold cache (caller should do full fetch). */
  bootFromCache: (userId: string) => Promise<boolean>;
  /** Clear the local IndexedDB cache (e.g. on sign-out). */
  clearLocalCache: () => Promise<void>;
  syncCalendar: () => Promise<void>;

  addContact: (contact: Partial<Contact>) => Promise<void>;
  updateContact: (id: string, updates: Partial<Contact>) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
  /** Animated delete: marks the contact as popping (graph + panel fade),
   *  waits ~280ms, then runs deleteContact + fetchAll. Use this from UI
   *  call sites; deleteContact is the bare DB op (used by mergeContacts etc.). */
  deleteWithPop: (id: string) => Promise<void>;
  mergeContacts: (keepId: string, mergeId: string) => Promise<void>;

  addTask: (task: Partial<Task>) => Promise<void>;
  updateTask: (taskId: string, updates: Partial<Task>) => Promise<void>;
  toggleTask: (taskId: string, completed: boolean) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;

  addConnection: (fromId: string, toId: string, source?: 'manual' | 'suggestion_accepted' | 'co_attended') => Promise<void>;
  removeConnection: (fromId: string, toId: string) => Promise<void>;

  addEvent: (event: Partial<CalendarEvent>) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;

  addProject: (project: Partial<Project>) => Promise<void>;
  updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  addContactToProject: (projectId: string, contactId: string) => Promise<void>;
  removeContactFromProject: (projectId: string, contactId: string) => Promise<void>;
  setActiveProjectFilter: (id: string | null) => void;

  setSelectedContact: (id: string | null) => void;
}

const COLORS = [
  '#6c63ff', '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4',
  '#feca57', '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3',
];

async function getUserId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export const useCrmStore = create<CrmState>((set, get) => ({
  contacts: [],
  events: [],
  projects: [],
  activeProjectFilter: null,
  selectedContactId: null,
  pendingDeleteId: null,
  pendingDeleteStartedAt: null,
  loading: true,
  calendarSyncing: false,
  lastSyncedAt: null,

  bootFromCache: async (userId: string) => {
    try {
      const cached = await loadCache(userId);
      if (!cached) return false;
      // Re-assemble the Contact shape (raw rows → nested arrays)
      const statsById = new Map<string, any>(cached.email_stats.map((s: any) => [s.contact_id, s]));
      const contacts: Contact[] = cached.contacts.map((c: any) => ({
        ...c,
        notes: c.notes || '',
        connections: cached.connections
          .filter((conn: any) => conn.from_contact_id === c.id)
          .map((conn: any) => conn.to_contact_id),
        tasks: cached.tasks.filter((t: any) => t.contact_id === c.id) as Task[],
        email_stats: statsById.get(c.id) ?? null,
      }));
      const projects: Project[] = cached.projects.map((p: any) => ({
        ...p,
        contactIds: cached.project_contacts
          .filter((pc: any) => pc.project_id === p.id)
          .map((pc: any) => pc.contact_id),
      }));
      set({
        contacts,
        events: cached.events as any,
        projects,
        loading: false,
        lastSyncedAt: cached.lastSyncedAt,
      });
      return true;
    } catch (e) {
      console.warn('bootFromCache failed:', e);
      return false;
    }
  },

  clearLocalCache: async () => {
    await clearCache();
  },

  fetchAll: async (opts) => {
    const isDelta = !!opts?.since;
    // Dedupe — if a fetch of the same kind is in flight, ride along.
    if (isDelta && inFlightDelta) return inFlightDelta;
    if (!isDelta && inFlightFull) return inFlightFull;

    const run = (async () => {
    if (!isDelta) set({ loading: true });

    try {
    // Date window for events (full mode only). Delta mode skips the date
    // filter and uses updated_at — anything edited recently is relevant
    // regardless of whether its date is past/future.
    const today = new Date();
    const sixMoBack = new Date(today); sixMoBack.setMonth(today.getMonth() - 6);
    const twelveMoForward = new Date(today); twelveMoForward.setFullYear(today.getFullYear() + 1);
    const fromDate = sixMoBack.toISOString().slice(0, 10);
    const toDate = twelveMoForward.toISOString().slice(0, 10);

    // Generic paginator — Supabase REST defaults to 1000 rows max per query.
    // Without this, users with > 1000 contacts/connections/tasks silently
    // get a random truncated subset. Most catastrophic for the connections
    // table — the graph renders with random missing edges because each
    // contact's connections array is built from whatever 1000 came back.
    const paginate = async (build: (q: any) => any, label: string): Promise<any[]> => {
      const pageSize = 1000;
      const collected: any[] = [];
      let from = 0;
      while (true) {
        const q = build(supabase.from(label).select('*'));
        const { data, error } = await q.range(from, from + pageSize - 1);
        if (error) { console.error(`[fetchAll] ${label} page ${from}/${pageSize} error:`, error); break; }
        if (!data || data.length === 0) break;
        collected.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
        if (from > 50_000) break;
      }
      return collected;
    };

    const fetchAllEvents = async () => {
      const pageSize = 1000;
      const collected: any[] = [];
      let from = 0;
      while (true) {
        let q = supabase.from('events').select('*');
        if (isDelta) {
          q = q.gt('updated_at', opts!.since!);
        } else {
          q = q.gte('date', fromDate).lte('date', toDate).order('date', { ascending: true });
        }
        const { data, error } = await q.range(from, from + pageSize - 1);
        if (error || !data || data.length === 0) break;
        collected.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
        if (from > 10_000) break;
      }
      return collected;
    };

    const sinceFilter = <T extends { gt: (col: string, val: string) => any }>(q: T) =>
      isDelta ? q.gt('updated_at', opts!.since!) : q;

    // Capture the high-water mark BEFORE the queries fire so we don't miss
    // rows written during the fetch on the next delta call.
    const nextHighWater = new Date().toISOString();

    // All tables paginate now — Supabase REST silently caps at 1000 rows per
    // query, and several tables (connections especially) already exceed that
    // for active users. Previously, only events was paginated, so contacts,
    // tasks, connections, etc. were getting randomly truncated subsets.
    let [
      contacts,
      connections,
      tasks,
      events,
      projects,
      projectContacts,
      emailStats,
    ]: any[] = await Promise.all([
      paginate(q => isDelta ? q.gt('updated_at', opts!.since!) : q.order('created_at', { ascending: false }), 'contacts'),
      paginate(q => isDelta ? q.gt('updated_at', opts!.since!) : q, 'connections'),
      paginate(q => isDelta ? q.gt('updated_at', opts!.since!) : q.order('created_at', { ascending: false }), 'tasks'),
      fetchAllEvents(),
      paginate(q => isDelta ? q.gt('updated_at', opts!.since!) : q.order('created_at', { ascending: false }), 'projects'),
      paginate(q => isDelta ? q.gt('updated_at', opts!.since!) : q, 'project_contacts'),
      paginate(q => isDelta ? q.gt('last_synced_at', opts!.since!) : q, 'email_stats'),
    ]);

    // Audit: surface row counts to console so future "where are my edges" panics
    // can be diagnosed in 5 seconds instead of by re-reading IndexedDB by hand.
    if (!isDelta) {
      console.log('[fetchAll] full sync counts:', {
        contacts: contacts.length,
        connections: connections.length,
        tasks: tasks.length,
        events: events.length,
        projects: projects.length,
        project_contacts: projectContacts.length,
        email_stats: emailStats.length,
      });
    }

    // ── Self-contact bootstrap for new users (full mode only) ──
    if (!isDelta) {
      const hasSelf = (contacts || []).some((c: any) => c.is_self);
      if (!hasSelf) {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (authUser) {
          const meta = (authUser.user_metadata as { full_name?: string; name?: string } | undefined) || {};
          const displayName =
            meta.full_name?.trim() ||
            meta.name?.trim() ||
            authUser.email?.split('@')[0] ||
            'You';
          const { data: created } = await supabase.from('contacts').insert({
            user_id: authUser.id,
            name: displayName,
            email: authUser.email ?? null,
            email_aliases: authUser.email ? [authUser.email] : [],
            is_self: true,
            is_promoted: true,
            is_direct: true,
            notes: '',
            tags: [],
            color: '#7c5cff',
            last_contacted: new Date().toISOString(),
          }).select().single();
          if (created) contacts = [created, ...(contacts || [])];
        }
      }
    }

    if (isDelta) {
      // ── Delta merge: splice the changed rows into existing state ──
      // We need ALL connections involving any contact that changed (incl. new
      // edges where the OTHER side changed) — so for affected contacts we
      // re-pull their full edge set. Cheaper than a full sync, but accurate.
      const prev = get();
      const deltaContactIds = new Set<string>((contacts || []).map((c: any) => c.id as string));
      const deltaProjectIds = new Set<string>((projects || []).map((p: any) => p.id as string));

      // Collect contact IDs touched by edge changes too — both endpoints need re-derivation
      for (const conn of connections || []) {
        deltaContactIds.add(conn.from_contact_id);
        deltaContactIds.add(conn.to_contact_id);
      }
      for (const ec of (events || []) as any[]) {
        if (ec.contact_id) deltaContactIds.add(ec.contact_id);
      }

      // For affected contacts, re-pull their complete connection list (any source)
      let freshEdgesForAffected: { from_contact_id: string; to_contact_id: string }[] = [];
      if (deltaContactIds.size > 0) {
        const ids = Array.from(deltaContactIds);
        const { data: re } = await supabase
          .from('connections')
          .select('from_contact_id, to_contact_id')
          .or(`from_contact_id.in.(${ids.join(',')}),to_contact_id.in.(${ids.join(',')})`);
        freshEdgesForAffected = re || [];
      }

      // Build email-stats overlay map from delta only
      const statsDelta = new Map<string, EmailStats>(
        (emailStats || []).map((s: any) => [s.contact_id, s as EmailStats])
      );

      // Build task-delta overlay grouped by contact_id
      const tasksDeltaByContact = new Map<string, Task[]>();
      for (const t of (tasks || []) as Task[]) {
        if (!t.contact_id) continue;
        let arr = tasksDeltaByContact.get(t.contact_id);
        if (!arr) { arr = []; tasksDeltaByContact.set(t.contact_id, arr); }
        arr.push(t);
      }

      // Re-pull projectContacts for affected projects so contactIds stays accurate
      let pcRows: { project_id: string; contact_id: string }[] = [];
      if (deltaProjectIds.size > 0) {
        const { data: pc } = await supabase
          .from('project_contacts')
          .select('project_id, contact_id')
          .in('project_id', Array.from(deltaProjectIds));
        pcRows = pc || [];
      }

      const mergedContactsById = new Map<string, Contact>(prev.contacts.map((c) => [c.id, c] as [string, Contact]));

      // Replace or add changed contacts (carry over existing computed fields by default)
      for (const c of (contacts || []) as any[]) {
        const existing = mergedContactsById.get(c.id);
        mergedContactsById.set(c.id, {
          ...(existing || ({ connections: [], tasks: [], email_stats: null } as Partial<Contact>)),
          ...c,
          notes: c.notes || '',
        } as Contact);
      }

      // Re-derive `connections` array for every affected contact
      for (const cid of deltaContactIds) {
        const c = mergedContactsById.get(cid);
        if (!c) continue;
        c.connections = freshEdgesForAffected
          .filter((e) => e.from_contact_id === cid)
          .map((e) => e.to_contact_id);
      }

      // Overlay email_stats deltas
      for (const [cid, s] of statsDelta) {
        const c = mergedContactsById.get(cid);
        if (c) c.email_stats = s;
      }

      // Overlay task deltas (replace tasks list for any contact whose task changed —
      // we only have the deltas, so re-pull that contact's full task list)
      const taskContactIds = Array.from(tasksDeltaByContact.keys());
      if (taskContactIds.length > 0) {
        const { data: fullTasks } = await supabase
          .from('tasks')
          .select('*')
          .in('contact_id', taskContactIds);
        const byContact = new Map<string, Task[]>();
        for (const t of (fullTasks || []) as Task[]) {
          if (!t.contact_id) continue;
          let arr = byContact.get(t.contact_id);
          if (!arr) { arr = []; byContact.set(t.contact_id, arr); }
          arr.push(t);
        }
        for (const [cid, arr] of byContact) {
          const c = mergedContactsById.get(cid);
          if (c) c.tasks = arr;
        }
      }

      const mergedContacts = Array.from(mergedContactsById.values());

      // Merge events by id
      const mergedEventsById = new Map<string, CalendarEvent>(prev.events.map((e) => [e.id, e] as [string, CalendarEvent]));
      for (const e of (events || []) as any[]) mergedEventsById.set(e.id, e as CalendarEvent);
      const mergedEvents = Array.from(mergedEventsById.values());

      // Merge projects + re-derive contactIds for affected projects
      const mergedProjectsById = new Map<string, Project>(prev.projects.map((p) => [p.id, p] as [string, Project]));
      for (const p of (projects || []) as any[]) {
        const existing = mergedProjectsById.get(p.id);
        mergedProjectsById.set(p.id, { ...(existing || { contactIds: [] }), ...p } as Project);
      }
      for (const pid of deltaProjectIds) {
        const p = mergedProjectsById.get(pid);
        if (!p) continue;
        p.contactIds = pcRows.filter((r) => r.project_id === pid).map((r) => r.contact_id);
      }
      const mergedProjects = Array.from(mergedProjectsById.values());

      set({
        contacts: mergedContacts,
        events: mergedEvents,
        projects: mergedProjects,
        lastSyncedAt: nextHighWater,
      });

      // Mirror delta rows into the IndexedDB cache so the next boot can
      // hydrate instantly (and the in-flight changes don't get re-fetched).
      const uid = await getUserId();
      if (uid) {
        await Promise.all([
          upsertRows('contacts', (contacts || []) as any[]),
          upsertRows('connections', (connections || []) as any[]),
          upsertRows('tasks', (tasks || []) as any[]),
          upsertRows('events', (events || []) as any[]),
          upsertRows('projects', (projects || []) as any[]),
          upsertRows('project_contacts', (projectContacts || []) as any[]),
          upsertRows('email_stats', (emailStats || []) as any[]),
        ]);
        await bumpLastSynced(uid, nextHighWater);
      }
      return;
    }

    const statsByContactId = new Map<string, EmailStats>(
      (emailStats || []).map((s: any) => [s.contact_id, s as EmailStats])
    );

    const assembled: Contact[] = (contacts || []).map((c: any) => ({
      ...c,
      notes: c.notes || '',
      connections: (connections || [])
        .filter((conn: any) => conn.from_contact_id === c.id)
        .map((conn: any) => conn.to_contact_id),
      tasks: (tasks || []).filter((t: any) => t.contact_id === c.id),
      email_stats: statsByContactId.get(c.id) ?? null,
    }));

    const assembledProjects: Project[] = (projects || []).map((p: any) => ({
      ...p,
      contactIds: (projectContacts || [])
        .filter((pc: any) => pc.project_id === p.id)
        .map((pc: any) => pc.contact_id),
    }));

    set({ contacts: assembled, events: events as any, projects: assembledProjects, loading: false, lastSyncedAt: nextHighWater });

    // Persist full snapshot to IndexedDB so next boot is instant.
    // Wipes + rewrites the user's rows in one transaction.
    const uidFull = await getUserId();
    if (uidFull) {
      await saveCacheSnapshot(uidFull, {
        contacts: (contacts || []) as any[],
        connections: (connections || []) as any[],
        tasks: (tasks || []) as any[],
        events: (events || []) as any[],
        projects: (projects || []) as any[],
        project_contacts: (projectContacts || []) as any[],
        email_stats: (emailStats || []) as any[],
        lastSyncedAt: nextHighWater,
      });
    }
    } catch (e) {
      console.error('fetchAll error:', e);
      if (!isDelta) set({ loading: false });
    }
    })();

    if (isDelta) inFlightDelta = run;
    else inFlightFull = run;
    try {
      await run;
    } finally {
      if (isDelta) inFlightDelta = null;
      else inFlightFull = null;
    }
  },

  syncCalendar: async () => {
    set({ calendarSyncing: true });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await fetch(`/api/sync-calendar?tz=${encodeURIComponent(tz)}`, {
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
      });
      await get().fetchAll();
    } finally {
      set({ calendarSyncing: false });
    }
  },

  addContact: async (contact) => {
    const userId = await getUserId();
    if (!userId) return;

    const color = COLORS[get().contacts.length % COLORS.length];
    // Manual add implies you just engaged with them — seed last_contacted so the recency
    // engine treats this row as fresh, not "Never contacted" alongside bulk-imported rows.
    const { data, error } = await supabase
      .from('contacts')
      .insert({
        name: contact.name,
        company: contact.company, role: contact.role,
        email: contact.email, phone: contact.phone, linkedin: contact.linkedin,
        notes: contact.notes || '', tags: contact.tags || [],
        is_direct: contact.is_direct !== false,
        // Manual / voice / explicit-import inserts are PROMOTED by default —
        // they came from a direct user action, not auto-discovery. Without
        // this, the DB default of `is_promoted = false` shoves them into the
        // Discovered tray, invisible on the People list and Graph.
        is_promoted: contact.is_promoted !== false,
        last_contacted: new Date().toISOString(),
        color, user_id: userId,
      })
      .select()
      .single();

    if (data && !error) {
      await get().fetchAll();
    }
  },

  updateContact: async (id, updates) => {
    const { connections, tasks, ...dbUpdates } = updates as any;
    await supabase.from('contacts').update(dbUpdates).eq('id', id);
    set((state) => ({
      contacts: state.contacts.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    }));
  },

  deleteContact: async (id) => {
    // Capture the row before we delete so we can roll back AND emit the
    // tombstone with the right email/name (see deleted_contacts upsert below).
    const target = get().contacts.find((c) => c.id === id);
    const prevContacts = get().contacts;
    const prevSelected = get().selectedContactId;

    // Optimistic UI: remove the contact AND scrub their id from every other
    // contact's .connections[] array so connection counts/booleans update
    // instantly (they're cached client-side from the connections table; the
    // DB cascade handles the rows but we'd otherwise overcount until the
    // next fetchAll). The pop animation is driven separately via
    // pendingDeleteId — clear it here since the row is now gone.
    set({
      contacts: prevContacts
        .filter((c) => c.id !== id)
        .map((c) => (c.connections?.includes(id)
          ? { ...c, connections: c.connections.filter((connId) => connId !== id) }
          : c)),
      selectedContactId: prevSelected === id ? null : prevSelected,
      pendingDeleteId: null,
      pendingDeleteStartedAt: null,
    });

    const { error } = await supabase.from('contacts').delete().eq('id', id);
    if (error) {
      // Roll back the optimistic update — the contact was NOT deleted.
      console.error('[deleteContact] supabase delete failed:', error);
      set({ contacts: prevContacts, selectedContactId: prevSelected });
      throw new Error(error.message || 'Delete failed');
    }

    // Tombstone so sync-graph doesn't re-import this contact from the
    // user's MS/Google social graph. AWAITED (not .then-handled) so a
    // safeSync that races in can't re-import before the tombstone lands.
    if (target?.email) {
      const userId = await getUserId();
      if (userId) {
        const { error: tombErr } = await supabase
          .from('deleted_contacts')
          .upsert(
            { user_id: userId, email: target.email.toLowerCase(), name: target.name || null, deleted_at: new Date().toISOString() },
            { onConflict: 'user_id,email' },
          );
        if (tombErr) console.warn('[deleteContact] tombstone upsert skipped:', tombErr.message);
      }
    }
  },

  deleteWithPop: async (id) => {
    // 1) Mark the contact as popping. NetworkGraph reads pendingDeleteId to
    //    scale + fade the canvas node; ContactPanel reads it to dim its content.
    // 2) Wait POP_MS so the animation can play.
    // 3) Run deleteContact (which clears pendingDeleteId in its set call).
    // 4) fetchAll() so the graph's force simulation and other panels resync.
    const POP_MS = 280;
    set({ pendingDeleteId: id, pendingDeleteStartedAt: Date.now() });
    await new Promise((r) => setTimeout(r, POP_MS));
    try {
      await get().deleteContact(id);
    } catch (e) {
      // Roll back the pending flag if the DB delete failed; deleteContact
      // already restored contacts/selectedContactId on error.
      set({ pendingDeleteId: null, pendingDeleteStartedAt: null });
      throw e;
    }
    await get().fetchAll({ since: get().lastSyncedAt || undefined });
  },

  mergeContacts: async (keepId, mergeId) => {
    // Delegate to the SQL merge_contact() function — it safely reparents events/tasks/
    // connections/projects/suggestions/dismissed_pairs, dedupes edges, preserves notes,
    // unions tags + email_aliases, and avoids unique-constraint collisions.
    await supabase.rpc('merge_contact', { p_canonical: keepId, p_loser: mergeId });
    await get().fetchAll();
    set({ selectedContactId: keepId });
  },

  addTask: async (task) => {
    const userId = await getUserId();
    if (!userId) return;

    const { error } = await supabase.from('tasks').insert({
      contact_id: task.contact_id,
      title: task.title,
      type: task.type || 'other',
      due_date: task.due_date || null,
      completed: false,
      project_id: task.project_id || null,
      user_id: userId,
    });
    if (!error) await get().fetchAll();
  },

  updateTask: async (taskId, updates) => {
    const { contact_id, id, created_at, ...dbUpdates } = updates as any;
    await supabase.from('tasks').update(dbUpdates).eq('id', taskId);
    set((state) => ({
      contacts: state.contacts.map((c) => ({
        ...c,
        tasks: c.tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
      })),
    }));
  },

  toggleTask: async (taskId, completed) => {
    await supabase.from('tasks').update({ completed }).eq('id', taskId);
    set((state) => ({
      contacts: state.contacts.map((c) => ({
        ...c,
        tasks: c.tasks.map((t) => (t.id === taskId ? { ...t, completed } : t)),
      })),
    }));
  },

  deleteTask: async (taskId) => {
    await supabase.from('tasks').delete().eq('id', taskId);
    set((state) => ({
      contacts: state.contacts.map((c) => ({
        ...c,
        tasks: c.tasks.filter((t) => t.id !== taskId),
      })),
    }));
  },

  addConnection: async (fromId, toId, source = 'manual') => {
    const userId = await getUserId();
    if (!userId) return;

    await supabase.from('connections').insert({ from_contact_id: fromId, to_contact_id: toId, user_id: userId, source });
    set((state) => ({
      contacts: state.contacts.map((c) =>
        c.id === fromId && !c.connections.includes(toId)
          ? { ...c, connections: [...c.connections, toId] }
          : c
      ),
    }));
  },

  removeConnection: async (fromId, toId) => {
    await supabase.from('connections').delete().match({ from_contact_id: fromId, to_contact_id: toId });
    set((state) => ({
      contacts: state.contacts.map((c) =>
        c.id === fromId ? { ...c, connections: c.connections.filter((id) => id !== toId) } : c
      ),
    }));
  },

  addEvent: async (event) => {
    const userId = await getUserId();
    if (!userId) return;

    await supabase.from('events').insert({
      title: event.title,
      date: event.date,
      time: event.time || null,
      contact_id: event.contact_id || null,
      description: event.description || null,
      source: event.source || 'manual',
      project_id: event.project_id || null,
      user_id: userId,
    });
    await get().fetchAll();
  },

  deleteEvent: async (id) => {
    await supabase.from('events').delete().eq('id', id);
    set((state) => ({ events: state.events.filter((e) => e.id !== id) }));
  },

  addProject: async (project) => {
    const userId = await getUserId();
    if (!userId) return;
    const color = COLORS[get().projects.length % COLORS.length];
    const { data, error } = await supabase
      .from('projects')
      .insert({ name: project.name, description: project.description || null, color: project.color || color, status: 'active', user_id: userId })
      .select()
      .single();
    if (data && !error) {
      set((state) => ({ projects: [{ ...data, contactIds: [] }, ...state.projects] }));
    }
  },

  updateProject: async (id, updates) => {
    const { contactIds, ...dbUpdates } = updates as any;
    await supabase.from('projects').update(dbUpdates).eq('id', id);
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    }));
  },

  deleteProject: async (id) => {
    await supabase.from('projects').delete().eq('id', id);
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      activeProjectFilter: state.activeProjectFilter === id ? null : state.activeProjectFilter,
    }));
  },

  addContactToProject: async (projectId, contactId) => {
    const userId = await getUserId();
    if (!userId) return;
    const { error } = await supabase.from('project_contacts').insert({ project_id: projectId, contact_id: contactId, user_id: userId });
    if (!error) {
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === projectId && !p.contactIds.includes(contactId)
            ? { ...p, contactIds: [...p.contactIds, contactId] }
            : p
        ),
      }));
    }
  },

  removeContactFromProject: async (projectId, contactId) => {
    await supabase.from('project_contacts').delete().match({ project_id: projectId, contact_id: contactId });
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, contactIds: p.contactIds.filter((id) => id !== contactId) } : p
      ),
    }));
  },

  setActiveProjectFilter: (id) => set({ activeProjectFilter: id }),

  setSelectedContact: (id) => set({ selectedContactId: id }),
}));

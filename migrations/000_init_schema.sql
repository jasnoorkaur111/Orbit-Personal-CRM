-- ============================================================================
-- Orbit — full database schema
-- ============================================================================
-- Run this once in the Supabase SQL editor (or via `supabase db push`) on a
-- fresh project. It creates every table the app needs and enables row-level
-- security so each authenticated user can only ever see and modify their own
-- rows. No seed data is included.
--
-- Auth is handled by Supabase Auth (auth.users). Every domain table carries a
-- user_id referencing auth.users(id); the RLS policies key off auth.uid().
-- ============================================================================

-- gen_random_uuid() is built into modern Postgres; ensure pgcrypto just in case.
create extension if not exists pgcrypto;

-- ── contacts ────────────────────────────────────────────────────────────────
create table if not exists public.contacts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  name            text not null,
  company         text,
  role            text,
  notes           text default '',
  color           text,
  email           text,
  email_aliases   text[] default '{}',          -- other emails that resolve to this contact
  phone           text,
  linkedin        text,
  photo           text,
  tags            text[] default '{}',
  is_direct       boolean default true,
  is_self         boolean not null default false, -- marks the user themselves; excluded from research/insights
  is_promoted     boolean not null default false, -- false = auto-discovered candidate, hidden until promoted
  research        jsonb,                          -- AI web-research intelligence
  synthesis       jsonb,                          -- behavioral relationship synthesis
  synthesized_at  timestamptz,
  last_contacted  timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── projects ────────────────────────────────────────────────────────────────
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  name        text not null,
  description text,
  color       text,
  status      text default 'active' check (status in ('active', 'archived')),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── connections (edges in the relationship graph) ────────────────────────────
create table if not exists public.connections (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  from_contact_id uuid references public.contacts(id) on delete cascade,
  to_contact_id   uuid references public.contacts(id) on delete cascade,
  source          text not null default 'manual'
                  check (source in ('manual','co_attended','cc_co_occurred','suggestion_accepted',
                                    'legacy_auto','legacy_manual','direct_email','direct_meeting')),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── tasks ────────────────────────────────────────────────────────────────────
create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  contact_id  uuid references public.contacts(id) on delete cascade,
  project_id  uuid references public.projects(id) on delete set null,
  title       text not null,
  description text,
  type        text default 'other' check (type in ('follow-up','send','meeting','other')),
  due_date    date,
  completed   boolean default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── events (calendar + manual) ───────────────────────────────────────────────
create table if not exists public.events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  contact_id      uuid references public.contacts(id) on delete cascade,
  project_id      uuid references public.projects(id) on delete set null,
  title           text not null,
  date            date not null,
  time            time,
  end_time        time,
  description     text,
  source          text default 'manual',
  external_id     text,
  attendees       jsonb,   -- [{name, email}] from iCal ATTENDEE
  organizer_email text,    -- ORGANIZER from iCal
  enrichment      jsonb,   -- LLM-derived structured fields
  enriched_at     timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── user_settings (one row per user) ─────────────────────────────────────────
create table if not exists public.user_settings (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null unique references auth.users(id) on delete cascade,
  google_calendar_url           text,
  outlook_calendar_url          text,
  google_access_token           text,
  google_refresh_token          text,
  microsoft_access_token        text,
  microsoft_refresh_token       text,
  microsoft_messages_delta_link text,
  imap_email                    text,
  imap_provider                 text,
  provider_display_name         text,
  timezone                      text,            -- IANA tz; null = device-detected
  onboarded_at                  timestamptz,
  brand_cleanup_v1_at           timestamptz,
  firm_tag_v1_at                timestamptz,
  created_at                    timestamptz default now(),
  updated_at                    timestamptz default now()
);

-- ── project_contacts (join) ──────────────────────────────────────────────────
create table if not exists public.project_contacts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── connection_suggestions ───────────────────────────────────────────────────
create table if not exists public.connection_suggestions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  from_contact_id uuid not null references public.contacts(id) on delete cascade,
  to_contact_id   uuid not null references public.contacts(id) on delete cascade,
  confidence      integer not null default 50,
  suggested_type  text,
  evidence_summary text,
  evidence_count  integer not null default 0,
  status          text not null default 'pending'
                  check (status in ('pending','accepted','rejected','snoozed')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);

-- ── dismissed_pairs (connection suggestions the user rejected) ────────────────
create table if not exists public.dismissed_pairs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  contact_a_id uuid not null references public.contacts(id) on delete cascade,
  contact_b_id uuid not null references public.contacts(id) on delete cascade,
  reason       text,
  dismissed_at timestamptz not null default now()
);

-- ── email_stats (per-contact email engagement) ───────────────────────────────
create table if not exists public.email_stats (
  contact_id             uuid primary key references public.contacts(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,
  emails_sent            integer not null default 0,
  emails_received        integer not null default 0,
  last_inbound_at        timestamptz,
  last_outbound_at       timestamptz,
  first_seen_at          timestamptz,
  thread_count           integer not null default 0,
  you_initiated          integer not null default 0,
  they_initiated         integer not null default 0,
  last_inbound_subject   text,
  last_outbound_subject  text,
  last_inbound_cc_names  text[] default '{}',
  last_outbound_cc_names text[] default '{}',
  last_synced_at         timestamptz not null default now()
);

-- ── merge_suggestions (AI-detected duplicate contacts) ────────────────────────
create table if not exists public.merge_suggestions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  canonical_id uuid not null references public.contacts(id) on delete cascade,
  duplicate_id uuid not null references public.contacts(id) on delete cascade,
  confidence   integer not null check (confidence >= 0 and confidence <= 100),
  reasoning    text not null,
  evidence     jsonb,
  status       text not null default 'pending'
               check (status in ('pending','accepted','rejected')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);

-- ── dismissed_merges (merge suggestions the user rejected) ────────────────────
create table if not exists public.dismissed_merges (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  contact_a_id uuid not null references public.contacts(id) on delete cascade,
  contact_b_id uuid not null references public.contacts(id) on delete cascade,
  dismissed_at timestamptz not null default now()
);

-- ── contact_notes_history (audit trail of notes edits) ────────────────────────
create table if not exists public.contact_notes_history (
  id         bigint generated by default as identity primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  old_notes  text,
  new_notes  text,
  old_length integer,
  new_length integer,
  changed_at timestamptz not null default now()
);

-- ── contact_merge_history (undoable merge log) ────────────────────────────────
create table if not exists public.contact_merge_history (
  id            bigint generated by default as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  canonical_id  uuid not null,
  canonical_name text,
  loser_id      uuid not null,
  loser_name    text,
  loser_row     jsonb not null,
  reparented    jsonb not null,
  merged_at     timestamptz not null default now(),
  undone        boolean not null default false,
  undone_at     timestamptz
);

-- ── deleted_contacts (tombstones to prevent re-import) ────────────────────────
create table if not exists public.deleted_contacts (
  user_id    uuid not null references auth.users(id) on delete cascade,
  email      text not null,
  name       text,
  deleted_at timestamptz not null default now(),
  primary key (user_id, email)
);

-- ── helpful indexes ───────────────────────────────────────────────────────────
create index if not exists idx_contacts_user            on public.contacts (user_id);
create index if not exists idx_contacts_research_last    on public.contacts ((research->>'lastResearched'));
create index if not exists idx_connections_user          on public.connections (user_id);
create index if not exists idx_events_user_date          on public.events (user_id, date);
create index if not exists idx_tasks_user                on public.tasks (user_id);
create index if not exists idx_email_stats_user          on public.email_stats (user_id);

-- ============================================================================
-- Row-level security: every table is owner-scoped via user_id = auth.uid()
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'contacts','projects','connections','tasks','events','user_settings',
    'project_contacts','connection_suggestions','dismissed_pairs','email_stats',
    'merge_suggestions','dismissed_merges','contact_notes_history',
    'contact_merge_history','deleted_contacts'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "Owner can do everything" on public.%I;', t);
    execute format(
      'create policy "Owner can do everything" on public.%I
         for all
         using (auth.uid() = user_id)
         with check (auth.uid() = user_id);', t);
  end loop;
end $$;

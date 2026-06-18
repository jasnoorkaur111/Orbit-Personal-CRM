# Orbit — Personal CRM

Orbit is an open-source, voice-first **personal CRM** built around an interactive
relationship graph. Instead of forms and spreadsheets, you talk (or type) about
the people you meet, and Orbit turns that into a living map of your network —
syncing your calendar and email, surfacing who you're drifting from, and using
AI to research contacts, suggest connections, and brief you before meetings.

> This is the open-source release of Orbit. It's fully self-hostable: bring your
> own Supabase project and AI keys and run the whole thing yourself.

## Features

- **Voice-first capture** — describe an interaction out loud; Orbit parses it into
  contacts, notes, tasks, and events.
- **Interactive network graph** — a 2D/3D force-directed map of your relationships.
- **Calendar + email sync** — Google and Microsoft (OAuth or public iCal), plus
  IMAP email-stats for engagement signals.
- **AI relationship intelligence** — contact research, behavioral synthesis,
  pre-meeting briefs, duplicate detection, and connection suggestions.
- **Smart contact hygiene** — auto-discovery with a Discovered tray, dedup/merge
  suggestions, and noise filtering for role/transactional inboxes.
- **Projects & tasks** — group contacts, track follow-ups, and never drop a thread.

## Tech stack

- [Next.js 16](https://nextjs.org) (App Router) + React 19 + TypeScript
- [Supabase](https://supabase.com) (Postgres + Auth + Row-Level Security)
- [Tailwind CSS](https://tailwindcss.com) + [Framer Motion](https://www.framer.com/motion/)
- [Zustand](https://github.com/pmndrs/zustand) for client state
- Google Gemini / Vertex AI and OpenAI for AI features
- `react-force-graph` + `three.js` for the network visualisations

## Getting started

### Prerequisites

- Node.js 20+ (22/24 recommended)
- A free [Supabase](https://supabase.com) project
- At least one AI key (Google Gemini or OpenAI) for the AI features
- *(Optional)* Google and/or Microsoft OAuth apps for calendar & contact sync

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/Orbit-Personal-CRM.git
cd Orbit-Personal-CRM
npm install
```

### 2. Set up the database

Create a Supabase project, then open the **SQL Editor** and run the contents of
[`migrations/000_init_schema.sql`](migrations/000_init_schema.sql). This creates
every table and enables row-level security so each user only ever sees their own
data.

### 3. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local`. The only hard requirements to boot are the **Supabase**
values and `NEXT_PUBLIC_APP_URL`. Add an AI key (Gemini or OpenAI) to enable the
AI features, and Google/Microsoft OAuth credentials to enable sync. See the
comments in [`.env.example`](.env.example) for where to find each value.

> **OAuth redirect URIs**
> - Google: `${NEXT_PUBLIC_APP_URL}/api/auth/google/callback`
> - Microsoft: `${NEXT_PUBLIC_APP_URL}/api/auth/microsoft/callback`

### 4. Run it

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), create an account, and walk
through onboarding.

## Deployment

Orbit deploys cleanly to [Vercel](https://vercel.com):

1. Push this repo to GitHub and import it in Vercel.
2. Add the same environment variables from `.env.local` to your Vercel project.
3. Set `NEXT_PUBLIC_APP_URL` to your production URL and update your OAuth redirect
   URIs to match.
4. Deploy.

Any platform that runs Next.js will work as well.

## Project structure

```
src/
  app/            Next.js App Router — pages and API routes
    api/          server routes: auth, sync, AI (parse-voice, research, …)
  components/     React UI (network graph, views, dialogs, onboarding)
  lib/            auth, Supabase client, AI helpers, dedup/scoring logic
  store/          Zustand store
migrations/       database schema (run 000_init_schema.sql on a fresh project)
public/           icons, manifest, service worker
```

## Contributing

Issues and pull requests are welcome. For larger changes, open an issue first to
discuss the direction.

## License

[MIT](LICENSE) © 2026 Jasnoor Kaur

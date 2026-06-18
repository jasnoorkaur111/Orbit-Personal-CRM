'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Check, X, LogOut, Pencil, AlertTriangle, Trash2, Info, ExternalLink } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { removeStorage } from '@/lib/storage';
import { useToastStore } from '@/components/Toast';
import { useCrmStore } from '@/store/useCrmStore';
import { useConfirm } from '@/components/ConfirmDialog';
import OrbitLogo from '@/components/OrbitLogo';

type Theme = 'light' | 'dark' | 'system';

interface MailCursor {
  newest_seen?: string;
  backfill_oldest?: string;
  backfill_done?: boolean;
  total_count?: number;
  scanned_total?: number;
}

// Section order = sidebar order = scroll order. id matches the section's
// DOM id which both the IntersectionObserver scroll-spy and the sidebar
// click handler rely on.
const SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'connections', label: 'Connections' },
  { id: 'mail', label: 'Mail history' },
  { id: 'calendar', label: 'Calendar URLs' },
  { id: 'imports', label: 'Imports' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'tags', label: 'Tags' },
  { id: 'danger', label: 'Danger zone' },
] as const;

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]"><span className="text-[var(--text-secondary)]">Loading…</span></div>}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  const [googleUrl, setGoogleUrl] = useState('');
  const [outlookUrl, setOutlookUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);

  const [importing, setImporting] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);

  const [googleConnected, setGoogleConnected] = useState(false);
  const [microsoftConnected, setMicrosoftConnected] = useState(false);

  const [mailCursor, setMailCursor] = useState<MailCursor | null>(null);

  const initialName =
    ((user?.user_metadata as { full_name?: string; name?: string } | undefined)?.full_name) ||
    ((user?.user_metadata as { full_name?: string; name?: string } | undefined)?.name) || '';
  const [displayName, setDisplayName] = useState(initialName);
  const [editingName, setEditingName] = useState(false);
  const [nameSaving, setNameSaving] = useState(false);
  useEffect(() => { if (initialName && !displayName) setDisplayName(initialName); }, [initialName]); // eslint-disable-line react-hooks/exhaustive-deps

  const detectedTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'America/Detroit';
  const [timezone, setTimezone] = useState<string>('');
  const [resyncing, setResyncing] = useState(false);

  const [showCalendarHelp, setShowCalendarHelp] = useState(false);
  const [showImportsHelp, setShowImportsHelp] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    try {
      const t = (localStorage.getItem('crm-theme') || 'dark') as Theme;
      setTheme(t === 'system' ? 'system' : t);
    } catch {}
  }, []);

  const applyTheme = (t: Theme) => {
    setTheme(t);
    try { localStorage.setItem('crm-theme', t); } catch {}
    const resolved = t === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : t;
    document.documentElement.setAttribute('data-theme', resolved);
  };

  // ── Scroll-spy: which section is "active" right now ────────────────
  // Plain scroll listener instead of IntersectionObserver — IO fights with
  // conditional sections (Mail panel only renders when MS is connected, so
  // it's missing at mount time and the once-attached observer never picks
  // it up). A scroll handler reads the live DOM each tick.
  //
  // Algorithm: walk sections top-to-bottom, pick the LAST one whose top has
  // crossed the trigger line (header + breathing room). That section is
  // "the one I've most recently scrolled into."
  const [activeSection, setActiveSection] = useState<string>('account');
  const scrollLockedRef = useRef(false);
  useEffect(() => {
    if (loadingSettings) return;
    const TRIGGER_OFFSET = 140; // ~header height + a bit of room
    const updateActive = () => {
      if (scrollLockedRef.current) return;
      let current: string = SECTIONS[0].id;
      for (const { id } of SECTIONS) {
        const el = document.getElementById(id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top - TRIGGER_OFFSET <= 0) current = id;
      }
      setActiveSection((prev) => (prev === current ? prev : current));
    };
    updateActive();
    window.addEventListener('scroll', updateActive, { passive: true });
    window.addEventListener('resize', updateActive);
    return () => {
      window.removeEventListener('scroll', updateActive);
      window.removeEventListener('resize', updateActive);
    };
  }, [loadingSettings, microsoftConnected]);

  const jumpToSection = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setActiveSection(id);
    // Lock the observer for a beat so the smooth-scroll doesn't get overwritten
    // by intermediate sections crossing the trigger band.
    scrollLockedRef.current = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => { scrollLockedRef.current = false; }, 700);
  };

  useEffect(() => { if (!loading && !user) router.push('/login'); }, [user, loading, router]);
  useEffect(() => { if (user) loadSettings(); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Dispatch a global event so the rest of the app's providers state
    // (page.tsx's providersInfo) refetches without a full reload. Without
    // this, connecting MS or Google in Settings then navigating back to
    // Home via the sidebar (SPA nav) leaves providersInfo stale and the
    // banner keeps showing the "Connect" CTA.
    const fireProvidersChanged = () => window.dispatchEvent(new CustomEvent('orbit:providers-changed'));
    if (searchParams.get('google') === 'connected') { addToast({ message: 'Google connected', type: 'success', icon: 'contact' }); setGoogleConnected(true); fireProvidersChanged(); }
    if (searchParams.get('microsoft') === 'connected') { addToast({ message: 'Microsoft connected', type: 'success', icon: 'contact' }); setMicrosoftConnected(true); fireProvidersChanged(); }
    if (searchParams.get('error')) addToast({ message: `Connection failed: ${searchParams.get('error')}`, type: 'error' });
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSettings = async () => {
    const { data } = await supabase.from('user_settings').select('*').eq('user_id', user!.id).maybeSingle();
    if (data) {
      setGoogleUrl(data.google_calendar_url || '');
      setOutlookUrl(data.outlook_calendar_url || '');
      setGoogleConnected(!!data.google_access_token);
      setMicrosoftConnected(!!data.microsoft_access_token);
      setTimezone(data.timezone || '');
      if (data.microsoft_messages_delta_link) {
        try { setMailCursor(JSON.parse(data.microsoft_messages_delta_link)); } catch { setMailCursor(null); }
      }
    }
    setLoadingSettings(false);
  };

  const handleSaveTimezone = async (newTz: string) => {
    if (!user) return;
    setTimezone(newTz);
    await supabase.from('user_settings').upsert({ user_id: user.id, timezone: newTz || null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    addToast({ message: newTz ? `Timezone set to ${newTz}` : `Using device timezone (${detectedTz})`, type: 'success', icon: 'calendar' });
  };

  const handleResync = async () => {
    if (!user) return;
    setResyncing(true);
    try { await useCrmStore.getState().syncCalendar(); addToast({ message: 'Calendar resynced', type: 'success', icon: 'calendar' }); }
    catch { addToast({ message: 'Sync failed', type: 'error' }); }
    setResyncing(false);
  };

  const handleSaveCalendarUrls = async () => {
    if (!user) return;
    setSaving(true);
    await supabase.from('user_settings').upsert({ user_id: user.id, google_calendar_url: googleUrl || null, outlook_calendar_url: outlookUrl || null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    setSaving(false); setSaved(true);
    addToast({ message: 'Calendar settings saved', type: 'success', icon: 'calendar' });
    setTimeout(() => setSaved(false), 3000);
  };

  const handleLinkedInCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setImporting('linkedin'); setImportResult(null);
    try {
      const formData = new FormData(); formData.append('file', file);
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/import/linkedin-csv', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token || ''}` },
        body: formData,
      });
      const data = await res.json();
      if (data.error) addToast({ message: data.error, type: 'error' });
      else { setImportResult(data); addToast({ message: `Imported ${data.imported} from LinkedIn`, type: 'success', icon: 'contact' }); }
    } catch { addToast({ message: 'Import failed', type: 'error' }); }
    setImporting(null); e.target.value = '';
  };

  const saveDisplayName = async () => {
    const name = displayName.trim();
    if (!name || !user) return;
    setNameSaving(true);
    try {
      await supabase.auth.updateUser({ data: { full_name: name } });
      await supabase.from('contacts').update({ name }).eq('user_id', user.id).eq('is_self', true);
      await useCrmStore.getState().fetchAll();
      addToast({ message: 'Name updated', type: 'success', icon: 'contact' });
      setEditingName(false);
    } catch (e: any) {
      addToast({ message: `Save failed: ${e?.message || String(e)}`, type: 'error' });
    } finally { setNameSaving(false); }
  };

  const handleDisconnect = async (provider: 'google' | 'microsoft') => {
    if (!user) return;
    const label = provider === 'google' ? 'Google' : 'Microsoft';
    const ok = await confirm({
      title: `Disconnect ${label}?`,
      description: `Your existing data stays. We stop pulling new ${provider === 'google' ? 'calendar and contacts' : 'calendar, contacts, and mail'} until you reconnect.`,
      confirmLabel: 'Disconnect',
      destructive: true,
    });
    if (!ok) return;
    const patch: Record<string, null | string> = provider === 'google'
      ? { google_access_token: null, google_refresh_token: null, updated_at: new Date().toISOString() }
      : { microsoft_access_token: null, microsoft_refresh_token: null, microsoft_messages_delta_link: null, updated_at: new Date().toISOString() };
    await supabase.from('user_settings').upsert({ user_id: user.id, ...patch }, { onConflict: 'user_id' });
    if (provider === 'google') setGoogleConnected(false);
    else { setMicrosoftConnected(false); setMailCursor(null); }
    // Let other views refetch providersInfo so banners/CTAs flip
    // immediately instead of waiting for a reload.
    window.dispatchEvent(new CustomEvent('orbit:providers-changed'));
    addToast({ message: `${label} disconnected`, type: 'info' });
  };

  const handleDeleteAccount = async () => {
    if (!user) return;
    const email = (user.email || '').toLowerCase();
    const typed = window.prompt(`Type your email (${email}) to permanently delete your account.\n\nThis removes every contact, event, task, note, and connection. It cannot be undone.`);
    if (!typed) return;
    if (typed.trim().toLowerCase() !== email) {
      addToast({ message: 'Email did not match. Deletion cancelled.', type: 'error' });
      return;
    }
    const ok = await confirm({
      title: 'Last chance. Delete account?',
      description: 'This is permanent. All your data is removed in seconds and we cannot recover it.',
      confirmLabel: 'Delete forever',
      destructive: true,
    });
    if (!ok) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmEmail: email }),
      });
      const j = await r.json();
      if (!r.ok) { addToast({ message: j.error || 'Deletion failed', type: 'error' }); return; }
      await signOut(); router.push('/login');
    } catch (e: any) {
      addToast({ message: `Deletion failed: ${e?.message || String(e)}`, type: 'error' });
    }
  };

  const handleSignOut = async () => { await signOut(); router.push('/login'); };

  if (loading || !user) {
    return <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]"><motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity }} className="text-[var(--text-secondary)]">Loading…</motion.div></div>;
  }

  const { contacts } = useCrmStore.getState();
  const totalTags = [...new Set(contacts.flatMap((c) => c.tags || []))].length;

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {/* Header */}
      <div className="border-b border-[var(--border)] bg-[var(--bg-surface)] sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/')} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              <ArrowLeft size={16} />
            </button>
            <div className="flex items-center gap-2">
              <OrbitLogo size={13} className="text-[var(--text-primary)]" />
              <h1 className="text-[14px] font-semibold tracking-tight">Settings</h1>
            </div>
          </div>
          <button onClick={handleSignOut} className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5">
            <LogOut size={12} /> Sign out
          </button>
        </div>
      </div>

      {/* Layout: main content centered, sidebar floats fixed to the left
          and tracks the active section's y-position (see SidebarFollow). */}
      <div className="max-w-5xl mx-auto px-6 flex gap-12 items-start">
        {/* Spacer that reserves the gutter width on lg+ so main stays
            offset from the floating sidebar. */}
        <div className="hidden lg:block w-44 shrink-0" />

        <SidebarFollow active={activeSection} onSelect={jumpToSection} />

        {/* Main content */}
        <main className="flex-1 min-w-0 max-w-2xl">

          {/* ── Account ──────────────────────────────────────────── */}
          <Section id="account" title="Account" onActivate={jumpToSection} active={activeSection === 'account'}>
            <Row label="Name">
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveDisplayName(); if (e.key === 'Escape') { setDisplayName(initialName); setEditingName(false); } }}
                    autoFocus
                    className="text-[13px] bg-transparent border-b border-[var(--text-primary)] focus:outline-none w-48 text-right"
                  />
                  <button onClick={saveDisplayName} disabled={nameSaving} className="text-[var(--accent)] disabled:opacity-40">
                    {nameSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  </button>
                  <button onClick={() => { setDisplayName(initialName); setEditingName(false); }} className="text-[var(--text-secondary)]"><X size={12} /></button>
                </div>
              ) : (
                <button onClick={() => setEditingName(true)} className="flex items-center gap-1.5 text-[13px] text-[var(--text-primary)] group">
                  <span>{displayName || 'Add your name'}</span>
                  <Pencil size={10} className="text-[var(--text-secondary)]/30 group-hover:text-[var(--accent)] transition-colors" />
                </button>
              )}
            </Row>
            <Row label="Email"><span className="text-[13px] text-[var(--text-secondary)]">{user.email}</span></Row>
            <Row label="Contacts"><span className="text-[13px] tabular-nums">{contacts.length.toLocaleString()}</span></Row>
            <Row label="Tags"><span className="text-[13px] tabular-nums">{totalTags}</span></Row>
          </Section>

          {/* ── Connected accounts ───────────────────────────────── */}
          <Section id="connections" title="Connected accounts" onActivate={jumpToSection} active={activeSection === 'connections'}>
            <ProviderRow label="Microsoft" sub="Outlook calendar, people, mail" connected={microsoftConnected} connectHref={`/api/auth/microsoft?user_id=${user.id}`} onDisconnect={() => handleDisconnect('microsoft')} />
            <ProviderRow label="Google" sub="Calendar, contacts" connected={googleConnected} connectHref={`/api/auth/google?user_id=${user.id}`} onDisconnect={() => handleDisconnect('google')} />
          </Section>

          {/* ── Mail indexing ────────────────────────────────────── */}
          {microsoftConnected && (
            <Section id="mail" title="Mail history" subtitle="Lifetime scan of your Outlook mailbox" onActivate={jumpToSection} active={activeSection === 'mail'}>
              <MailBackfillView cursor={mailCursor} />
            </Section>
          )}

          {/* ── Calendar URLs ────────────────────────────────────── */}
          <Section
            id="calendar"
            title="Calendar URLs (iCal)"
            subtitle="Fallback if OAuth isn't connected"
            onActivate={jumpToSection} active={activeSection === 'calendar'}
            headerExtra={
              <button
                onClick={() => setShowCalendarHelp((s) => !s)}
                className={`w-4 h-4 rounded-full flex items-center justify-center transition-colors ${
                  showCalendarHelp
                    ? 'bg-[var(--text-primary)]/12 text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]/50 hover:text-[var(--text-primary)] hover:bg-[var(--text-primary)]/8'
                }`}
                aria-label="Show setup instructions"
              >
                <Info size={10} />
              </button>
            }
          >
            {showCalendarHelp && (
              <SetupGuidePanel
                intro="Use these if OAuth sign-in is blocked by your org. Both providers give you a secret iCal/ICS URL you can paste here."
                providers={CALENDAR_PROVIDERS}
                onClose={() => setShowCalendarHelp(false)}
              />
            )}
            <Row label="Google">
              <input type="url" value={googleUrl} onChange={(e) => setGoogleUrl(e.target.value)} placeholder="https://…"
                className="w-60 text-right text-[12.5px] bg-transparent border-b border-[var(--border)] focus:outline-none focus:border-[var(--text-primary)]/40 transition-colors placeholder:text-[var(--text-secondary)]/30" />
            </Row>
            <Row label="Outlook">
              <input type="url" value={outlookUrl} onChange={(e) => setOutlookUrl(e.target.value)} placeholder="https://…"
                className="w-60 text-right text-[12.5px] bg-transparent border-b border-[var(--border)] focus:outline-none focus:border-[var(--text-primary)]/40 transition-colors placeholder:text-[var(--text-secondary)]/30" />
            </Row>
            <div className="pt-2 flex justify-end">
              <button onClick={handleSaveCalendarUrls} disabled={saving || loadingSettings}
                className="text-[12.5px] px-3 py-1 rounded-md border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-50">
                {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
              </button>
            </div>
          </Section>

          {/* ── Imports ──────────────────────────────────────────── */}
          <Section
            id="imports"
            title="Imports"
            onActivate={jumpToSection} active={activeSection === 'imports'}
            headerExtra={
              <button
                onClick={() => setShowImportsHelp((s) => !s)}
                className={`w-4 h-4 rounded-full flex items-center justify-center transition-colors ${
                  showImportsHelp
                    ? 'bg-[var(--text-primary)]/12 text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]/50 hover:text-[var(--text-primary)] hover:bg-[var(--text-primary)]/8'
                }`}
                aria-label="Show import instructions"
              >
                <Info size={10} />
              </button>
            }
          >
            {showImportsHelp && (
              <SetupGuidePanel
                intro="LinkedIn doesn't ship a one-click export — you have to request your data archive first. Takes about 10 minutes end-to-end."
                providers={IMPORT_PROVIDERS}
                onClose={() => setShowImportsHelp(false)}
              />
            )}
            <Row label="LinkedIn CSV">
              <label className={`text-[12.5px] cursor-pointer transition-colors ${importing === 'linkedin' ? 'text-[var(--text-secondary)]/50' : 'text-[var(--accent)] hover:underline'}`}>
                {importing === 'linkedin' ? 'Uploading…' : 'Upload →'}
                <input type="file" accept=".csv" onChange={handleLinkedInCSV} className="hidden" />
              </label>
            </Row>
            {importResult && <p className="text-[11px] text-[var(--text-secondary)]">Imported {importResult.imported}. Skipped {importResult.skipped}.</p>}
          </Section>

          {/* ── Appearance ───────────────────────────────────────── */}
          <Section id="appearance" title="Appearance" onActivate={jumpToSection} active={activeSection === 'appearance'}>
            <Row label="Theme">
              <div className="inline-flex border border-[var(--border)] rounded-md overflow-hidden">
                {(['light', 'dark', 'system'] as const).map((t) => (
                  <button key={t} onClick={() => applyTheme(t)}
                    className={`text-[11.5px] px-3 py-1 transition-colors ${theme === t ? 'bg-[var(--accent)]/12 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </Row>
          </Section>

          {/* ── Preferences ──────────────────────────────────────── */}
          <Section id="preferences" title="Preferences" onActivate={jumpToSection} active={activeSection === 'preferences'}>
            <Row label="Timezone">
              <select value={timezone} onChange={(e) => handleSaveTimezone(e.target.value)}
                className="text-[12.5px] bg-transparent border border-[var(--border)] rounded-md px-2 py-1 focus:outline-none focus:border-[var(--text-primary)]/40 transition-colors max-w-[16rem]">
                <option value="">Device ({detectedTz})</option>
                <option disabled>──────────</option>
                {['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Detroit',
                  'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo',
                  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Athens', 'Europe/Moscow',
                  'Africa/Cairo', 'Africa/Johannesburg',
                  'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
                  'Australia/Sydney', 'Pacific/Auckland', 'UTC',
                ].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </Row>
            <Row label="">
              <button onClick={handleResync} disabled={resyncing} className="text-[12px] text-[var(--accent)]/80 hover:text-[var(--accent)] disabled:opacity-50">
                {resyncing ? 'Resyncing…' : 'Resync calendar →'}
              </button>
            </Row>
            <Row label="">
              <button onClick={() => { if (user) { removeStorage(`crm-onboarded-${user.id}`); router.push('/'); } }}
                className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                Walk through onboarding again →
              </button>
            </Row>
          </Section>

          {/* ── Tags ─────────────────────────────────────────────── */}
          <TagsSection onActivate={jumpToSection} active={activeSection === 'tags'} />

          {/* ── Danger zone (distinct treatment) ─────────────────── */}
          <DangerZone id="danger" onActivate={jumpToSection} active={activeSection === 'danger'} onDelete={handleDeleteAccount} />

          {/* Big bottom spacer so the LAST section (Danger zone) can scroll
              all the way to the top of the viewport. Without this, the page
              "runs out" before the last section reaches the trigger line. */}
          <div className="h-[70vh]" />
        </main>
      </div>
    </div>
  );
}

// ─── Sidebar (glass-morphic floating nav) ─────────────────────────────

// ─── Sidebar that follows the active section's y-position ────────────
// Fixed positioning so it can free-float; top updated via a ref + RAF on
// scroll so it tracks the section the user is reading without going
// through React state on every pixel. CSS transition smooths the moves.
function SidebarFollow({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const node = ref.current;
      if (!node) return;
      const sec = document.getElementById(active);
      if (!sec) return;
      const rect = sec.getBoundingClientRect();
      const minTop = 80;                                  // below the header
      const maxTop = Math.max(minTop, window.innerHeight - node.offsetHeight - 24);
      const target = Math.max(minTop, Math.min(maxTop, rect.top + 12));
      node.style.top = `${target}px`;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active]);

  return (
    <div
      ref={ref}
      className="hidden lg:block fixed w-44 z-10 transition-[top] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{
        top: '80px',
        left: 'max(1.5rem, calc(50vw - 32rem))',
      }}
    >
      <SettingsSidebar active={active} onSelect={onSelect} />
    </div>
  );
}

function SettingsSidebar({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  // Hide Tags from the nav (deep-level config, doesn't deserve its own jump
  // target). The section still scrolls into view naturally as the user
  // moves past Preferences.
  const visible = SECTIONS.filter((s) => s.id !== 'tags');
  return (
    <nav
      className="rounded-xl p-2.5"
      style={{
        background: 'color-mix(in srgb, var(--bg-surface) 60%, transparent)',
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)',
        boxShadow: '0 8px 28px color-mix(in srgb, var(--text-primary) 6%, transparent)',
      }}
    >
      <div className="text-[9.5px] uppercase tracking-[0.16em] text-[var(--text-secondary)]/60 px-2 py-1.5">
        Settings
      </div>
      <ul className="space-y-0.5">
        {visible.map(({ id, label }) => {
          const isActive = active === id;
          const isDanger = id === 'danger';
          // Active accent uses --text-primary (white in dark, black in light)
          // for the bar + tint, instead of the lavender accent. Keeps the
          // sidebar feeling like neutral chrome rather than a marketing pill.
          return (
            <li key={id}>
              <button
                onClick={() => onSelect(id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-all duration-200 group"
                style={{
                  color: isActive
                    ? (isDanger ? 'var(--danger, #ef4444)' : 'var(--text-primary)')
                    : 'color-mix(in srgb, var(--text-secondary) 75%, transparent)',
                  background: isActive
                    ? (isDanger
                      ? 'color-mix(in srgb, var(--danger, #ef4444) 10%, transparent)'
                      : 'color-mix(in srgb, var(--text-primary) 8%, transparent)')
                    : 'transparent',
                }}
              >
                <span
                  className="w-1 h-3.5 rounded-full transition-all duration-200"
                  style={{
                    background: isActive
                      ? (isDanger ? 'var(--danger, #ef4444)' : 'var(--text-primary)')
                      : 'transparent',
                  }}
                />
                <span className="text-[11.5px] font-medium">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─── Generic setup guide panel (toggled by Info chips) ───────────────

interface GuideProvider {
  label: string;
  href: string;
  cta: string;
  steps: string[];
}

function SetupGuidePanel({ intro, providers, onClose }: { intro: string; providers: GuideProvider[]; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4, height: 0 }}
      animate={{ opacity: 1, y: 0, height: 'auto' }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden mb-4"
    >
      <div
        className="rounded-xl p-4 space-y-4"
        style={{
          background: 'color-mix(in srgb, var(--bg-surface) 70%, transparent)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid color-mix(in srgb, var(--accent) 18%, transparent)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11.5px] text-[var(--text-secondary)] leading-relaxed">{intro}</p>
          <button onClick={onClose} className="text-[var(--text-secondary)]/60 hover:text-[var(--text-primary)] shrink-0">
            <X size={11} />
          </button>
        </div>

        {providers.map((g) => (
          <div key={g.label} className="space-y-2.5">
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-secondary)]/70">{g.label}</div>
            <a
              href={g.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 px-3 py-2 rounded-md text-[11.5px] font-medium transition-colors"
              style={{
                background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                color: 'var(--accent)',
                border: '1px solid color-mix(in srgb, var(--accent) 22%, transparent)',
              }}
            >
              <span>{g.cta}</span>
              <ExternalLink size={11} />
            </a>
            <ol className="space-y-1.5 pl-0.5">
              {g.steps.map((step, i) => (
                <li key={i} className="flex items-start gap-2.5 text-[11.5px] text-[var(--text-secondary)] leading-relaxed">
                  <span
                    className="flex-shrink-0 w-4 h-4 rounded-full text-[9px] font-semibold flex items-center justify-center mt-0.5"
                    style={{
                      background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

const CALENDAR_PROVIDERS: GuideProvider[] = [
  {
    label: 'Google Calendar',
    href: 'https://calendar.google.com/calendar/u/0/r/settings',
    cta: 'Open Google Calendar settings',
    steps: [
      'Open Google Calendar settings (button above).',
      'In the left sidebar, click the calendar you want to share.',
      'Scroll to "Integrate calendar" and copy the "Secret address in iCal format".',
      'Paste the URL into the Google field below.',
    ],
  },
  {
    label: 'Outlook Calendar',
    href: 'https://outlook.office.com/calendar/options/calendar/sharedCalendars',
    cta: 'Open Outlook Calendar settings',
    steps: [
      'Open Outlook Calendar settings (button above).',
      'Go to "Shared calendars" → "Publish a calendar".',
      'Pick your calendar, click Publish, then copy the ICS link.',
      'Paste the URL into the Outlook field below.',
    ],
  },
];

const IMPORT_PROVIDERS: GuideProvider[] = [
  {
    label: 'LinkedIn Connections',
    href: 'https://www.linkedin.com/mypreferences/d/download-my-data',
    cta: 'Open LinkedIn data export',
    steps: [
      'Open LinkedIn data export (button above).',
      'Choose "Want something in particular?" and tick only "Connections".',
      'Click "Request archive" — LinkedIn emails you a download link in 10 minutes.',
      'Download the ZIP, extract it, and upload Connections.csv below.',
    ],
  },
];

// ─── Primitives ──────────────────────────────────────────────────────

function Section({ id, title, subtitle, active, headerExtra, onActivate, children }: { id: string; title: string; subtitle?: string; active: boolean; headerExtra?: React.ReactNode; onActivate?: (id: string) => void; children: React.ReactNode }) {
  return (
    <section
      id={id}
      onClick={() => { if (!active && onActivate) onActivate(id); }}
      className={`py-7 border-t border-[var(--border)] transition-opacity duration-500 ${!active ? 'cursor-pointer' : ''}`}
      // Sharper contrast: inactive drops to 0.22 so the active section is
      // the clear focal point (was 0.38, felt mushy).
      style={{ opacity: active ? 1 : 0.22, scrollMarginTop: 88 }}
    >
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-secondary)]">{title}</h2>
        {headerExtra}
      </div>
      {subtitle && <p className="text-[11.5px] text-[var(--text-secondary)]/70 -mt-2 mb-3">{subtitle}</p>}
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 min-h-[28px]">
      {label ? <span className="text-[12.5px] text-[var(--text-secondary)]">{label}</span> : <span />}
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function ProviderRow({ label, sub, connected, connectHref, onDisconnect }: { label: string; sub: string; connected: boolean; connectHref: string; onDisconnect: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 min-h-[44px]">
      <div className="min-w-0">
        <div className="text-[13px] text-[var(--text-primary)] flex items-center gap-2">
          {label}
          {connected && (
            <span className="inline-flex items-center gap-1 text-[10px] text-[var(--teal,#10b981)] px-1.5 py-0.5 rounded border" style={{ borderColor: 'color-mix(in srgb, var(--teal, #10b981) 30%, transparent)' }}>
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--teal,#10b981)]" />
              Connected
            </span>
          )}
        </div>
        <div className="text-[10.5px] text-[var(--text-secondary)]/70 mt-0.5">{sub}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {connected && (
          <button
            onClick={onDisconnect}
            className="text-[11.5px] font-medium px-3 py-1.5 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--danger,#ef4444)]/50 hover:text-[var(--danger,#ef4444)] hover:bg-[var(--danger,#ef4444)]/5 transition-colors"
          >
            Disconnect
          </button>
        )}
        <a
          href={connectHref}
          className={`text-[11.5px] font-medium px-3 py-1.5 rounded-md transition-all ${
            connected
              ? 'border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-primary)]/40 hover:text-[var(--text-primary)]'
              : 'bg-[var(--text-primary)] text-[var(--bg-primary)] hover:scale-[1.03] active:scale-[0.97]'
          }`}
        >
          {connected ? 'Reconnect' : 'Connect'}
        </a>
      </div>
    </div>
  );
}

function MailBackfillView({ cursor }: { cursor: MailCursor | null }) {
  if (!cursor) return <p className="text-[12px] text-[var(--text-secondary)]">No mail synced yet. The first sync runs automatically.</p>;
  const total = cursor.total_count || 0;
  const scanned = cursor.scanned_total || 0;
  const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : (cursor.backfill_done ? 100 : 0);
  const fmt = (iso?: string) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '…';
  return (
    <div className="space-y-2.5">
      <Row label="Indexed">
        <span className="text-[13px] tabular-nums">
          {scanned.toLocaleString()}{total > 0 && <span className="text-[var(--text-secondary)]"> / {total.toLocaleString()}</span>}
        </span>
      </Row>
      <Row label="Progress">
        <div className="flex items-center gap-2 w-60">
          <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}>
            <motion.div className="h-full rounded-full" style={{ background: cursor.backfill_done ? 'var(--teal, #10b981)' : 'var(--accent)' }} animate={{ width: `${pct}%` }} transition={{ duration: 0.4 }} />
          </div>
          <span className="text-[11px] tabular-nums text-[var(--text-secondary)] w-10 text-right">
            {cursor.backfill_done ? 'Done' : `${pct}%`}
          </span>
        </div>
      </Row>
      <Row label="Newest"><span className="text-[12.5px] tabular-nums">{fmt(cursor.newest_seen)}</span></Row>
      <Row label="Oldest"><span className="text-[12.5px] tabular-nums">{fmt(cursor.backfill_oldest)}</span></Row>
    </div>
  );
}

function TagsSection({ active, onActivate }: { active: boolean; onActivate?: (id: string) => void }) {
  const { contacts, updateContact, fetchAll } = useCrmStore();
  const addToast = useToastStore((s) => s.addToast);
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const tagCounts: Record<string, number> = {};
  contacts.forEach((c) => { (c.tags || []).forEach((tag) => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }); });
  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

  const renameTag = async (oldTag: string, newTag: string) => {
    if (!newTag.trim() || oldTag === newTag.trim().toLowerCase()) { setRenamingTag(null); return; }
    const normalized = newTag.trim().toLowerCase();
    const affected = contacts.filter((c) => (c.tags || []).includes(oldTag));
    for (const contact of affected) {
      const updated = (contact.tags || []).map((t) => (t === oldTag ? normalized : t));
      await updateContact(contact.id, { tags: [...new Set(updated)] });
    }
    setRenamingTag(null);
    addToast({ message: `Renamed "${oldTag}" → "${normalized}" (${affected.length} contacts)`, type: 'success', icon: 'contact' });
    await fetchAll();
  };

  const deleteTag = async (tag: string) => {
    const affected = contacts.filter((c) => (c.tags || []).includes(tag));
    for (const contact of affected) { await updateContact(contact.id, { tags: (contact.tags || []).filter((t) => t !== tag) }); }
    addToast({ message: `Removed "${tag}" from ${affected.length} contacts`, type: 'info', icon: 'delete' });
    await fetchAll();
  };

  if (sortedTags.length === 0) return null;

  return (
    <Section id="tags" title={`Tags (${sortedTags.length})`} active={active} onActivate={onActivate}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        {sortedTags.map(([tag, count]) => {
          const isRenaming = renamingTag === tag;
          return (
            <div key={tag} className="flex items-center justify-between gap-2 group min-h-[26px]">
              {isRenaming ? (
                <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') renameTag(tag, renameValue); if (e.key === 'Escape') setRenamingTag(null); }}
                  onBlur={() => renameTag(tag, renameValue)}
                  className="flex-1 bg-transparent border-b border-[var(--text-primary)]/40 px-1 text-[12px] focus:outline-none" autoFocus />
              ) : (
                <span className="text-[12.5px] truncate text-[var(--text-primary)]">{tag}</span>
              )}
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] text-[var(--text-secondary)] tabular-nums">{count}</span>
                {!isRenaming && (
                  <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => { setRenamingTag(tag); setRenameValue(tag); }} className="text-[var(--text-secondary)] hover:text-[var(--accent)] text-[10.5px]">Edit</button>
                    <button onClick={() => deleteTag(tag)} className="text-[var(--text-secondary)] hover:text-[var(--danger,#ef4444)] text-[10.5px]">Delete</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ─── Danger zone (distinct, prominent treatment) ──────────────────────

function DangerZone({ id, active, onActivate, onDelete }: { id: string; active: boolean; onActivate?: (id: string) => void; onDelete: () => void }) {
  return (
    <section
      id={id}
      onClick={() => { if (!active && onActivate) onActivate(id); }}
      className={`mt-10 rounded-xl p-6 transition-opacity duration-500 ${!active ? 'cursor-pointer' : ''}`}
      style={{
        opacity: active ? 1 : 0.3,
        scrollMarginTop: 88,
        border: '1px solid color-mix(in srgb, var(--danger, #ef4444) 35%, transparent)',
        background: 'color-mix(in srgb, var(--danger, #ef4444) 5%, transparent)',
        boxShadow: '0 0 0 0 transparent',
      }}
    >
      <div className="flex items-start gap-3 mb-4">
        <AlertTriangle size={16} className="text-[var(--danger,#ef4444)] mt-0.5 shrink-0" />
        <div>
          <h2 className="text-[12px] uppercase tracking-[0.14em] text-[var(--danger,#ef4444)] font-semibold">Danger zone</h2>
          <p className="text-[11.5px] text-[var(--text-secondary)] mt-1">Actions in this section are permanent and cannot be undone.</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 pt-4 border-t" style={{ borderColor: 'color-mix(in srgb, var(--danger, #ef4444) 22%, transparent)' }}>
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">Delete your account</p>
          <p className="text-[11.5px] text-[var(--text-secondary)] mt-0.5">
            Removes every contact, event, task, note, and connection from your account.
          </p>
        </div>
        <button
          onClick={onDelete}
          className="flex items-center gap-1.5 px-4 py-2 rounded-md text-[12px] font-medium text-white transition-all hover:scale-[1.03] active:scale-[0.97] shrink-0"
          style={{
            background: 'var(--danger, #ef4444)',
            boxShadow: '0 4px 14px color-mix(in srgb, var(--danger, #ef4444) 35%, transparent)',
          }}
        >
          <Trash2 size={12} /> Delete account
        </button>
      </div>
    </section>
  );
}

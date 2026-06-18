'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check, Trash2, Clock, Link2, ChevronDown, Pencil, FileText, Plus, Mail, Phone, ExternalLink, Camera, FolderOpen, MoreHorizontal } from 'lucide-react';
import { useCrmStore, ContactSynthesis } from '@/store/useCrmStore';
import { supabase } from '@/lib/supabase';
import { useToastStore } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { format, differenceInDays, isAfter, isBefore, addDays } from 'date-fns';
import { computeHealthScore, lastSignalDate } from '@/lib/healthScore';

function lastSignalDays(contact: any): number | null {
  const d = lastSignalDate(contact);
  return d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000)) : null;
}
import { Mic, MicOff, Calendar, MessageCircle } from 'lucide-react';
import { displayName, displayInitial } from '@/lib/displayName';
import PhotoCropModal from '@/components/PhotoCropModal';
import ResearchSection from './ResearchSection';
import EngagementBrief from './EngagementBrief';

export default function ContactPanel({ inline = false }: { inline?: boolean }) {
  const {
    contacts, events, selectedContactId, setSelectedContact,
    updateContact, deleteWithPop, addContact, fetchAll, pendingDeleteId,
    addTask, updateTask, toggleTask, deleteTask,
    addConnection, removeConnection,
    projects, addContactToProject, removeContactFromProject,
    mergeContacts,
  } = useCrmStore();
  const confirm = useConfirm();
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDue, setNewTaskDue] = useState('');
  // Source URL for the photo cropper modal. When set, the modal opens. Cleared
  // on cancel or after a successful save.
  const [pendingPhotoSrc, setPendingPhotoSrc] = useState<string | null>(null);
  const [showConnectPicker, setShowConnectPicker] = useState(false);
  const [connectSearch, setConnectSearch] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTaskTitle, setEditTaskTitle] = useState('');
  // Which past meetings are expanded to show description / attendees / AI enrichment
  const [expandedMeetings, setExpandedMeetings] = useState<Set<string>>(new Set());
  const [editTaskDue, setEditTaskDue] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const [localNotes, setLocalNotes] = useState('');
  const [notesContactId, setNotesContactId] = useState<string | null>(null);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const [newTag, setNewTag] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [editingField, setEditingField] = useState<'name' | 'company' | 'role' | 'email' | 'phone' | 'linkedin' | null>(null);
  const [showMergePicker, setShowMergePicker] = useState(false);
  const [mergeSearch, setMergeSearch] = useState('');
  const [editFieldValue, setEditFieldValue] = useState('');
  const [intelTab, setIntelTab] = useState<'brief' | 'research' | 'activity'>('brief');
  const [showOverflow, setShowOverflow] = useState(false);
  const [panelView, setPanelView] = useState<'main' | 'background'>('main');
  const [showAddTaskInline, setShowAddTaskInline] = useState(false);
  // Quick voice note state — MUST live up here above the `if (!contact) return null`
  // below. Were declared mid-component (~line 200) which violated Rules of Hooks:
  // when contact briefly went null and came back, React saw a different hook
  // count between renders and threw error #310. Moving them above the early
  // return keeps the call order stable.
  const [quickRecording, setQuickRecording] = useState(false);
  const quickRecRef = useRef<any>(null);
  const quickTextRef = useRef('');
  const addToast = useToastStore((s) => s.addToast);

  const allTags = [...new Set(contacts.flatMap((c) => c.tags || []))].sort();
  const liveContact = contacts.find((c) => c.id === selectedContactId);
  // After a delete the contact disappears from `contacts` in the same render
  // that selectedContactId clears — without a snapshot, the panel would
  // render empty for the ~200ms slide-out animation in desktop inline mode.
  // Hold the last live contact in a ref so the body stays visible until the
  // aside fully exits. We only fall back to the snapshot when inline (desktop
  // docked rail wrapped in page-level AnimatePresence); overlay mode (mobile)
  // is unconditionally mounted and must hide when nothing is selected.
  const lastContactRef = useRef<typeof liveContact>(null);
  if (liveContact) lastContactRef.current = liveContact;
  const contact = liveContact || (inline ? lastContactRef.current : null);

  useEffect(() => {
    if (contact && contact.id !== notesContactId) {
      // If a previous save failed, the keystroke-level local backup is still
      // here. Prefer it over the DB value so the user doesn't lose their text.
      let next = contact.notes;
      try {
        const backup = localStorage.getItem(`notes-backup-${contact.id}`);
        if (backup && backup.length > (contact.notes || '').length) {
          next = backup;
          // Re-attempt the save so it lands in DB this time.
          supabase.from('contacts').update({ notes: backup }).eq('id', contact.id).then(({ error }) => {
            if (!error) { try { localStorage.removeItem(`notes-backup-${contact.id}`); } catch {} }
          });
        }
      } catch {}
      setLocalNotes(next);
      setNotesContactId(contact.id);
      isTypingRef.current = false;
    }
  }, [contact?.id]);

  // ── Background research pre-fetch ──
  // The moment a contact opens (and lacks research), kick off the research
  // pipeline in the background. By the time the user clicks the Background
  // tab, results are already loaded — no spinner wait.
  const prefetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!contact || contact.is_self) return;
    if ((contact as any).research) return;            // already done
    if (prefetchedFor.current === contact.id) return; // already fired
    prefetchedFor.current = contact.id;

    const cid = contact.id;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const headers = { Authorization: `Bearer ${session?.access_token || ''}`, 'Content-Type': 'application/json' };
        const candRes = await fetch('/api/research-contact/candidates', {
          method: 'POST', headers, body: JSON.stringify({ contactId: cid }),
        });
        if (!candRes.ok) return;
        const candData = await candRes.json();
        // Only auto-deep on fast-path (synthesized candidate). Multi-candidate
        // disambiguation requires user input — we'll show the picker only when
        // they open Background.
        if (!candData.fastPath || !candData.candidates?.[0]) return;
        const deepRes = await fetch('/api/research-contact/deep', {
          method: 'POST', headers, body: JSON.stringify({ contactId: cid, candidate: candData.candidates[0] }),
        });
        if (deepRes.ok) await fetchAll({ since: useCrmStore.getState().lastSyncedAt || undefined });
      } catch { /* silent — pre-fetch is best-effort */ }
    })();
  }, [contact?.id, contact?.is_self, (contact as any)?.research]);

  if (!contact) return null;

  const startEditField = (field: typeof editingField) => {
    if (!field) return;
    setEditingField(field);
    setEditFieldValue(contact[field] || '');
  };

  const saveEditField = () => {
    if (!editingField) return;
    if (editingField === 'name' && !editFieldValue.trim()) return;
    updateContact(contact.id, { [editingField]: editFieldValue.trim() || undefined });
    setEditingField(null);
    setEditFieldValue('');
  };

  const connections = contacts.filter((c) => contact.connections.includes(c.id));
  const pendingTasks = contact.tasks.filter((t) => !t.completed);
  const completedTasks = contact.tasks.filter((t) => t.completed);

  const noteParts = contact.notes.split(/\n\n\[/);
  const transcriptEntries = noteParts.slice(1).map(e => '[' + e);

  const handleAddTask = async () => {
    if (!newTaskTitle.trim()) return;
    await addTask({ contact_id: contact.id, title: newTaskTitle, type: 'other', due_date: newTaskDue || undefined });
    addToast({ message: `Task added for ${contact.name}`, type: 'success', icon: 'task' });
    setNewTaskTitle('');
    setNewTaskDue('');
  };

  const startEditTask = (task: any) => { setEditingTaskId(task.id); setEditTaskTitle(task.title); setEditTaskDue(task.due_date || ''); };

  const saveEditTask = async () => {
    if (!editingTaskId || !editTaskTitle.trim()) return;
    await updateTask(editingTaskId, { title: editTaskTitle, due_date: editTaskDue || undefined });
    setEditingTaskId(null);
  };

  const contactProjects = projects.filter((p) => p.contactIds.includes(contact.id));
  const health = computeHealthScore(contact);

  // ── Intelligence: meetings, frequency, patterns ──
  const now = new Date();
  // Events are linked to contacts via events.contact_id (set at sync time by the
  // auto_link_event trigger or backfilled via attendee/organizer email match against
  // primary email + aliases). No more fragile substring title matching — that's what
  // produced phantom Adi/Hadi noise.
  const contactEvents = events
    .filter((e) => e.contact_id === contact.id)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const pastMeetings = contactEvents.filter((e) => isBefore(new Date(e.date), addDays(now, 1)));
  const upcomingMeetings = contactEvents.filter((e) => isAfter(new Date(e.date), now));
  const lastMeeting = pastMeetings[0];

  // Frequency: meetings in last 90 days
  const meetingsLast90 = pastMeetings.filter((e) => differenceInDays(now, new Date(e.date)) <= 90).length;
  const meetingFrequency = meetingsLast90 === 0 ? null
    : meetingsLast90 >= 12 ? 'Weekly'
    : meetingsLast90 >= 4 ? 'Bi-weekly'
    : meetingsLast90 >= 2 ? 'Monthly'
    : 'Occasional';

  // Recurring: check if same title appears 2+ times
  const titleCounts: Record<string, number> = {};
  pastMeetings.forEach((e) => { const t = e.title.replace(/\d{4}-\d{2}-\d{2}/, '').trim(); titleCounts[t] = (titleCounts[t] || 0) + 1; });
  const recurringMeeting = Object.entries(titleCounts).find(([_, count]) => count >= 2);

  // Last meeting context from notes
  const transcripts = contact.notes.split(/\n\n\[/).filter((_, i) => i > 0).map((e) => '[' + e);
  const lastTranscript = transcripts[0];

  const formatTime12 = (t: string) => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
  };

  // Quick voice note (hooks moved above the early return — see top of component)
  const startQuickNote = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const rec = new SpeechRecognition();
    rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
    rec.onresult = (e: any) => {
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) quickTextRef.current += e.results[i][0].transcript + ' ';
      }
    };
    rec.onend = () => {
      if (quickTextRef.current.trim()) {
        const timestamp = format(new Date(), 'MMM d');
        const newNote = contact.notes
          ? `${contact.notes}\n\n[${timestamp}] ${quickTextRef.current.trim()}`
          : `[${timestamp}] ${quickTextRef.current.trim()}`;
        updateContact(contact.id, { notes: newNote, last_contacted: new Date().toISOString() });
        setLocalNotes(newNote);
        addToast({ message: 'Voice note saved', type: 'success', icon: 'voice' });
      }
      quickTextRef.current = '';
      setQuickRecording(false);
    };
    quickRecRef.current = rec;
    rec.start();
    setQuickRecording(true);
  };

  const stopQuickNote = () => {
    quickRecRef.current?.stop();
  };

  // Section header — readable size + normal case so sections actually feel separate.
  // Subtle bottom hairline gives each section a "card" feel without using boxes.
  const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <h3 className="text-[13px] font-medium text-[var(--text-primary)] mb-4">{children}</h3>
  );

  // Inline mode: renders inside the flex layout (no fixed positioning)
  // Overlay mode: fixed right panel (mobile, or when inline not set)
  const wrapperClass = inline
    ? 'h-full w-full'
    : 'fixed right-0 top-0 h-full w-full md:w-[420px] glass-elevated border-l border-[var(--border)] z-40 overflow-y-auto';

  const isPopping = pendingDeleteId === contact.id;
  const content = (
    <div
      className={wrapperClass}
      style={isPopping ? {
        opacity: 0.35,
        transform: 'scale(0.97)',
        filter: 'blur(2px)',
        transition: 'opacity 280ms ease-out, transform 280ms ease-out, filter 280ms ease-out',
        pointerEvents: 'none',
      } : {
        transition: 'opacity 200ms ease-out, transform 200ms ease-out, filter 200ms ease-out',
      }}
    >
      {/* ── HERO: snapshot — identity, status rows, tags inline, actions ── */}
      {(() => {
        const synth = (contact as any).synthesis as ContactSynthesis | null;
        const lastTalkedDays = lastSignalDays(contact);
        const lastTalkedLabel = lastTalkedDays == null
          ? '—'
          : lastTalkedDays === 0 ? 'today'
          : lastTalkedDays === 1 ? '1 day ago'
          : lastTalkedDays < 30 ? `${lastTalkedDays} days ago`
          : lastTalkedDays < 365 ? `${Math.round(lastTalkedDays/30)} mo ago`
          : `${Math.round(lastTalkedDays/365)} yr ago`;
        const lastMeetingLabel = lastMeeting ? format(new Date(lastMeeting.date + 'T12:00:00'), 'MMM d, yyyy') : '—';
        const nextMtg = upcomingMeetings[upcomingMeetings.length - 1];
        const nextMeetingLabel = nextMtg
          ? format(new Date(nextMtg.date + 'T12:00:00'), 'MMM d, yyyy')
          : '—';
        const classification = synth?.relationship_type || (contact.tags && contact.tags[0]) || '—';
        return (
          <div
            className="relative px-5 pt-5 pb-5 backdrop-blur-2xl"
            style={{
              ['--text-primary' as any]: 'var(--hero-text-primary)',
              ['--text-secondary' as any]: 'var(--hero-text-secondary)',
              ['--border' as any]: 'var(--hero-border)',
              ['--hover-bg' as any]: 'var(--hero-hover-bg)',
              ['--input-bg' as any]: 'var(--hero-input-bg)',
              // Layered: hero base + top-down gradient overlay for "lit from above" glass
              backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0) 38%, rgba(0,0,0,0.12)), radial-gradient(120% 80% at 80% -10%, rgba(167,139,250,0.18), transparent 60%)',
              backgroundColor: 'var(--hero-bg)',
              color: 'var(--hero-text-primary)',
              // 3D: bright top edge + soft outer shadow below
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -1px 0 rgba(0,0,0,0.25), 0 12px 28px -10px rgba(0,0,0,0.45)',
            }}
          >
            {/* Top: avatar + name + view-toggle + close */}
            <div className="flex items-start gap-3">
              <label className="relative w-11 h-11 rounded-full flex-shrink-0 cursor-pointer group">
                {contact.photo ? (
                  <img src={contact.photo} alt={contact.name} className="w-11 h-11 rounded-full object-cover" />
                ) : (
                  <div className="w-11 h-11 rounded-full flex items-center justify-center text-[14px] font-medium text-[var(--text-secondary)] border border-[var(--border)]">
                    {displayInitial(contact.name)}
                  </div>
                )}
                <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-[9px] uppercase tracking-wider text-white/90">edit</div>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Reset the input first so picking the same file twice still fires.
                  e.target.value = '';
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => setPendingPhotoSrc(reader.result as string);
                  reader.readAsDataURL(file);
                }} />
              </label>
              <div className="flex-1 min-w-0 pt-0.5">
                {editingField === 'name' ? (
                  <input value={editFieldValue} onChange={(e) => setEditFieldValue(e.target.value)}
                    onBlur={saveEditField} onKeyDown={(e) => { if (e.key === 'Enter') saveEditField(); if (e.key === 'Escape') setEditingField(null); }}
                    className="w-full text-[17px] font-semibold bg-transparent border-b border-[var(--accent)]/40 focus:outline-none tracking-tight" autoFocus />
                ) : (
                  <h2 onClick={() => startEditField('name')} className="text-[17px] font-semibold cursor-pointer hover:text-[var(--accent)] transition-colors tracking-tight leading-tight truncate">{displayName(contact.name)}</h2>
                )}
                {(contact.company || contact.role || editingField === 'company' || editingField === 'role') ? (
                  <div className="flex items-center gap-1.5 mt-1 text-[12px] text-[var(--text-secondary)]">
                    {editingField === 'company' ? (
                      <input value={editFieldValue} onChange={(e) => setEditFieldValue(e.target.value)}
                        onBlur={saveEditField} onKeyDown={(e) => { if (e.key === 'Enter') saveEditField(); if (e.key === 'Escape') setEditingField(null); }}
                        className="text-[12px] bg-transparent border-b border-[var(--accent)]/40 focus:outline-none" placeholder="Company" autoFocus />
                    ) : contact.company ? (
                      <span onClick={() => startEditField('company')} className="cursor-pointer hover:text-[var(--text-primary)] transition-colors truncate">{contact.company}</span>
                    ) : null}
                    {contact.role && contact.company && <span className="text-[var(--text-secondary)]/30">·</span>}
                    {editingField === 'role' ? (
                      <input value={editFieldValue} onChange={(e) => setEditFieldValue(e.target.value)}
                        onBlur={saveEditField} onKeyDown={(e) => { if (e.key === 'Enter') saveEditField(); if (e.key === 'Escape') setEditingField(null); }}
                        className="text-[12px] bg-transparent border-b border-[var(--accent)]/40 focus:outline-none" placeholder="Role" autoFocus />
                    ) : contact.role ? (
                      <span onClick={() => startEditField('role')} className="cursor-pointer hover:text-[var(--text-primary)] transition-colors truncate">{contact.role}</span>
                    ) : null}
                  </div>
                ) : (
                  <button onClick={() => startEditField('company')} className="text-[12px] text-[var(--text-secondary)]/50 hover:text-[var(--text-secondary)] mt-1">Add company</button>
                )}
              </div>
            </div>

            {/* Close — absolute top-right so it never steals from the name width */}
            <button onClick={() => setSelectedContact(null)}
              className="absolute top-3 right-3 w-7 h-7 rounded-full flex items-center justify-center text-[var(--text-secondary)]/60 hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors text-[13px] leading-none">
              ×
            </button>

            {/* View toggle + overflow — own row, doesn't crowd the name */}
            <div className="mt-4 flex items-center gap-2">
              {!contact.is_self && (
                <div className="flex items-center text-[10.5px] uppercase tracking-[0.08em] rounded-md border border-[var(--border)] overflow-hidden">
                  <button onClick={() => setPanelView('main')}
                    className={`px-2.5 py-1 transition-colors ${panelView === 'main' ? 'bg-[var(--hover-bg)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]/70 hover:text-[var(--text-primary)]'}`}>
                    Snapshot
                  </button>
                  <button onClick={() => setPanelView('background')}
                    className={`px-2.5 py-1 border-l border-[var(--border)] transition-colors ${panelView === 'background' ? 'bg-[var(--hover-bg)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]/70 hover:text-[var(--text-primary)]'}`}>
                    Background
                  </button>
                </div>
              )}
              <div className="flex-1" />
              <div className="relative">
                <button onClick={() => setShowOverflow(!showOverflow)} className="px-2 py-1 rounded text-[var(--text-secondary)]/60 hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors text-[13px] leading-none">•••</button>
                <AnimatePresence>
                  {showOverflow && (
                    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                      className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] shadow-lg overflow-hidden z-20"
                      onMouseLeave={() => setShowOverflow(false)}>
                      {/* Contact info — click to edit; "Add" if missing */}
                      <div className="px-3 pt-2 pb-1 text-[9.5px] uppercase tracking-[0.1em] text-[var(--text-secondary)]/60">Contact info</div>
                      {(['email','phone','linkedin'] as const).map((field) => {
                        const value = contact[field];
                        const label = field.charAt(0).toUpperCase() + field.slice(1);
                        return (
                          <button key={field}
                            onClick={() => { setShowOverflow(false); startEditField(field); }}
                            className="w-full px-3 py-1.5 text-[12px] text-left hover:bg-[var(--hover-bg)] transition-colors flex items-center justify-between gap-2">
                            <span className={value ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]/70'}>{label}</span>
                            <span className="text-[11px] text-[var(--text-secondary)] truncate max-w-[140px]">{value || 'Add'}</span>
                          </button>
                        );
                      })}
                      {/* Auto-fill from research — only when LinkedIn URL is missing AND research found one */}
                      {(() => {
                        const linkedinFromResearch = (contact as any).research?.confirmed?.linkedinUrl;
                        if (!contact.linkedin && linkedinFromResearch) {
                          return (
                            <button onClick={async () => {
                              setShowOverflow(false);
                              await updateContact(contact.id, { linkedin: linkedinFromResearch });
                              addToast({ message: 'LinkedIn auto-filled from research', type: 'success' });
                            }} className="w-full px-3 py-2 text-[12px] text-left hover:bg-[var(--hover-bg)] transition-colors text-[var(--accent)]">
                              Auto-fill LinkedIn from research
                            </button>
                          );
                        }
                        return null;
                      })()}
                      <div className="h-px bg-[var(--border)]" />
                      {contact.phone && <a href={`tel:${contact.phone}`} onClick={() => setShowOverflow(false)} className="block px-3 py-1.5 text-[12px] hover:bg-[var(--hover-bg)] transition-colors">Call</a>}
                      {contact.linkedin && <a href={contact.linkedin} target="_blank" rel="noopener noreferrer" onClick={() => setShowOverflow(false)} className="block px-3 py-1.5 text-[12px] hover:bg-[var(--hover-bg)] transition-colors">Open LinkedIn</a>}
                      {(contact.phone || contact.linkedin) && <div className="h-px bg-[var(--border)]" />}
                      <button onClick={() => { setShowOverflow(false); setShowTagInput(true); }} className="w-full px-3 py-1.5 text-[12px] text-left hover:bg-[var(--hover-bg)] transition-colors">Add tag</button>
                      <button onClick={() => { setShowOverflow(false); setShowProjectPicker(true); }} className="w-full px-3 py-1.5 text-[12px] text-left hover:bg-[var(--hover-bg)] transition-colors">Add to project</button>
                      <div className="h-px bg-[var(--border)]" />
                      <button onClick={async () => {
                        setShowOverflow(false);
                        const next = !contact.is_self;
                        if (next) {
                          const { data: { user } } = await supabase.auth.getUser();
                          if (user) await supabase.from('contacts').update({ is_self: false }).eq('user_id', user.id).neq('id', contact.id);
                        }
                        await updateContact(contact.id, { is_self: next } as any);
                        fetchAll();
                      }} className="w-full px-3 py-1.5 text-[12px] text-left hover:bg-[var(--hover-bg)] transition-colors text-[var(--text-secondary)]">
                        {contact.is_self ? 'Unmark as you' : 'Mark as you'}
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* Inline tags row — subtle text, not chips */}
            {((contact.tags?.length || 0) > 0 || contactProjects.length > 0) && (
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--text-secondary)]">
                {(contact.tags || []).map((tag, i) => (
                  <span key={tag} className="group/tag flex items-center gap-1">
                    {i > 0 && <span className="text-[var(--text-secondary)]/30 mr-1">·</span>}
                    <span>{tag}</span>
                    <button onClick={() => updateContact(contact.id, { tags: (contact.tags || []).filter((t) => t !== tag) })}
                      className="opacity-0 group-hover/tag:opacity-100 text-[var(--text-secondary)]/40 hover:text-red-400 transition-all text-[10px] leading-none">×</button>
                  </span>
                ))}
                {contactProjects.map((p, i) => (
                  <span key={p.id} className="group/proj flex items-center gap-1" style={{ color: p.color || 'var(--accent)' }}>
                    {(i > 0 || (contact.tags?.length || 0) > 0) && <span className="text-[var(--text-secondary)]/30 mr-1">·</span>}
                    <span>{p.name}</span>
                    <button onClick={() => removeContactFromProject(p.id, contact.id)}
                      className="opacity-0 group-hover/proj:opacity-100 text-[var(--text-secondary)]/40 hover:text-red-400 transition-all text-[10px] leading-none">×</button>
                  </span>
                ))}
              </div>
            )}

            {/* Snapshot — mini stat tiles. Filters empty cells so we never show '—'. */}
            {!contact.is_self && (() => {
              const tiles = [
                ['Last talked',   lastTalkedLabel,   lastTalkedLabel  !== '—'],
                ['Last meeting',  lastMeetingLabel,  lastMeetingLabel !== '—'],
                ['Next meeting',  nextMeetingLabel,  nextMeetingLabel !== '—'],
                ['Classification', classification,    classification    !== '—'],
              ].filter(([, , show]) => show) as [string, string, boolean][];
              if (tiles.length === 0) return null;
              const cols = tiles.length === 1 ? 'grid-cols-1' : tiles.length === 2 ? 'grid-cols-2' : tiles.length === 3 ? 'grid-cols-3' : 'grid-cols-2';
              return (
                <div className={`mt-4 grid ${cols} gap-2`}>
                  {tiles.map(([k, v]) => (
                    <div key={k}
                      className="rounded-lg px-3 py-2.5 backdrop-blur-md"
                      style={{
                        backgroundColor: 'rgba(255,255,255,0.04)',
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), inset 0 0 0 1px rgba(255,255,255,0.04)',
                      }}>
                      <div className="text-[13.5px] font-medium leading-tight tabular-nums capitalize truncate">{v}</div>
                      <div className="text-[9.5px] uppercase tracking-[0.1em] text-[var(--text-secondary)]/70 mt-1">{k}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Inline editor for email / phone / linkedin (triggered from ••• menu) */}
            {(editingField === 'email' || editingField === 'phone' || editingField === 'linkedin') && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-secondary)] w-16 flex-shrink-0">{editingField}</span>
                <input value={editFieldValue} onChange={(e) => setEditFieldValue(e.target.value)}
                  onBlur={saveEditField}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveEditField(); if (e.key === 'Escape') setEditingField(null); }}
                  type={editingField === 'email' ? 'email' : editingField === 'phone' ? 'tel' : 'url'}
                  placeholder={editingField === 'email' ? 'name@domain.com' : editingField === 'phone' ? '+1 555 0123' : 'https://linkedin.com/in/…'}
                  className="flex-1 bg-[var(--input-bg)] border border-[var(--border)] rounded-md px-3 py-1.5 text-[12.5px] focus:outline-none focus:border-[var(--accent)]/40 transition-colors" autoFocus />
              </div>
            )}

            {/* Action row — voice note + email, right-aligned, compact */}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={quickRecording ? stopQuickNote : startQuickNote}
                className={`px-3 py-1.5 rounded-md text-[12px] font-medium border transition-colors ${quickRecording ? 'border-red-400/40 bg-red-500/10 text-red-400' : 'border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)]/40 hover:bg-[var(--hover-bg)]'}`}>
                {quickRecording ? 'Stop recording' : 'Voice note'}
              </button>
              {contact.email && (
                <a href={`mailto:${contact.email}`}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-[var(--accent)] hover:bg-[var(--accent-light)] text-white transition-colors">
                  Email
                </a>
              )}
            </div>

            {/* Tag/project input affordances when triggered from menu */}
            <AnimatePresence>
              {showTagInput && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mt-3">
                  <input value={newTag} onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newTag.trim()) {
                        const tag = newTag.trim().toLowerCase();
                        if (!(contact.tags || []).includes(tag)) updateContact(contact.id, { tags: [...(contact.tags || []), tag] });
                        setNewTag(''); setShowTagInput(false);
                      }
                      if (e.key === 'Escape') { setShowTagInput(false); setNewTag(''); }
                    }}
                    placeholder="Tag name…"
                    className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-md px-3 py-1.5 text-[12px] focus:outline-none focus:border-[var(--accent)]/40 transition-colors" autoFocus />
                </motion.div>
              )}
              {showProjectPicker && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mt-3">
                  <div className="bg-[var(--bg-raised)] border border-[var(--border)] rounded-md overflow-hidden max-h-32 overflow-y-auto">
                    {projects.filter((p) => p.status === 'active' && !p.contactIds.includes(contact.id)).map((p) => (
                      <button key={p.id} onClick={() => { addContactToProject(p.id, contact.id); setShowProjectPicker(false); }}
                        className="w-full text-left px-3 py-2 text-[12px] hover:bg-[var(--hover-bg)] transition-colors">
                        {p.name}
                      </button>
                    ))}
                    {projects.filter((p) => p.status === 'active' && !p.contactIds.includes(contact.id)).length === 0 && (
                      <p className="text-[12px] text-[var(--text-secondary)] text-center py-3">No projects</p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })()}

      {/* ── BODY: Snapshot view (Summary → Todo → Timeline) or Background view ── */}
      {panelView === 'background' ? (
        <div className="px-5 pt-5 pb-8">
          <ResearchSection
            contactId={contact.id}
            contactName={contact.name}
            research={(contact as any).research ?? null}
            isSelf={contact.is_self}
          />
        </div>
      ) : (() => {
        const synth = (contact as any).synthesis as ContactSynthesis | null;
        const summaryText = synth?.prebrief?.[0] || synth?.hooks?.[0] || health.suggestion || null;
        // Per-meeting note lookup: parse the contact.notes blob for [Mmm d] anchors.
        // The PROSE before the first anchor = the user's free-form notes (their own writing).
        const blob = contact.notes || '';
        const firstAnchor = blob.search(/\n\n\[\w{3} \d{1,2}\]/);
        const proseNote = (firstAnchor === -1 ? blob : blob.slice(0, firstAnchor)).trim();
        const noteByDate = new Map<string, string>();
        for (const m of blob.matchAll(/\[(\w{3} \d{1,2})\]([\s\S]*?)(?=\n\n\[|$)/g)) {
          noteByDate.set(m[1].toLowerCase(), m[2].trim());
        }
        const lookupNote = (eventDate: string) => {
          try { return noteByDate.get(format(new Date(eventDate + 'T12:00:00'), 'MMM d').toLowerCase()) || null; } catch { return null; }
        };
        const openTasks = pendingTasks;

        // ── Merged timeline: meetings + emails (in/out) + upcoming + tasks ──
        // Each entry has a kind that drives the dot color:
        //   meeting  → solid lavender  (definitive past event)
        //   inbound  → solid teal      (they emailed you)
        //   outbound → outlined teal   (you emailed them)
        //   upcoming → outlined lavender (future meeting)
        //   task     → outlined gold  (something you need to do/send)
        type Entry = { id: string; kind: 'meeting' | 'inbound' | 'outbound' | 'upcoming' | 'task'; date: Date; title: string; sub?: string | null };
        const entries: Entry[] = [];
        for (const e of pastMeetings) {
          entries.push({ id: 'm-' + e.id, kind: 'meeting', date: new Date(e.date + 'T' + (e.time || '12:00')), title: e.title, sub: lookupNote(e.date) || (e as any).enrichment?.follow_up || (e as any).description || null });
        }
        for (const e of upcomingMeetings) {
          entries.push({ id: 'u-' + e.id, kind: 'upcoming', date: new Date(e.date + 'T' + (e.time || '12:00')), title: e.title, sub: e.description || null });
        }
        for (const t of openTasks) {
          if (t.due_date) {
            entries.push({ id: 't-' + t.id, kind: 'task', date: new Date(t.due_date + 'T12:00:00'), title: t.title, sub: 'Due — send / follow up' });
          }
        }
        const firstName = displayName(contact.name).split(/[ ,]/)[0] || contact.name;
        const fmtCc = (names?: string[] | null) => {
          if (!names || names.length === 0) return null;
          if (names.length <= 2) return `cc'd ${names.join(' and ')}`;
          return `cc'd ${names.slice(0, 2).join(', ')} and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'}`;
        };
        if (contact.email_stats?.last_inbound_at) {
          const subj = contact.email_stats.last_inbound_subject;
          const cc = fmtCc(contact.email_stats.last_inbound_cc_names);
          const subParts = [subj && `"${subj}"`, cc].filter(Boolean).join(' · ');
          entries.push({
            id: 'ein',
            kind: 'inbound',
            date: new Date(contact.email_stats.last_inbound_at),
            title: `${firstName} emailed you`,
            sub: subParts || `${contact.email_stats.emails_received} received in total`,
          });
        }
        if (contact.email_stats?.last_outbound_at) {
          const subj = contact.email_stats.last_outbound_subject;
          const cc = fmtCc(contact.email_stats.last_outbound_cc_names);
          const subParts = [subj && `"${subj}"`, cc].filter(Boolean).join(' · ');
          entries.push({
            id: 'eout',
            kind: 'outbound',
            date: new Date(contact.email_stats.last_outbound_at),
            title: `You emailed ${firstName}`,
            sub: subParts || `${contact.email_stats.emails_sent} sent in total`,
          });
        }
        entries.sort((a, b) => b.date.getTime() - a.date.getTime());
        const dotStyle = (k: Entry['kind']): { bg: string; border: string } => {
          switch (k) {
            case 'meeting':  return { bg: 'var(--accent)',          border: 'var(--accent)' };
            case 'inbound':  return { bg: 'var(--teal, #06b6d4)',   border: 'var(--teal, #06b6d4)' };
            case 'outbound': return { bg: 'var(--bg-surface)',      border: 'var(--teal, #06b6d4)' };
            case 'upcoming': return { bg: 'var(--bg-surface)',      border: 'var(--accent)' };
            case 'task':     return { bg: 'var(--bg-surface)',      border: 'var(--gold, #f5c542)' };
          }
        };
        const kindLabel: Record<Entry['kind'], string> = {
          meeting: 'Meeting', inbound: 'Inbound', outbound: 'Sent', upcoming: 'Upcoming', task: 'To send',
        };
        const fmtAgo = (d: Date) => {
          const days = differenceInDays(now, d);
          if (days < -1) return `in ${-days} days`;
          if (days === -1) return 'tomorrow';
          if (days === 0) return 'today';
          if (days === 1) return '1 day ago';
          if (days < 30) return `${days} days ago`;
          return format(d, 'MMM d, yyyy');
        };

        return (
          <>
            {/* SUMMARY */}
            {(summaryText || synth?.common_topics?.length) && (
              <section className="px-5 py-5 border-b border-[var(--border)]">
                <div className="text-[11px] uppercase tracking-[0.1em] text-[var(--text-secondary)]/80 mb-2.5">Summary</div>
                {summaryText && (
                  <p className="text-[13px] text-[var(--text-primary)] leading-relaxed">{summaryText}</p>
                )}
                {synth?.common_topics && synth.common_topics.length > 0 && (
                  <p className="mt-2 text-[12px] text-[var(--text-secondary)]">
                    Common ground: <span className="text-[var(--text-primary)]/80 capitalize">{synth.common_topics.slice(0, 4).join(' · ')}</span>
                  </p>
                )}
              </section>
            )}

            {/* YOUR NOTES — free-form prose you wrote, fully editable */}
            <section className="px-5 py-5 border-b border-[var(--border)]">
              <div className="text-[11px] uppercase tracking-[0.1em] text-[var(--text-secondary)]/80 mb-2.5">Your notes</div>
              <textarea
                value={localNotes}
                onChange={(e) => {
                  const val = e.target.value;
                  setLocalNotes(val);
                  isTypingRef.current = true;
                  try { localStorage.setItem(`notes-backup-${contact.id}`, val); } catch {}
                  if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
                  notesTimerRef.current = setTimeout(async () => {
                    const { error } = await supabase.from('contacts').update({ notes: val }).eq('id', contact.id);
                    isTypingRef.current = false;
                    if (error) { console.error('Notes autosave failed', error); addToast({ message: `Save failed — kept in browser backup. ${error.message}`, type: 'error' }); }
                    else { try { localStorage.removeItem(`notes-backup-${contact.id}`); } catch {} }
                  }, 1000);
                }}
                onBlur={async () => {
                  if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
                  const { error } = await supabase.from('contacts').update({ notes: localNotes }).eq('id', contact.id);
                  isTypingRef.current = false;
                  if (error) { console.error('Notes save failed', error); addToast({ message: `Save failed — kept in browser backup. ${error.message}`, type: 'error' }); }
                  else { try { localStorage.removeItem(`notes-backup-${contact.id}`); } catch {} }
                }}
                placeholder="Type or dictate notes about this person…"
                className="w-full bg-transparent text-[13px] leading-relaxed placeholder:text-[var(--text-secondary)]/40 focus:outline-none resize-y min-h-[88px]"
              />
              {proseNote && proseNote !== localNotes && (
                <p className="text-[10.5px] text-[var(--text-secondary)]/50 mt-1">Synced.</p>
              )}
            </section>

            {/* UPCOMING TO-DO */}
            <section className="px-5 py-5 border-b border-[var(--border)]">
              <div className="flex items-baseline justify-between mb-2.5">
                <div className="text-[11px] uppercase tracking-[0.1em] text-[var(--text-secondary)]/80">To-do</div>
                {openTasks.length > 0 && (
                  <span className="text-[11px] text-[var(--text-secondary)]/60 tabular-nums">{openTasks.length} open</span>
                )}
              </div>
              {openTasks.length === 0 ? (
                <p className="text-[12px] text-[var(--text-secondary)]/50">No open items.</p>
              ) : (
                <div className="space-y-1.5">
                  {openTasks.slice(0, 8).map((task) => (
                    <div key={task.id} className="flex items-start gap-2.5 group">
                      <button onClick={() => { toggleTask(task.id, true); addToast({ message: `Done: ${task.title}`, type: 'success', icon: 'task' }); }}
                        className="mt-[3px] w-3.5 h-3.5 rounded-sm border border-[var(--text-secondary)]/40 hover:border-[var(--accent)] transition-colors flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] leading-snug">{task.title}</p>
                        {task.due_date && (
                          <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">{format(new Date(task.due_date + 'T12:00:00'), 'MMM d')}</p>
                        )}
                      </div>
                      <button onClick={() => deleteTask(task.id)} className="opacity-0 group-hover:opacity-50 hover:!opacity-100 text-[var(--text-secondary)] hover:text-red-400 transition-all text-[12px] leading-none">×</button>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => setShowAddTaskInline(!showAddTaskInline)}
                className="mt-3 px-3 py-1.5 rounded-md text-[12px] font-medium border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)]/40 hover:bg-[var(--hover-bg)] transition-colors">
                + Add task
              </button>
              <AnimatePresence>
                {showAddTaskInline && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden mt-2 flex items-center gap-2">
                    <input value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && newTaskTitle.trim()) { handleAddTask(); setShowAddTaskInline(false); } if (e.key === 'Escape') { setShowAddTaskInline(false); setNewTaskTitle(''); } }}
                      placeholder="What needs doing?"
                      className="flex-1 bg-[var(--input-bg)] border border-[var(--border)] rounded-md px-3 py-1.5 text-[12px] focus:outline-none focus:border-[var(--accent)]/40 transition-colors" autoFocus />
                    <input type="date" value={newTaskDue} onChange={(e) => setNewTaskDue(e.target.value)}
                      className="bg-[var(--input-bg)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[11px] focus:outline-none focus:border-[var(--accent)]/40" />
                    <button
                      onClick={() => { if (newTaskTitle.trim()) { handleAddTask(); setShowAddTaskInline(false); } }}
                      disabled={!newTaskTitle.trim()}
                      title="Add task"
                      className="w-7 h-7 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-light)] disabled:opacity-30 disabled:cursor-not-allowed text-white text-[14px] leading-none flex items-center justify-center transition-colors">
                      ✓
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>

            {/* TIMELINE — merged events, color-coded dots, always renders */}
            <section className="px-5 py-5">
              <div className="flex items-baseline justify-between mb-3">
                <div className="text-[11px] uppercase tracking-[0.1em] text-[var(--text-secondary)]/80">Timeline</div>
                {entries.length > 0 && (
                  <span className="text-[11px] text-[var(--text-secondary)]/60 tabular-nums">{entries.length}</span>
                )}
              </div>
              {/* Legend (only when there are entries, otherwise pointless) */}
              {entries.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 mb-4 text-[10.5px] text-[var(--text-secondary)]/70">
                  {(['meeting','inbound','outbound','upcoming','task'] as Entry['kind'][]).map((k) => {
                    if (!entries.some((e) => e.kind === k)) return null;
                    const s = dotStyle(k);
                    return (
                      <span key={k} className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.bg, border: `1.5px solid ${s.border}` }} />
                        {kindLabel[k]}
                      </span>
                    );
                  })}
                </div>
              )}
              {entries.length === 0 ? (
                <p className="text-[12px] text-[var(--text-secondary)]/50">Nothing yet — meetings, emails, and reminders will land here.</p>
              ) : (
                <div className="relative">
                  <div className="absolute left-[5px] top-1 bottom-1 w-px bg-[var(--border)]" />
                  <div className="space-y-4">
                    {entries.slice(0, 12).map((en) => {
                      const s = dotStyle(en.kind);
                      return (
                        <div key={en.id} className="relative pl-5">
                          <div className="absolute left-0 top-1.5 w-[11px] h-[11px] rounded-full" style={{ backgroundColor: s.bg, border: `1.5px solid ${s.border}` }} />
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-[12.5px] text-[var(--text-primary)] leading-tight truncate">{en.title}</span>
                            <span className="text-[11px] text-[var(--text-secondary)] flex-shrink-0">{fmtAgo(en.date)}</span>
                          </div>
                          {en.sub && (
                            <div className="mt-1 text-[12px] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words">
                              {en.sub.length > 240 ? en.sub.slice(0, 240) + '…' : en.sub}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            {/* CONNECTIONS — mutual contacts in your network */}
            <section className="px-5 py-5 border-t border-[var(--border)]">
              <div className="flex items-baseline justify-between mb-3">
                <div className="text-[11px] uppercase tracking-[0.1em] text-[var(--text-secondary)]/80">Connections</div>
                {connections.length > 0 && (
                  <span className="text-[11px] text-[var(--text-secondary)]/60 tabular-nums">{connections.length}</span>
                )}
              </div>
              {connections.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-[12px] text-[var(--text-secondary)]/50">No connections linked yet.</p>
                  <button onClick={() => setShowConnectPicker(true)}
                    className="px-3 py-1.5 rounded-md text-[12px] font-medium border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)]/40 hover:bg-[var(--hover-bg)] transition-colors">
                    + Add connection
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  {connections.slice(0, 8).map((conn) => (
                    <div key={conn.id} className="group flex items-center gap-3 py-1.5 px-1 rounded-md hover:bg-[var(--hover-bg)] transition-colors">
                      <button onClick={() => setSelectedContact(conn.id)}
                        className="flex items-center gap-3 flex-1 min-w-0 text-left">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium overflow-hidden border border-[var(--border)] flex-shrink-0">
                          {conn.photo ? <img src={conn.photo} alt="" className="w-7 h-7 object-cover" /> : (conn.name.charAt(0) || '?').toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[12.5px] text-[var(--text-primary)] truncate">{displayName(conn.name)}</p>
                          {(conn.company || conn.role) && (
                            <p className="text-[11px] text-[var(--text-secondary)] truncate">
                              {[conn.role, conn.company].filter(Boolean).join(' · ')}
                            </p>
                          )}
                        </div>
                      </button>
                      <button onClick={() => removeConnection(contact.id, conn.id)}
                        className="opacity-0 group-hover:opacity-40 hover:!opacity-100 text-[var(--text-secondary)] hover:text-red-400 transition-all text-[12px] leading-none px-1">×</button>
                    </div>
                  ))}
                  {connections.length > 8 && (
                    <p className="text-[10.5px] text-[var(--text-secondary)]/60 pl-1 pt-1">+ {connections.length - 8} more</p>
                  )}
                  <button onClick={() => setShowConnectPicker(!showConnectPicker)}
                    className="mt-2 px-3 py-1.5 rounded-md text-[12px] font-medium border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)]/40 hover:bg-[var(--hover-bg)] transition-colors">
                    + Add connection
                  </button>
                </div>
              )}
              {/* Picker — searchable inline list, with create-new fallback */}
              <AnimatePresence>
                {showConnectPicker && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden mt-3 border border-[var(--border)] rounded-lg">
                    <input value={connectSearch} onChange={(e) => setConnectSearch(e.target.value)}
                      placeholder="Search or type a name to create…"
                      className="w-full bg-transparent border-b border-[var(--border)] px-3 py-2 text-[12px] focus:outline-none" autoFocus />
                    {(() => {
                      const q = connectSearch.trim().toLowerCase();
                      const matches = contacts
                        .filter((c) => c.id !== contact.id && !contact.connections.includes(c.id) && !c.is_self
                          && (!q || c.name.toLowerCase().includes(q)))
                        .slice(0, 12);
                      // Show "create new" when there's a search term AND no exact-name match
                      const exactExists = q && contacts.some((c) => c.name.toLowerCase().trim() === q);
                      const showCreate = q.length >= 2 && !exactExists;
                      return (
                        <div className="max-h-48 overflow-y-auto">
                          {matches.map((c) => (
                            <button key={c.id}
                              onClick={async () => {
                                await addConnection(contact.id, c.id);
                                await addConnection(c.id, contact.id);
                                setConnectSearch('');
                                addToast({ message: `Linked ${c.name}`, type: 'success' });
                              }}
                              className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-[12px] hover:bg-[var(--hover-bg)] transition-colors">
                              <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium border border-[var(--border)] overflow-hidden flex-shrink-0">
                                {c.photo ? <img src={c.photo} alt="" className="w-5 h-5 object-cover" /> : (c.name.charAt(0) || '?').toUpperCase()}
                              </div>
                              <span className="truncate">{displayName(c.name)}</span>
                              {c.company && <span className="text-[var(--text-secondary)]/70 truncate">· {c.company}</span>}
                            </button>
                          ))}
                          {showCreate && (
                            <button
                              onClick={async () => {
                                const newName = connectSearch.trim();
                                await addContact({ name: newName, is_direct: true, is_promoted: true });
                                // Find the just-created contact (latest with matching name)
                                const fresh = useCrmStore.getState().contacts.find((c) => c.name === newName && c.id !== contact.id);
                                if (fresh) {
                                  await addConnection(contact.id, fresh.id);
                                  await addConnection(fresh.id, contact.id);
                                  addToast({ message: `Created and linked ${newName}`, type: 'success' });
                                }
                                setConnectSearch('');
                              }}
                              className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-[12px] hover:bg-[var(--accent)]/8 text-[var(--accent)] transition-colors border-t border-[var(--border)]/50">
                              <span className="w-5 h-5 rounded-full border border-[var(--accent)]/40 flex items-center justify-center text-[12px] leading-none flex-shrink-0">+</span>
                              <span className="truncate">Create and link <span className="font-medium">"{connectSearch.trim()}"</span></span>
                            </button>
                          )}
                          {matches.length === 0 && !showCreate && (
                            <p className="text-[11.5px] text-[var(--text-secondary)]/60 text-center py-3">Start typing a name…</p>
                          )}
                        </div>
                      );
                    })()}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </>
        );
      })()}

        <div className="px-5 pt-6 pb-24 md:pb-8 border-t border-[var(--border)]">


          {/* ── Merge + Delete ── */}
          <div className="pt-2 space-y-3">
            <div>
              <button onClick={() => setShowMergePicker(!showMergePicker)}
                className="w-full px-3 py-2 rounded-md text-[12.5px] font-medium border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)]/40 hover:bg-[var(--hover-bg)] transition-colors">
                Merge with another contact
              </button>
              {showMergePicker && (
                <div className="mt-2 border border-[var(--border)] rounded-lg overflow-hidden">
                  <input value={mergeSearch} onChange={(e) => setMergeSearch(e.target.value)}
                    placeholder="Search contact to merge..."
                    className="w-full bg-transparent border-b border-[var(--border)] px-3 py-2 text-xs focus:outline-none" autoFocus />
                  <div className="max-h-32 overflow-y-auto">
                    {contacts
                      .filter((c) => c.id !== contact.id && (!mergeSearch.trim() || c.name.toLowerCase().includes(mergeSearch.toLowerCase())))
                      .slice(0, 6)
                      .map((c) => (
                        <button key={c.id} onClick={async () => {
                          const ok = await confirm({
                            title: `Merge ${c.name} into ${contact.name}?`,
                            description: 'Their notes, tasks, and connections will be combined into this contact.',
                            confirmLabel: 'Merge',
                          });
                          if (ok) {
                            await mergeContacts(contact.id, c.id);
                            addToast({ message: `Merged ${c.name} into ${contact.name}`, type: 'success', icon: 'contact' });
                            setShowMergePicker(false);
                            setMergeSearch('');
                          }
                        }} className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--hover-bg)] transition-colors flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color || '#06b6d4' }} />
                          {c.name}
                          {c.company && <span className="text-[var(--text-secondary)]">· {c.company}</span>}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
            <button onClick={async () => {
              const ok = await confirm({
                title: `Delete ${contact.name}?`,
                description: 'This removes the contact, their tasks, and all connections. This cannot be undone.',
                confirmLabel: 'Delete',
                destructive: true,
              });
              if (ok) {
                try {
                  await deleteWithPop(contact.id);
                  addToast({ message: `Deleted ${contact.name}`, type: 'info', icon: 'delete' });
                } catch (e: any) {
                  addToast({ message: `Delete failed: ${e?.message || 'try again'}`, type: 'error' });
                }
              }
            }}
              className="w-full px-3 py-2 rounded-md text-[12.5px] font-medium border border-[var(--border)] text-[var(--text-secondary)] hover:border-red-400/50 hover:bg-red-500/8 hover:text-red-400 transition-colors">
              Delete contact
            </button>
          </div>
        </div>
      </div>
  );

  const photoModal = (
    <AnimatePresence>
      {pendingPhotoSrc && (
        <PhotoCropModal
          src={pendingPhotoSrc}
          onCancel={() => setPendingPhotoSrc(null)}
          onSave={(dataUrl) => {
            updateContact(contact.id, { photo: dataUrl });
            setPendingPhotoSrc(null);
          }}
        />
      )}
    </AnimatePresence>
  );

  if (inline) return <>{content}{photoModal}</>;

  return (
    <>
      <AnimatePresence>
        <motion.div
          key={contact.id}
          initial={{ x: 400, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 400, opacity: 0 }}
          transition={{ type: 'spring', damping: 28, stiffness: 220 }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
      {photoModal}
    </>
  );
}

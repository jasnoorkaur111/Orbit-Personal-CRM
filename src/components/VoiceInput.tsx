'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Send, X, Loader2, Calendar, ChevronDown, MessageCircle, FileText, Trash2, FolderOpen } from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import { useToastStore } from '@/components/Toast';
import { supabase } from '@/lib/supabase';
import { format, isToday, isTomorrow, isYesterday, parseISO } from 'date-fns';

type InputMode = 'event' | 'impromptu';

interface Draft {
  id: string;
  text: string;
  mode: InputMode;
  createdAt: string;
}

const DRAFT_KEY = 'crm-voice-drafts';
const ACTIVE_DRAFT_KEY = 'crm-voice-active';

function loadDrafts(): Draft[] {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]'); } catch { return []; }
}
function saveDrafts(drafts: Draft[]) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
}
function loadActiveDraft(): { text: string; mode: InputMode } | null {
  try {
    const saved = localStorage.getItem(ACTIVE_DRAFT_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch { return null; }
}
function saveActiveDraft(text: string, mode: InputMode) {
  if (text.trim()) {
    localStorage.setItem(ACTIVE_DRAFT_KEY, JSON.stringify({ text, mode }));
  } else {
    localStorage.removeItem(ACTIVE_DRAFT_KEY);
  }
}
function clearActiveDraft() {
  localStorage.removeItem(ACTIVE_DRAFT_KEY);
}

export default function VoiceInput() {
  const [isListening, setIsListening] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [interimText, setInterimText] = useState('');
  const [processing, setProcessing] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('impromptu');
  const [showEventPicker, setShowEventPicker] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<any>(null);
  const [eventSearch, setEventSearch] = useState('');
  // When the user clicks the mic icon on a project in the sidebar, we scope
  // the voice note to that project — the parser adds it to the prompt as
  // context, so Gemini will assign the contact + tasks to this project.
  const [scopedProject, setScopedProject] = useState<{ id: string; name: string } | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [showDrafts, setShowDrafts] = useState(true);
  const recognitionRef = useRef<any>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const committedTextRef = useRef('');
  const recordingStartedAt = useRef<string | null>(null);
  const processedResultsRef = useRef(0);
  const { contacts, events, projects, addContact, addTask, addConnection, addEvent, updateContact, fetchAll, addProject, addContactToProject, setSelectedContact } = useCrmStore();
  const addToast = useToastStore((s) => s.addToast);

  // Get recent/upcoming events for picker
  const today = new Date();
  const recentEvents = events
    .filter((e) => {
      const eventDate = new Date(e.date + 'T12:00:00');
      const daysDiff = (today.getTime() - eventDate.getTime()) / (1000 * 60 * 60 * 24);
      return daysDiff >= -7 && daysDiff <= 2;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 20);

  const formatEventDate = (dateStr: string) => {
    const date = parseISO(dateStr);
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    if (isTomorrow(date)) return 'Tomorrow';
    return format(date, 'EEE, MMM d');
  };

  // Listen for "open-voice-for-project" event (sidebar mic icon on a project).
  // Pre-scopes the voice note so the parsed contact + tasks land on that project.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.projectId && detail.projectName) {
        setScopedProject({ id: detail.projectId, name: detail.projectName });
      }
      setIsExpanded(true);
      setInputMode('impromptu');
    };
    window.addEventListener('open-voice-for-project', onOpen);
    return () => window.removeEventListener('open-voice-for-project', onOpen);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (event: any) => {
          let newFinal = '';
          let interim = '';
          // Only process results we haven't seen yet
          for (let i = processedResultsRef.current; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              newFinal += event.results[i][0].transcript;
              processedResultsRef.current = i + 1;
            } else {
              interim += event.results[i][0].transcript;
            }
          }
          // Commit only NEW final words with auto-punctuation
          if (newFinal) {
            let text = newFinal.trim();
            const base = committedTextRef.current;

            // Dedup: skip if this text is already at the end of committed text
            if (base.length > 0 && text.length > 10 && base.toLowerCase().endsWith(text.toLowerCase())) return;

            // Capitalize first letter if starting fresh or after a period
            if (base.length === 0 || /[.!?]\s*$/.test(base)) {
              text = text.charAt(0).toUpperCase() + text.slice(1);
            }

            // Add period if the chunk seems like a complete thought
            // (ends without punctuation and has 4+ words)
            const wordCount = text.split(/\s+/).length;
            if (wordCount >= 4 && !/[.!?,;:]$/.test(text)) {
              text += '.';
            }

            // Capitalize common sentence starters after periods within the text
            text = text.replace(/([.!?])\s+([a-z])/g, (_, p, c) => `${p} ${c.toUpperCase()}`);

            // Capitalize "I" as standalone word
            text = text.replace(/\bi\b/g, 'I');

            const needsSpace = base.length > 0 && !base.endsWith(' ') && !base.endsWith('\n');
            committedTextRef.current = base + (needsSpace ? ' ' : '') + text;
            setTextInput(committedTextRef.current);
          }
          // Show interim (in-progress) words live
          setInterimText(interim);
        };

        recognition.onerror = (e: any) => {
          // Recoverable: silence / network blip / aborted — keep going if we still want to
          const fatal = e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture';
          if (fatal) {
            if (recognitionRef.current) recognitionRef.current._shouldBeListening = false;
            setIsListening(false);
          }
          // Non-fatal: don't flip isListening; onend will re-arm.
        };
        recognition.onend = () => {
          // Chrome auto-stops after silence / ~60s. If we still want to be
          // recording, restart immediately. Exponential backoff if start() throws.
          if (!recognitionRef.current?._shouldBeListening) {
            setIsListening(false);
            return;
          }
          const attempt = (recognitionRef.current?._restartAttempts || 0);
          const delay = Math.min(2000, 50 * Math.pow(2, attempt));
          setTimeout(() => {
            if (!recognitionRef.current?._shouldBeListening) return;
            try {
              processedResultsRef.current = 0;
              recognition.start();
              if (recognitionRef.current) recognitionRef.current._restartAttempts = 0;
            } catch {
              if (recognitionRef.current) recognitionRef.current._restartAttempts = attempt + 1;
              if (attempt > 6) setIsListening(false);   // give up after ~5s of retries
            }
          }, delay);
        };
        recognitionRef.current = recognition;
      }
    }
  }, []);

  // Restore active draft and load saved drafts on mount
  useEffect(() => {
    setDrafts(loadDrafts());
    const active = loadActiveDraft();
    if (active && active.text.trim()) {
      setTextInput(active.text);
      committedTextRef.current = active.text;
      setInputMode(active.mode);
      setIsExpanded(true);
    }
  }, []);

  // Auto-save active text to localStorage (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      saveActiveDraft(textInput, inputMode);
    }, 500);
    return () => clearTimeout(timer);
  }, [textInput, inputMode]);

  // Listen for external trigger (mobile tab bar mic button)
  useEffect(() => {
    const handler = () => {
      setIsExpanded(true);
      recordingStartedAt.current = new Date().toISOString();
      toggleListening();
    };
    window.addEventListener('open-voice-input', handler);
    return () => window.removeEventListener('open-voice-input', handler);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }, [textInput, interimText]);

  const toggleListening = () => {
    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current._shouldBeListening = false;
        recognitionRef.current._restartAttempts = 0;
      }
      recognitionRef.current?.stop();
      setIsListening(false);
      (window as any).__voiceRecording = false;
      // Commit any remaining interim text
      if (interimText) {
        const base = committedTextRef.current;
        const needsSpace = base.length > 0 && !base.endsWith(' ');
        committedTextRef.current = base + (needsSpace ? ' ' : '') + interimText;
        setTextInput(committedTextRef.current);
        setInterimText('');
      }
    } else {
      // Sync ref with current textarea content before starting
      committedTextRef.current = textInput;
      setInterimText('');
      processedResultsRef.current = 0;
      if (!recordingStartedAt.current) recordingStartedAt.current = new Date().toISOString();
      if (recognitionRef.current) {
        recognitionRef.current._shouldBeListening = true;
        recognitionRef.current._restartAttempts = 0;
      }
      recognitionRef.current?.start();
      setIsListening(true);
      setIsExpanded(true);
      // Global flag so the auto-sync loop in page.tsx skips fetchAll while
      // user is actively dictating — re-renders interrupt the speech stream.
      (window as any).__voiceRecording = true;
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  };

  // beforeunload guard — refresh / close during dictation = lost text
  useEffect(() => {
    if (!isListening && !textInput.trim()) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isListening, textInput]);

  const processInput = async () => {
    if (!textInput.trim() || processing) return;
    setProcessing(true);

    try {
      // Stop listening if still going. CRITICAL: clear `_shouldBeListening`
      // BEFORE calling stop(), otherwise `onend` immediately restarts the
      // mic (line 169-189) — that auto-restart caused a render storm that
      // kept the expanded panel from closing post-Parse.
      if (isListening) {
        if (recognitionRef.current) {
          recognitionRef.current._shouldBeListening = false;
          recognitionRef.current._restartAttempts = 0;
        }
        recognitionRef.current?.stop();
        setIsListening(false);
      }
      // Re-enable the page-level auto-sync loop (page.tsx safeSync bails
      // while this flag is set so it doesn't interrupt the speech stream).
      (window as any).__voiceRecording = false;

      // Include event context if one is selected, and/or project scope if the
      // mic was opened from a sidebar project.
      const ctxBits: string[] = [];
      if (selectedEvent) ctxBits.push(`This is about a calendar event "${selectedEvent.title}" on ${selectedEvent.date}${selectedEvent.time ? ' at ' + selectedEvent.time : ''}`);
      if (scopedProject) ctxBits.push(`This voice note belongs to the project "${scopedProject.name}" — assign the contact and any tasks to that project`);
      const contextText = ctxBits.length
        ? `[Context: ${ctxBits.join('. ')}] ${textInput}`
        : textInput;

      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/parse-voice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token || ''}`,
        },
        body: JSON.stringify({
          text: contextText,
          existingContacts: contacts,
          existingProjects: projects.filter((p) => p.status === 'active'),
          existingTags: [...new Set(contacts.flatMap((c) => c.tags || []))],
          isImpromptu: inputMode === 'impromptu',
          recordedAt: recordingStartedAt.current,
        }),
      });

      const parsed = await res.json();

      if (!res.ok || parsed.error) {
        const msg = parsed.error || `Parse failed (HTTP ${res.status})`;
        console.error('Parse error:', msg);
        addToast({ message: msg, type: 'error' });
        return;
      }

      // Match to an existing contact — try in order of confidence:
      //   1. LLM's explicit `matchedExistingContact` (it had the full list)
      //   2. Exact case-insensitive name match
      //   3. Substring match (LLM said "Liz", contact is "Liz Mallen")
      //   4. First-name + only-one-match (avoid wrong-Sarah merges)
      const parsedNameLower = (parsed.name || '').toLowerCase().trim();
      const matchedNameLower = (parsed.matchedExistingContact || '').toLowerCase().trim();
      let existingContact = null as typeof contacts[number] | null | undefined;
      if (matchedNameLower) {
        existingContact = contacts.find((c) => c.name.toLowerCase() === matchedNameLower);
      }
      if (!existingContact && parsedNameLower) {
        existingContact = contacts.find((c) => c.name.toLowerCase() === parsedNameLower);
      }
      if (!existingContact && parsedNameLower) {
        const subs = contacts.filter((c) => {
          const n = c.name.toLowerCase();
          return n.includes(parsedNameLower) || parsedNameLower.includes(n);
        });
        if (subs.length === 1) existingContact = subs[0];
      }
      if (!existingContact && parsedNameLower) {
        const firstWord = parsedNameLower.split(/\s+/)[0];
        if (firstWord.length >= 3) {
          const firstMatches = contacts.filter((c) => c.name.toLowerCase().split(/\s+/)[0] === firstWord);
          if (firstMatches.length === 1) existingContact = firstMatches[0];
        }
      }

      if (existingContact) {
        const updatedNotes = existingContact.notes
          ? `${existingContact.notes}\n\n[${format(new Date(), 'MMM d')}] ${parsed.notes || textInput}`
          : parsed.notes || textInput;
        // Merge tags (deduplicated)
        const existingTags = existingContact.tags || [];
        const newTags = parsed.tags || [];
        const mergedTags = [...new Set([...existingTags, ...newTags])];
        await updateContact(existingContact.id, { notes: updatedNotes, tags: mergedTags });

        // Resolve project_id once for this voice note. scopedProject
        // (sidebar-opened-from-project) wins; otherwise fall back to any
        // project Gemini parsed out of the transcript.
        const resolvedProjectId =
          scopedProject?.id ||
          (parsed.project
            ? projects.find((p) => p.name.toLowerCase() === parsed.project.toLowerCase())?.id
            : undefined);

        for (const task of parsed.tasks || []) {
          await addTask({
            contact_id: existingContact.id,
            title: task.title,
            type: task.type || 'other',
            due_date: task.dueDate || undefined,
            project_id: resolvedProjectId,
          });
        }

        for (const connName of parsed.connections || []) {
          const connContact = contacts.find(
            (c) => c.name.toLowerCase() === connName.toLowerCase()
          );
          if (connContact && !existingContact.connections.includes(connContact.id)) {
            await addConnection(existingContact.id, connContact.id);
            await addConnection(connContact.id, existingContact.id);
          }
        }
      } else {
        await addContact({
          name: parsed.name || 'New Contact',
          company: parsed.company || undefined,
          role: parsed.role || undefined,
          email: parsed.email || undefined,
          phone: parsed.phone || undefined,
          linkedin: parsed.linkedin || undefined,
          notes: parsed.notes || textInput,
          tags: parsed.tags || [],
          is_direct: true,
        });

        await fetchAll();
        const { contacts: updatedContacts } = useCrmStore.getState();
        const newContact = updatedContacts.find(
          (c) => c.name.toLowerCase() === (parsed.name || '').toLowerCase()
        );

        if (newContact) {
          // Same project resolution as the existing-contact branch — we
          // either have an explicit scopedProject or one parsed out by Gemini.
          // The actual addContactToProject call still happens later in the
          // project-assignment block; this just wires up the task linkage.
          const resolvedProjectId =
            scopedProject?.id ||
            (parsed.project
              ? useCrmStore.getState().projects.find((p) => p.name.toLowerCase() === parsed.project.toLowerCase())?.id
              : undefined);

          for (const task of parsed.tasks || []) {
            await addTask({
              contact_id: newContact.id,
              title: task.title,
              type: task.type || 'other',
              due_date: task.dueDate || undefined,
              project_id: resolvedProjectId,
            } as any);
          }

          for (const connName of parsed.connections || []) {
            const existing = contacts.find(
              (c) => c.name.toLowerCase() === connName.toLowerCase()
            );
            if (existing) {
              await addConnection(newContact.id, existing.id);
              await addConnection(existing.id, newContact.id);
            }
          }
        }
      }

      // Assign to project if mentioned
      if (parsed.project) {
        const contactForProject = existingContact
          || useCrmStore.getState().contacts.find((c) => c.name.toLowerCase() === (parsed.name || '').toLowerCase());
        if (contactForProject) {
          let project = projects.find((p) => p.name.toLowerCase() === parsed.project.toLowerCase());
          if (!project) {
            await addProject({ name: parsed.project });
            project = useCrmStore.getState().projects.find((p) => p.name.toLowerCase() === parsed.project.toLowerCase());
          }
          if (project && !project.contactIds.includes(contactForProject.id)) {
            await addContactToProject(project.id, contactForProject.id);
          }
        }
      }

      // Create calendar event for impromptu conversations
      if (inputMode === 'impromptu' && parsed.interaction) {
        const contactForEvent = existingContact
          || useCrmStore.getState().contacts.find((c) => c.name.toLowerCase() === (parsed.name || '').toLowerCase());
        await addEvent({
          title: parsed.interaction.title || `Chat — ${parsed.name}`,
          date: parsed.interaction.date || new Date().toISOString().split('T')[0],
          time: parsed.interaction.time || new Date().toTimeString().slice(0, 5),
          contact_id: contactForEvent?.id || undefined,
          description: parsed.notes || undefined,
          source: 'interaction',
        });
      }

      // Toast confirmation
      const taskCount = (parsed.tasks || []).length;
      const connCount = (parsed.connections || []).filter((n: string) =>
        contacts.some((c) => c.name.toLowerCase() === n.toLowerCase())
      ).length;
      const details = [
        taskCount && `${taskCount} task${taskCount > 1 ? 's' : ''}`,
        connCount && `${connCount} link${connCount > 1 ? 's' : ''}`,
        inputMode === 'impromptu' && parsed.interaction && 'logged to calendar',
      ].filter(Boolean);
      addToast({
        message: `${existingContact ? 'Updated' : 'Added'} ${parsed.name}${details.length ? ' · ' + details.join(', ') : ''}`,
        type: 'success',
        icon: inputMode === 'impromptu' ? 'voice' : 'contact',
      });

      setTextInput('');
      committedTextRef.current = '';
      setSelectedEvent(null);
      setScopedProject(null);
      setIsExpanded(false);
      recordingStartedAt.current = null;
      clearActiveDraft();
      await fetchAll();
      // Auto-open the affected contact in the side panel so the user sees
      // the note they just dictated + any parsed tasks/connections live.
      // The graph also highlights this contact's path because the panel's
      // selectedContactId drives the graph's selection state.
      const targetId =
        existingContact?.id ||
        useCrmStore.getState().contacts.find((c) => c.name.toLowerCase() === (parsed.name || '').toLowerCase())?.id ||
        null;
      if (targetId) setSelectedContact(targetId);
    } catch (err) {
      console.error('Process error:', err);
      addToast({ message: 'Something went wrong — try again', type: 'error' });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="fixed bottom-[calc(60px+env(safe-area-inset-bottom,0px))] md:bottom-6 left-1/2 -translate-x-1/2 z-50 w-full md:w-auto flex flex-col items-center px-4 md:px-0">
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="glass-elevated rounded-2xl p-3 md:p-4 mb-4 w-full md:w-[540px] max-w-[90vw] gradient-border"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-[var(--text-secondary)]">
                {isListening ? '🔴 Recording — speak and edit below' : processing ? 'Parsing your input...' : 'Add to your network'}
              </span>
              <button
                onClick={() => {
                  // Auto-save as draft if there's text
                  if (textInput.trim()) {
                    const newDraft: Draft = {
                      id: Date.now().toString(36),
                      text: textInput.trim(),
                      mode: inputMode,
                      createdAt: new Date().toISOString(),
                    };
                    const updated = [newDraft, ...loadDrafts()].slice(0, 20);
                    saveDrafts(updated);
                    setDrafts(updated);
                    addToast({ message: 'Saved to drafts', type: 'info', icon: 'voice' });
                  }
                  setIsExpanded(false);
                  setTextInput('');
                  committedTextRef.current = '';
                  setSelectedEvent(null);
                  clearActiveDraft();
                  if (isListening) { recognitionRef.current?.stop(); setIsListening(false); }
                }}
                className="p-2 hover:bg-[var(--hover-bg)] rounded-lg transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Mode Toggle */}
            <div className="mb-3 flex gap-2">
              <button
                onClick={() => { setInputMode('impromptu'); setSelectedEvent(null); setShowEventPicker(false); }}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all btn-press shimmer-hover ${
                  inputMode === 'impromptu'
                    ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/25 text-[var(--text-primary)]'
                    : 'bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/15'
                }`}
              >
                <MessageCircle size={13} />
                Log conversation
              </button>
              <button
                onClick={() => setInputMode('event')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all btn-press shimmer-hover ${
                  inputMode === 'event'
                    ? 'bg-[var(--accent)]/15 border border-[var(--accent)]/40 text-[var(--accent-light)]'
                    : 'bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30'
                }`}
              >
                <Calendar size={13} />
                Link to event
              </button>
            </div>

            {/* Drafts */}
            {drafts.length > 0 && (
              <div className="mb-3">
                <button
                  onClick={() => setShowDrafts(!showDrafts)}
                  className={`flex items-center gap-1.5 text-xs transition-colors ${
                    showDrafts ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <FileText size={12} />
                  {drafts.length} draft{drafts.length > 1 ? 's' : ''}
                  <ChevronDown size={12} className={`transition-transform ${showDrafts ? 'rotate-180' : ''}`} />
                </button>

                <AnimatePresence>
                  {showDrafts && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-2 space-y-1.5 max-h-40 overflow-y-auto"
                    >
                      {drafts.map((draft) => (
                        <div
                          key={draft.id}
                          className="flex items-center gap-2 bg-[var(--input-bg)] rounded-lg p-2.5 group"
                        >
                          <button
                            onClick={() => {
                              setTextInput(draft.text);
                              committedTextRef.current = draft.text;
                              setInputMode(draft.mode);
                              // Remove from drafts
                              const updated = drafts.filter((d) => d.id !== draft.id);
                              saveDrafts(updated);
                              setDrafts(updated);
                              setShowDrafts(false);
                            }}
                            className="flex-1 text-left min-w-0"
                          >
                            <p className="text-xs truncate">{draft.text}</p>
                            <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">
                              {format(new Date(draft.createdAt), 'MMM d, h:mm a')} · {draft.mode === 'impromptu' ? 'Conversation' : 'Event'}
                            </p>
                          </button>
                          <button
                            onClick={() => {
                              const updated = drafts.filter((d) => d.id !== draft.id);
                              saveDrafts(updated);
                              setDrafts(updated);
                            }}
                            className="p-1.5 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all flex-shrink-0"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* Scoped-project chip — shown when user clicked the mic on a sidebar project */}
            {scopedProject && (
              <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--accent)]/12 border border-[var(--accent)]/35 text-[var(--accent)] text-xs">
                <FolderOpen size={12} />
                <span className="flex-1 truncate font-medium">Project: {scopedProject.name}</span>
                <button
                  onClick={() => setScopedProject(null)}
                  className="text-[var(--accent)]/60 hover:text-[var(--accent)] transition-colors"
                  title="Remove project scope"
                >
                  <X size={11} />
                </button>
              </div>
            )}

            {/* Event Picker — only shown in event mode */}
            {inputMode === 'event' && <div className="mb-3">
              <button
                onClick={() => setShowEventPicker(!showEventPicker)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all ${
                  selectedEvent
                    ? 'bg-[var(--accent)]/15 border border-[var(--accent)]/40 text-[var(--accent-light)]'
                    : 'bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/30'
                }`}
              >
                <Calendar size={14} />
                {selectedEvent ? (
                  <span className="flex-1 text-left truncate">
                    {selectedEvent.title} — {formatEventDate(selectedEvent.date)}
                    {selectedEvent.time && ` at ${selectedEvent.time}`}
                  </span>
                ) : (
                  <span className="flex-1 text-left">Select a calendar event</span>
                )}
                <ChevronDown size={14} className={`transition-transform ${showEventPicker ? 'rotate-180' : ''}`} />
              </button>

              <AnimatePresence>
                {showEventPicker && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-2 bg-[var(--input-bg)] rounded-xl overflow-hidden"
                  >
                    {/* Search input */}
                    <div className="p-2 pb-0">
                      <input
                        value={eventSearch}
                        onChange={(e) => setEventSearch(e.target.value)}
                        placeholder="Search events..."
                        className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs
                                 focus:outline-none focus:border-[var(--accent)] transition-colors"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-52 overflow-y-auto p-2 space-y-1">
                      {selectedEvent && (
                        <button
                          onClick={() => { setSelectedEvent(null); setShowEventPicker(false); setEventSearch(''); }}
                          className="w-full text-left px-3 py-2 rounded-lg text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          ✕ Clear selection
                        </button>
                      )}
                      {(() => {
                        // If searching, search ALL events; otherwise show recent
                        const eventsToShow = eventSearch.trim()
                          ? events
                              .filter((e) => e.title.toLowerCase().includes(eventSearch.toLowerCase()))
                              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                              .slice(0, 30)
                          : recentEvents;

                        if (eventsToShow.length === 0) {
                          return (
                            <p className="text-xs text-[var(--text-secondary)] p-3 text-center">
                              {eventSearch ? 'No events found' : 'No recent events. Sync your calendar first.'}
                            </p>
                          );
                        }

                        return eventsToShow.map((event) => (
                          <button
                            key={event.id}
                            onClick={() => { setSelectedEvent(event); setShowEventPicker(false); setEventSearch(''); }}
                            className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                              selectedEvent?.id === event.id
                                ? 'bg-[var(--accent)]/20 text-[var(--accent-light)]'
                                : 'hover:bg-[var(--hover-bg)]'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm truncate flex-1">{event.title}</span>
                              <span className="text-[10px] text-[var(--text-secondary)] ml-2 flex-shrink-0">
                                {formatEventDate(event.date)}
                              </span>
                            </div>
                            {event.time && (
                              <span className="text-xs text-[var(--text-secondary)]">{event.time}</span>
                            )}
                          </button>
                        ));
                      })()}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>}

            {/* Main editable textarea — voice fills in here, user can always edit */}
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={isListening ? textInput + (interimText ? (textInput && !textInput.endsWith(' ') ? ' ' : '') + interimText : '') : textInput}
                onChange={(e) => {
                  setTextInput(e.target.value);
                  committedTextRef.current = e.target.value;
                  setInterimText('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) processInput();
                }}
                placeholder={selectedEvent
                  ? `Notes about "${selectedEvent.title}"... (speak or type, edit freely)`
                  : inputMode === 'impromptu'
                    ? "e.g. 'Just ran into Priya at Blue Bottle. She's leaving Stripe, starting something in climate tech...'"
                    : "Speak or type... e.g. 'Met with Sarah at Google, she can intro me to John, need to send deck by Friday'"
                }
                className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-xl px-4 py-3 text-sm
                         placeholder:text-[var(--text-secondary)]/50 focus:outline-none focus:border-[var(--accent)]
                         transition-colors resize-none min-h-[60px]"
                disabled={processing}
                rows={2}
              />
              {isListening && (
                <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-red-500/20 text-red-400 text-[10px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                  Listening
                </div>
              )}
            </div>

            {/* Action bar */}
            <div className="flex items-center justify-between mt-3">
              <p className="text-xs text-[var(--text-secondary)]/60">
                {isListening ? 'Voice is filling in above — edit anytime' : '⌘+Enter to submit'}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleListening}
                  className={`p-2 rounded-xl transition-all ${
                    isListening
                      ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                      : 'bg-white/5 text-[var(--text-secondary)] hover:text-white hover:bg-[var(--hover-bg)]'
                  }`}
                >
                  {isListening ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
                <button
                  onClick={processInput}
                  disabled={processing || !textInput.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-light)] rounded-xl text-sm transition-colors btn-press shimmer-hover
                           disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {processing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {processing ? 'Parsing...' : 'Submit'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating buttons — hidden on mobile (mic is in tab bar) */}
      <motion.div className="hidden md:flex items-center justify-center gap-3">
        {!isExpanded && (
          <motion.button
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            onClick={() => { setIsExpanded(true); recordingStartedAt.current = new Date().toISOString(); }}
            className="glass px-4 py-2.5 rounded-full text-sm hover:border-[var(--accent)] transition-colors"
          >
            + Add Contact
          </motion.button>
        )}

        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={() => { toggleListening(); if (!isExpanded) setIsExpanded(true); }}
          className={`relative p-4 rounded-full transition-all hover-pop ${
            isListening
              ? 'bg-red-500 shadow-[0_0_30px_rgba(239,68,68,0.5)]'
              : 'bg-[var(--accent)] shadow-[0_0_30px_var(--accent-glow)] hover:shadow-[0_0_50px_var(--accent-glow)] voice-btn-gradient'
          }`}
        >
          {isListening && (
            <>
              <span className="absolute inset-0 rounded-full bg-red-500/50 pulse-ring" />
              <span className="absolute inset-0 rounded-full bg-red-500/30 pulse-ring" style={{ animationDelay: '0.5s' }} />
            </>
          )}
          {isListening ? <MicOff size={22} /> : <Mic size={22} />}
        </motion.button>
      </motion.div>
    </div>
  );
}

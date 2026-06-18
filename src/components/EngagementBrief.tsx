'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, RefreshCw, Zap, ChevronDown, ChevronRight, Clock, Tag, Lightbulb, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useCrmStore } from '@/store/useCrmStore';
import { useToastStore } from '@/components/Toast';
import { formatDistanceToNowStrict, differenceInDays } from 'date-fns';

interface ContactSynthesis {
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

interface EngagementBriefProps {
  contactId: string;
  contactName: string;
  isSelf?: boolean;
  synthesis?: ContactSynthesis | null;
  synthesizedAt?: string | null;
}

const typeColor: Record<string, string> = {
  coworker: '#7c5cff',
  collaborator: '#22d3ee',
  client: '#10b981',
  investor: '#f5c542',
  mentor: '#a78bfa',
  friend: '#ec4899',
  family: '#f97316',
  weak: '#94a3b8',
  unknown: '#94a3b8',
};

const cadenceColor: Record<string, string> = {
  'spike in last month': '#10b981',
  'steady': '#7c5cff',
  'drifting': '#ef4444',
};

const STALE_DAYS = 7;

export default function EngagementBrief({ contactId, contactName, isSelf, synthesis, synthesizedAt }: EngagementBriefProps) {
  const { fetchAll } = useCrmStore();
  const addToast = useToastStore((s) => s.addToast);
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const autoTried = useRef<string | null>(null);

  const isStale = !synthesizedAt || differenceInDays(new Date(), new Date(synthesizedAt)) >= STALE_DAYS;

  const generate = async () => {
    setGenerating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/synthesize-contact', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      await fetchAll();
      setExpanded(true);
    } catch (e: any) {
      addToast({ message: 'Synthesis failed: ' + e.message, type: 'error' });
    }
    setGenerating(false);
  };

  // Auto-generate on first open if missing AND not self
  useEffect(() => {
    if (isSelf) return;
    if (autoTried.current === contactId) return;
    autoTried.current = contactId;
    if (!synthesis) {
      // Don't auto-trigger — wait for user click (saves cost). They get a "Generate" button instead.
    }
  }, [contactId, synthesis, isSelf]);

  if (isSelf) return null;

  // Empty state — no synthesis yet
  if (!synthesis) {
    return (
      <div className="px-6 py-4">
        <button onClick={generate} disabled={generating}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-[var(--border)] hover:border-[var(--accent)]/40 hover:bg-[var(--accent)]/5 transition-all disabled:opacity-50">
          {generating ? <Loader2 size={13} className="animate-spin text-[var(--accent)]" /> : <Zap size={13} className="text-[var(--accent)]" />}
          <span className="text-[12.5px] font-medium">
            {generating ? 'Synthesizing relationship…' : `How to engage ${contactName.split(' ')[0]}`}
          </span>
        </button>
        <p className="text-[10px] text-[var(--text-secondary)]/60 mt-2 text-center">
          AI reads your interactions + notes + research to suggest approach + topics.
        </p>
      </div>
    );
  }

  const tColor = typeColor[synthesis.relationship_type] || '#7c5cff';
  const cColor = synthesis.cadence_signal ? (cadenceColor[synthesis.cadence_signal] || '#94a3b8') : null;

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ backgroundColor: 'rgba(124,92,255,0.12)', color: '#7c5cff' }}>
            <Zap size={10} strokeWidth={2} />
          </div>
          <h3 className="text-[11px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)]">
            How to engage
          </h3>
          {synthesizedAt && (
            <span className="text-[9.5px] text-[var(--text-secondary)]/60">
              · {formatDistanceToNowStrict(new Date(synthesizedAt), { addSuffix: true })}
            </span>
          )}
          {isStale && (
            <span className="text-[9px] text-[var(--gold)]/80">· stale</span>
          )}
        </div>
        <button onClick={generate} disabled={generating}
          className="text-[10.5px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors flex items-center gap-1 disabled:opacity-50">
          {generating ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          {generating ? 'Updating' : 'Refresh'}
        </button>
      </div>

      {/* Top-line: relationship type + tempo + cadence */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wider"
          style={{ backgroundColor: tColor + '18', color: tColor }}>
          {synthesis.relationship_type.replace('_', ' ')}
        </span>
        <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-[var(--input-bg)] text-[var(--text-primary)]/80 flex items-center gap-1">
          <Clock size={9} /> {synthesis.tempo}
        </span>
        {cColor && synthesis.cadence_signal && (
          <span className="text-[10.5px] px-2 py-0.5 rounded-full font-medium"
            style={{ backgroundColor: cColor + '18', color: cColor }}>
            {synthesis.cadence_signal}
          </span>
        )}
      </div>

      {/* Common topics */}
      {synthesis.common_topics.length > 0 && (
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          <Tag size={10} className="text-[var(--text-secondary)]/60" />
          {synthesis.common_topics.map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--input-bg)] text-[var(--text-secondary)]">
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Pre-brief (always expanded) */}
      {synthesis.prebrief.length > 0 && (
        <div className="mb-3">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] font-medium mb-1.5">For next meeting</p>
          <ul className="space-y-1">
            {synthesis.prebrief.map((b, i) => (
              <li key={i} className="text-[12px] text-[var(--text-primary)]/90 leading-snug pl-3 relative">
                <span className="absolute left-0 top-1.5 w-1 h-1 rounded-full bg-[var(--accent)]" />
                {b}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Collapsible: hooks + approach + avoid */}
      {(synthesis.hooks.length > 0 || synthesis.approach || synthesis.avoid) && (
        <button onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {expanded ? 'Less' : 'More — conversation hooks + approach'}
        </button>
      )}

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden mt-3 space-y-3"
          >
            {synthesis.hooks.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] font-medium mb-1.5 flex items-center gap-1">
                  <Lightbulb size={10} /> Conversation hooks
                </p>
                <ul className="space-y-1">
                  {synthesis.hooks.map((h, i) => (
                    <li key={i} className="text-[12px] text-[var(--text-primary)]/85 leading-snug pl-3 relative">
                      <span className="absolute left-0 top-1.5 w-1 h-1 rounded-full bg-[var(--gold)]" />
                      {h}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {synthesis.approach && (
              <div className="px-3 py-2 rounded-md bg-[var(--accent)]/5 border-l-2 border-[var(--accent)]/40">
                <p className="text-[10px] uppercase tracking-wider text-[var(--accent)] font-medium mb-1">Approach</p>
                <p className="text-[12px] text-[var(--text-primary)]/90 leading-snug">{synthesis.approach}</p>
              </div>
            )}

            {synthesis.avoid && (
              <div className="px-3 py-2 rounded-md bg-[var(--danger)]/5 border-l-2 border-[var(--danger)]/40">
                <p className="text-[10px] uppercase tracking-wider text-[var(--danger)] font-medium mb-1 flex items-center gap-1">
                  <AlertCircle size={10} /> Avoid
                </p>
                <p className="text-[12px] text-[var(--text-primary)]/90 leading-snug">{synthesis.avoid}</p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

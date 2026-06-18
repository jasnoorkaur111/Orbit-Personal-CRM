'use client';

import { useState, useEffect, useMemo } from 'react';
import { Inbox, Link2, Compass } from 'lucide-react';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { useCrmStore } from '@/store/useCrmStore';
import SuggestionsInbox from './SuggestionsInbox';
import DiscoveredView from './DiscoveredView';
import FirstRunBanner from './FirstRunBanner';
import { useFirstRun, isFirstRunActive } from '@/lib/firstRunContext';

type Tab = 'suggestions' | 'discovered';

interface InboxViewProps {
  /** Initial tab — set by parent when navigating from legacy nav ids. */
  defaultTab?: Tab;
  /** If provided, a back chevron renders at top-left that returns to the
   *  prior view. Set by parent when this is opened as a side-trip from
   *  another page (e.g. the inbox bell on the Network header). */
  onBack?: () => void;
}

/**
 * Unified inbox: combines connection suggestions, merge suggestions, and the
 * Discovered tray into one surface.
 */
export default function InboxView({ defaultTab = 'suggestions', onBack }: InboxViewProps = {}) {
  const { contacts } = useCrmStore();
  const firstRun = useFirstRun();
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [suggestionsCount, setSuggestionsCount] = useState(0);
  const [mergesCount, setMergesCount] = useState(0);

  const discoveredCount = useMemo(
    () => contacts.filter((c) => c.is_promoted === false).length,
    [contacts],
  );

  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const [{ count: s }, { count: m }] = await Promise.all([
        supabase.from('connection_suggestions').select('id', { count: 'exact', head: true })
          .eq('user_id', user.id).eq('status', 'pending'),
        supabase.from('merge_suggestions').select('id', { count: 'exact', head: true })
          .eq('user_id', user.id).eq('status', 'pending'),
      ]);
      if (cancel) return;
      setSuggestionsCount(s || 0);
      setMergesCount(m || 0);
    })();
    return () => { cancel = true; };
  }, [contacts]); // refresh on any contact change (after merge/promote)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Tab strip — sits ABOVE the child's own SharedHeader; children handle their content */}
      <div className="flex-shrink-0 border-b border-[var(--border)] bg-[var(--bg-surface)]/80 backdrop-blur-xl">
        <div className="flex items-center px-5 md:px-7 gap-0">
          {onBack && (
            <button onClick={onBack}
              className="mr-2 p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors text-[14px] leading-none"
              title="Back">
              ←
            </button>
          )}
          <TabButton
            active={tab === 'suggestions'}
            onClick={() => setTab('suggestions')}
            icon={Link2}
            label="Suggestions"
            count={suggestionsCount + mergesCount}
          />
          <TabButton
            active={tab === 'discovered'}
            onClick={() => setTab('discovered')}
            icon={Compass}
            label="Discovered"
            count={discoveredCount}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* First-run banner — suggestions and discovered both rely on the
            email + connection mining passes, which need backfilled data
            to surface anything useful. Same unified progress as Home. */}
        {isFirstRunActive(firstRun) && (
          <div className="px-5 md:px-7 pt-4">
            <FirstRunBanner info={firstRun} />
          </div>
        )}
        {tab === 'suggestions' && <SuggestionsInbox />}
        {tab === 'discovered' && <DiscoveredView />}
      </div>
    </div>
  );
}

function TabButton({
  active, onClick, icon: Icon, label, count,
}: {
  active: boolean; onClick: () => void; icon: typeof Inbox; label: string; count: number;
}) {
  return (
    <button onClick={onClick}
      className={`relative flex items-center gap-2 px-4 py-3 text-[12.5px] transition-colors ${
        active ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}>
      <Icon size={13} strokeWidth={active ? 2 : 1.6} />
      {label}
      {count > 0 && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
          active ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'bg-[var(--input-bg)] text-[var(--text-secondary)]'
        }`}>
          {count}
        </span>
      )}
      {active && (
        <motion.div layoutId="inboxTab"
          className="absolute -bottom-px left-0 right-0 h-[2px] bg-[var(--accent)] rounded-full"
          transition={{ type: 'spring', stiffness: 400, damping: 30 }} />
      )}
    </button>
  );
}

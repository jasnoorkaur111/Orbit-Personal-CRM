'use client';

import { useEffect, useState } from 'react';
import { Search, Inbox as InboxIcon, Plus } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface SharedHeaderProps {
  title: string;
  subtitle?: string;
  addLabel?: string;
  onAdd?: () => void;
  showSearch?: boolean;
  showAdd?: boolean;
  /** Show the Inbox icon (top-right). Was a Bell — now navigates to /inbox. */
  showInbox?: boolean;
  /** Triggered by the inbox icon. Page-level handler should setActiveView('inbox'). */
  onInboxClick?: () => void;
  right?: React.ReactNode;
  /** Optional decoration rendered to the LEFT of the title (e.g. a small
   *  silhouette/avatar). Pinned at title baseline. */
  leftAdornment?: React.ReactNode;
}

export default function SharedHeader({
  title,
  subtitle,
  addLabel = 'Add',
  onAdd,
  showSearch = true,
  showAdd = true,
  showInbox = true,
  onInboxClick,
  right,
  leftAdornment,
}: SharedHeaderProps) {
  const [unread, setUnread] = useState(0);

  // Live count: pending suggestions + merges + discovered candidates.
  // Refreshes on mount AND any time another component dispatches
  // 'inbox-count-changed' (after accept / dismiss / promote actions).
  useEffect(() => {
    let cancel = false;
    const refresh = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const [{ count: s }, { count: m }, { count: d }] = await Promise.all([
          supabase.from('connection_suggestions').select('id', { count: 'exact', head: true })
            .eq('user_id', user.id).eq('status', 'pending'),
          supabase.from('merge_suggestions').select('id', { count: 'exact', head: true })
            .eq('user_id', user.id).eq('status', 'pending'),
          supabase.from('contacts').select('id', { count: 'exact', head: true })
            .eq('user_id', user.id).eq('is_promoted', false),
        ]);
        if (cancel) return;
        setUnread((s || 0) + (m || 0) + (d || 0));
      } catch {}
    };
    refresh();
    const onChange = () => refresh();
    window.addEventListener('inbox-count-changed', onChange);
    return () => { cancel = true; window.removeEventListener('inbox-count-changed', onChange); };
  }, []);

  const openSearch = () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));

  return (
    <header className="flex-shrink-0 px-5 md:px-8 pt-5 md:pt-6 pb-4 md:pb-5">
      <div className="flex items-center gap-4">
        {/* Optional left adornment (e.g. small silhouette) */}
        {leftAdornment && <div className="flex-shrink-0">{leftAdornment}</div>}

        {/* Title block */}
        <div className="min-w-0 flex-shrink-0">
          <h1 className="text-xl md:text-[22px] font-semibold tracking-tight leading-tight">{title}</h1>
          {subtitle && (
            <p className="text-[12.5px] text-[var(--text-secondary)] mt-0.5 truncate">{subtitle}</p>
          )}
        </div>

        {/* Search + Ask — centered, expands */}
        {showSearch && (
          <div className="flex-1 max-w-[600px] mx-auto hidden md:flex items-center gap-2">
            <button
              onClick={openSearch}
              className="flex-1 flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--border-hover)] transition-colors text-[12.5px] text-[var(--text-secondary)] shadow-[var(--shadow-sm)]"
            >
              <Search size={14} strokeWidth={1.6} />
              <span className="truncate">Search people, conversations, or tags...</span>
              <span className="ml-auto text-[10px] tracking-wider opacity-60 flex-shrink-0">⌘K</span>
            </button>
            <button
              onClick={() => window.dispatchEvent(new Event('open-ask-network'))}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-full bg-[var(--accent)]/8 border border-[var(--accent)]/25 hover:bg-[var(--accent)]/14 hover:border-[var(--accent)]/40 transition-colors text-[12.5px] text-[var(--accent)] flex-shrink-0"
              title="Ask your network anything (⌘J)"
            >
              <span>Ask</span>
            </button>
          </div>
        )}

        {!showSearch && <div className="flex-1" />}

        {/* Right cluster */}
        <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">
          {right}

          {/* Mobile search icon */}
          {showSearch && (
            <button
              onClick={openSearch}
              className="md:hidden w-9 h-9 rounded-full flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors"
              aria-label="Search"
            >
              <Search size={15} />
            </button>
          )}

          {showAdd && (
            <button
              onClick={onAdd}
              className="btn-lavender flex items-center gap-1.5 px-3.5 md:px-4 py-2 rounded-full text-[12.5px] font-medium btn-press"
            >
              <Plus size={13} strokeWidth={2.2} />
              <span className="hidden sm:inline">{addLabel}</span>
            </button>
          )}

          {showInbox && (
            <button
              onClick={() => {
                if (onInboxClick) onInboxClick();
                else window.dispatchEvent(new Event('open-inbox'));
              }}
              className="relative w-9 h-9 rounded-full flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors"
              aria-label="Open inbox"
              title="Inbox"
            >
              <InboxIcon size={15} strokeWidth={1.6} />
              {unread > 0 && (
                <span className="absolute top-1 right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-[var(--accent)] text-white text-[9.5px] font-medium flex items-center justify-center tabular-nums">{unread > 99 ? '99+' : unread}</span>
              )}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

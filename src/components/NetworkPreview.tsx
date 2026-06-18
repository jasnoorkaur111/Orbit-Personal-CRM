'use client';

import dynamic from 'next/dynamic';
import { ArrowRight } from 'lucide-react';

const NetworkGraph = dynamic(() => import('./NetworkGraph'), { ssr: false });

interface NetworkPreviewProps {
  contacts: { id: string }[];
  onOpen: () => void;
  height?: number;
}

export default function NetworkPreview({ contacts, onOpen, height = 360 }: NetworkPreviewProps) {
  if (contacts.length === 0) return null;

  return (
    <div className="glass-card p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[11px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)]">
            Network map of the week
          </h2>
          <p className="text-[10px] text-[var(--text-secondary)]/60 mt-0.5">
            Drag nodes around. Double-click to focus.
          </p>
        </div>
        <button onClick={onOpen} className="text-[11px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors flex items-center gap-1 flex-shrink-0">
          View all <ArrowRight size={11} />
        </button>
      </div>

      {/* Real NetworkGraph in preview mode — only shows contacts touched in last 30 days */}
      <div className="relative w-full rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--bg-primary)]/40" style={{ height }}>
        <NetworkGraph previewMode defaultTimeFilter="month" />
      </div>
    </div>
  );
}

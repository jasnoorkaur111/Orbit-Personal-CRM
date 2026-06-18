'use client';

import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, MessageCircle, Repeat, Star, Activity, ArrowRight, Users, Clock as ClockIcon,
  AlertTriangle, CheckSquare, TrendingUp, Zap, Reply, Send, UserPlus,
} from 'lucide-react';
import { useCrmStore } from '@/store/useCrmStore';
import { computeHealthScore, getDailyReachOuts, getNetworkInsights, getIntroPaths, getOwedReplies, getAwaitingReply, getRecurringContacts, getNewThisMonth } from '@/lib/healthScore';
import { differenceInDays, formatDistanceToNowStrict } from 'date-fns';

export type DrawerType = 'reach-out' | 'reconnect' | 'opportunities' | 'health' | 'intros' | 'owed-replies' | 'awaiting-reply' | 'recurring' | 'new-this-month';

interface DetailDrawerProps {
  type: DrawerType;
  onClose: () => void;
  onSelectContact: (id: string) => void;
}

const meta: Record<DrawerType, { title: string; subtitle: string; icon: typeof MessageCircle; color: string }> = {
  // Colors match the network-map signals: yellow = needs-attention halo
  // (owed replies are the primary attention trigger), blue = stale palette
  // stop (awaiting-reply contacts are in a holding pattern, cool not warm).
  'owed-replies': { title: 'Replies you owe', subtitle: 'Real people in your network waiting on your response', icon: Reply, color: '#ffc850' },
  'awaiting-reply': { title: 'Awaiting their reply', subtitle: 'Emails you sent — most recent first, cold pitches at the bottom', icon: Send, color: '#6aa1ff' },
  'reach-out': { title: 'People to reach out to', subtitle: 'Going quiet — drop them a note', icon: MessageCircle, color: '#7c5cff' },
  'reconnect': { title: 'People to reconnect', subtitle: "Haven't heard from them in 14+ days", icon: Repeat, color: '#f97316' },
  'opportunities': { title: 'Warm opportunities', subtitle: 'Strong connections, well-networked, no pending work', icon: Star, color: '#f5c542' },
  'health': { title: 'Network health', subtitle: 'How your relationships break down', icon: Activity, color: '#7c5cff' },
  'intros': { title: 'Potential introductions', subtitle: 'People in your network who don\'t know each other yet', icon: Users, color: '#06b6d4' },
  'recurring': { title: 'Recurring contacts', subtitle: 'People you meet on cadence — based on the last 90 days of calendar events', icon: Repeat, color: '#06b6d4' },
  'new-this-month': { title: 'New this month', subtitle: 'First met in the past 30 days', icon: UserPlus, color: '#10b981' },
};

export default function DetailDrawer({ type, onClose, onSelectContact }: DetailDrawerProps) {
  const { contacts } = useCrmStore();
  const info = meta[type];
  const Icon = info.icon;

  const now = new Date();

  const safeDate = (d?: string | null) => {
    if (!d) return new Date();
    const p = new Date(d);
    return isNaN(p.getTime()) ? new Date() : p;
  };

  const events = useCrmStore((s) => s.events);
  const items = useMemo(() => {
    switch (type) {
      case 'owed-replies':
        return getOwedReplies(contacts, 3, 100);
      case 'awaiting-reply':
        return getAwaitingReply(contacts, 3, 100);
      case 'recurring':
        return getRecurringContacts(contacts, events, 100);
      case 'new-this-month':
        return getNewThisMonth(contacts, events, 100);
      case 'reach-out':
        return getDailyReachOuts(contacts, 50);
      case 'reconnect':
        // Only show contacts you've actually contacted before. Never-contacted bulk
        // imports aren't "going quiet" — they were never warm.
        return contacts
          .filter((c) => !c.is_self && c.last_contacted)
          .map((c) => ({ ...c, daysSince: differenceInDays(now, safeDate(c.last_contacted)) }))
          .filter((c) => c.daysSince >= 14)
          .sort((a, b) => b.daysSince - a.daysSince);
      case 'opportunities':
        return contacts
          .filter((c) => !c.is_self)
          .map((c) => ({ ...c, health: computeHealthScore(c) }))
          .filter((c) =>
            c.health.score >= 70 &&
            c.connections.length >= 3 &&
            c.tasks.filter((t) => !t.completed).length === 0
          )
          .sort((a, b) => b.health.score - a.health.score);
      default:
        return [];
    }
  }, [contacts, events, type]);

  const insights = useMemo(() => getNetworkInsights(contacts), [contacts]);
  const introPaths = useMemo(() => (type === 'intros' ? getIntroPaths(contacts, 100) : []), [contacts, type]);

  const weakContacts = useMemo(() => {
    if (type !== 'health') return [];
    return contacts
      .filter((c) => !c.is_self)
      .map((c) => ({ ...c, health: computeHealthScore(c) }))
      .filter((c) => c.health.score < 50)
      .sort((a, b) => a.health.score - b.health.score)
      .slice(0, 30);
  }, [contacts, type]);

  return (
    <motion.aside
      key={`drawer-${type}`}
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: 'spring', damping: 28, stiffness: 280 }}
      className="hidden md:flex flex-col flex-shrink-0 w-[420px] xl:w-[460px] border-l border-[var(--border)] bg-[var(--bg-surface)] overflow-hidden h-full"
    >
      {/* Header */}
      <div className="flex-shrink-0 px-5 pt-4 pb-3 border-b border-[var(--border)]">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: info.color + '18', color: info.color }}>
              <Icon size={14} strokeWidth={1.8} fill={Icon === Star ? info.color : 'transparent'} />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold tracking-tight">{info.title}</h2>
              <p className="text-[11px] text-[var(--text-secondary)]">{info.subtitle}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--hover-bg)] text-[var(--text-secondary)] transition-colors">
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {/* Contact lists */}
        {(type === 'owed-replies' || type === 'awaiting-reply' || type === 'reach-out' || type === 'reconnect' || type === 'opportunities' || type === 'recurring' || type === 'new-this-month') && (
          <>
            {items.length === 0 ? (
              <EmptyState text={
                type === 'owed-replies' ? 'Inbox zero — no replies owed.' :
                type === 'awaiting-reply' ? 'No one waiting on you. Send some emails.' :
                type === 'recurring' ? 'No recurring meetings yet. As your calendar fills in, this list will populate.' :
                type === 'new-this-month' ? 'No new contacts this month yet.' :
                'All caught up here.'
              } />
            ) : (
              <div className="space-y-0.5">
                {items.map((c: any) => (
                  <ContactRow key={c.id} contact={c} type={type} onClick={() => onSelectContact(c.id)} />
                ))}
              </div>
            )}
          </>
        )}

        {/* Health breakdown */}
        {type === 'health' && (
          <div className="space-y-4">
            <div className="px-3">
              <div className="flex items-center gap-4 mb-4">
                <div className="relative w-[88px] h-[88px] flex-shrink-0">
                  <svg width="88" height="88" className="-rotate-90">
                    <circle cx="44" cy="44" r="38" fill="none" stroke="var(--border)" strokeWidth="6" />
                    <circle cx="44" cy="44" r="38" fill="none"
                      stroke={insights.color} strokeWidth="6" strokeLinecap="round"
                      strokeDasharray={`${(insights.score / 100) * 238.76} 238.76`} />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-xl font-semibold" style={{ color: insights.color }}>{insights.score}</span>
                    <span className="text-[9px] text-[var(--text-secondary)]">{insights.label}</span>
                  </div>
                </div>
                <div className="flex-1 space-y-2.5 min-w-0">
                  {[
                    { label: 'Strength', value: insights.strength, help: '% of contacts with score ≥ 50' },
                    { label: 'Engagement', value: insights.engagement, help: '% touched in last 30 days' },
                    { label: 'Reachability', value: insights.reachability, help: '% with email/phone/notes' },
                  ].map((m) => (
                    <div key={m.label}>
                      <div className="flex items-center justify-between text-[10.5px] mb-1">
                        <span className="text-[var(--text-secondary)]" title={m.help}>{m.label}</span>
                        <span className="text-[var(--text-primary)] font-medium">{m.value}%</span>
                      </div>
                      <div className="h-1 rounded-full bg-[var(--border)] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${m.value}%`, backgroundColor: insights.color }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {weakContacts.length > 0 && (
              <div>
                <div className="px-3 mb-2 flex items-center gap-2">
                  <AlertTriangle size={11} className="text-[#f5c542]" />
                  <h3 className="text-[10px] uppercase tracking-[0.12em] font-medium text-[var(--text-secondary)]">
                    Contacts needing attention ({weakContacts.length})
                  </h3>
                </div>
                <div className="space-y-0.5">
                  {weakContacts.map((c) => (
                    <ContactRow key={c.id} contact={c} type="health" onClick={() => onSelectContact(c.id)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Intro paths */}
        {type === 'intros' && (
          <>
            {introPaths.length === 0 ? (
              <EmptyState text="No intro opportunities yet. Add more connections to unlock these." />
            ) : (
              <div className="space-y-1.5">
                {introPaths.map((p, i) => (
                  <div key={i} className="px-3 py-2.5 rounded-lg hover:bg-[var(--hover-bg)] transition-colors">
                    <div className="flex items-center gap-2 mb-1.5">
                      <button onClick={() => onSelectContact(p.from.id)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--hover-bg)] transition-colors">
                        <Avatar contact={p.from} size={20} />
                        <span className="text-[12px] font-medium">{p.from.name}</span>
                      </button>
                      <ArrowRight size={10} className="text-[var(--text-secondary)]/40" />
                      <button onClick={() => onSelectContact(p.to.id)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--hover-bg)] transition-colors">
                        <Avatar contact={p.to} size={20} />
                        <span className="text-[12px] font-medium">{p.to.name}</span>
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 px-2 text-[10.5px] text-[var(--text-secondary)]">
                      <span>via</span>
                      <div className="flex items-center -space-x-1">
                        {p.via.slice(0, 3).map((v) => (
                          <button key={v.id} onClick={() => onSelectContact(v.id)} title={v.name}>
                            <Avatar contact={v} size={16} ring />
                          </button>
                        ))}
                      </div>
                      <span>{p.via.length > 3 ? `${p.via.map((v) => v.name).slice(0, 2).join(', ')} +${p.via.length - 2}` : p.via.map((v) => v.name).join(', ')}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </motion.aside>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-center text-[12px] text-[var(--text-secondary)]/60 py-12 px-4">{text}</p>;
}

function Avatar({ contact, size = 24, ring }: { contact: { name: string; photo?: string; color?: string }; size?: number; ring?: boolean }) {
  return contact.photo ? (
    <img src={contact.photo} alt="" className={`rounded-full object-cover ${ring ? 'ring-2 ring-[var(--bg-surface)]' : ''}`} style={{ width: size, height: size }} />
  ) : (
    <div className={`rounded-full flex items-center justify-center font-semibold ${ring ? 'ring-2 ring-[var(--bg-surface)]' : ''}`}
      style={{
        width: size, height: size,
        backgroundColor: (contact.color || '#7c5cff') + '24',
        color: contact.color || '#7c5cff',
        fontSize: size * 0.42,
      }}>
      {contact.name.charAt(0)}
    </div>
  );
}

function ContactRow({ contact, type, onClick }: {
  contact: any; type: DrawerType; onClick: () => void;
}) {
  const lastDate = contact.last_contacted ? new Date(contact.last_contacted) : new Date(contact.created_at);
  const daysSince = differenceInDays(new Date(), lastDate);

  let trailing: React.ReactNode = null;
  if (type === 'owed-replies') {
    trailing = (
      <div className="text-right">
        <p className="text-[10.5px] text-[#ef4444] font-medium">{contact.daysOwed}d waiting</p>
        <p className="text-[9.5px] text-[var(--text-secondary)]/60">{contact.emailsReceived} reply{contact.emailsReceived !== 1 ? 's' : ''} in history</p>
      </div>
    );
  } else if (type === 'awaiting-reply') {
    trailing = (
      <div className="text-right">
        <p className="text-[10.5px] text-[#f59e0b] font-medium">{contact.daysWaiting}d ago</p>
        <p className="text-[9.5px] text-[var(--text-secondary)]/60">
          {contact.everReplied ? 'silent follow-up' : 'never responded'}
        </p>
      </div>
    );
  } else if (type === 'reach-out') {
    trailing = (
      <div className="text-right">
        <p className="text-[10.5px] text-[var(--text-secondary)]">{contact.daysSince}d ago</p>
        {contact.health?.suggestion && (
          <p className="text-[9.5px] text-[var(--text-secondary)]/60 max-w-[140px] truncate">{contact.health.suggestion}</p>
        )}
      </div>
    );
  } else if (type === 'reconnect') {
    trailing = <p className="text-[10.5px] text-[#f97316]">{contact.daysSince}d quiet</p>;
  } else if (type === 'opportunities') {
    trailing = <p className="text-[10.5px] font-medium" style={{ color: contact.health?.color }}>{contact.health?.score}</p>;
  } else if (type === 'health') {
    trailing = (
      <div className="text-right">
        <p className="text-[10.5px] font-medium" style={{ color: contact.health?.color }}>{contact.health?.score}</p>
        <p className="text-[9.5px] text-[var(--text-secondary)]/60">{contact.health?.label}</p>
      </div>
    );
  } else if (type === 'recurring') {
    trailing = (
      <div className="text-right">
        <p className="text-[10.5px] text-[#06b6d4] font-medium">{contact.meetingCount} meetings</p>
        <p className="text-[9.5px] text-[var(--text-secondary)]/60">past 90 days</p>
      </div>
    );
  } else if (type === 'new-this-month') {
    const days = contact.firstSeen ? differenceInDays(new Date(), contact.firstSeen) : null;
    trailing = (
      <div className="text-right">
        <p className="text-[10.5px] text-[#10b981] font-medium">{days != null ? (days === 0 ? 'today' : `${days}d ago`) : 'new'}</p>
        <p className="text-[9.5px] text-[var(--text-secondary)]/60">first met</p>
      </div>
    );
  }

  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--hover-bg)] transition-colors text-left shimmer-hover group">
      <Avatar contact={contact} size={32} />
      <div className="flex-1 min-w-0">
        <p className="text-[12.5px] font-medium truncate">{contact.name}</p>
        <p className="text-[10px] text-[var(--text-secondary)] truncate">
          {contact.company || contact.role || `Last contact ${daysSince}d ago`}
        </p>
      </div>
      {trailing}
      <ArrowRight size={11} className="text-[var(--text-secondary)]/30 group-hover:text-[var(--text-secondary)] transition-colors flex-shrink-0" />
    </button>
  );
}

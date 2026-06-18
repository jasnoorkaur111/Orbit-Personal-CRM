'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { useCrmStore } from '@/store/useCrmStore';
import { motion, AnimatePresence } from 'framer-motion';
import { ZoomIn, ZoomOut, RotateCcw, Home, Search, Filter, X, Eye, EyeOff, GitBranch, ArrowRight, Activity, Loader2 } from 'lucide-react';
import { differenceInDays } from 'date-fns';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceRadial } from 'd3-force';
import { displayName, displayInitial } from '@/lib/displayName';
import { computeHealthScore, getNetworkInsights } from '@/lib/healthScore';
import { nodeColor, needsAttention, type AttentionFlag } from '@/lib/nodeColors';
import { useFirstRun, hasAnyProvider } from '@/lib/firstRunContext';
import { AlertTriangle, Clock as ClockIcon, Users as UsersIcon, CheckSquare as TasksIcon, TrendingUp } from 'lucide-react';
import SharedHeader from './SharedHeader';
import { useConfirm } from './ConfirmDialog';
import { useToastStore } from './Toast';

interface Node {
  id: string;
  name: string;
  company?: string;
  color: string;
  x: number;
  y: number;
  radius: number;
  tasks: number;
  connectionCount: number;
  notes: string;
  tags: string[];
  photo?: string;
  ring: number;
  daysAgo: number;
  recencyAlpha: number;
  healthScore: number;
  healthColor: string;
  /** Has real signal? edge / linked event / received email / notes / task.
   * Drives visual demotion of "stardust" nodes (no signal → tiny + faded + no label). */
  hasSignal: boolean;
  /** Unified "needs attention" flag: owed reply, important contact going
   *  quiet, or fading regular. Null when the contact is in good standing.
   *  When set, drives the yellow halo + tooltip reason line. */
  attention: AttentionFlag | null;
}

interface Link {
  source: string;
  target: string;
}

type StrengthFilter = 'all' | 'strong' | 'good' | 'fading' | 'cold';
// Time filter is the primary network lens — granular options on purpose so
// the user can quickly answer "who have I talked to in the past N days".
type TimeFilter = 'all' | '3days' | 'week' | '2weeks' | 'month' | '3months';

interface NetworkGraphProps {
  previewMode?: boolean;
  defaultTimeFilter?: TimeFilter;
}

export default function NetworkGraph({ previewMode = false, defaultTimeFilter = 'all' }: NetworkGraphProps = {}) {
  const firstRun = useFirstRun();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const { contacts, selectedContactId, setSelectedContact, addContact, addConnection, removeConnection, deleteWithPop, fetchAll, projects, activeProjectFilter, pendingDeleteId, pendingDeleteStartedAt } = useCrmStore();
  // Pop animation window in ms — matches deleteWithPop in useCrmStore.
  const POP_MS = 280;
  const confirm = useConfirm();
  const addToast = useToastStore((s) => s.addToast);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: Node } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  // First-load loading state — drives the lavender overlay that replaces the
  // previous "white freeze for ~1s while 350 force-sim ticks run sync" UX.
  // Only the FIRST run shows the overlay; subsequent filter re-runs are
  // chunked but transparent (graph stays visible).
  const [layoutReady, setLayoutReady] = useState(false);
  const [layoutProgress, setLayoutProgress] = useState(0);
  // In preview mode default to a slightly zoomed-out view so the whole graph
  // fits on the home card. Full network view starts at 1:1.
  const [zoom, setZoom] = useState(previewMode ? 0.7 : 1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [centerId, setCenterId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string | null; link: Link | null; canvasPos: { x: number; y: number } } | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);

  // Graph filters — kept lean on purpose. Strength/depth/tags removed from
  // the UI but the state vars stay (defaulted to passthrough) so existing
  // filter-pipeline code below keeps working without further changes.
  const [showFilters, setShowFilters] = useState(false);
  const [strengthFilter] = useState<StrengthFilter>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(defaultTimeFilter);
  const [tagFilter] = useState<string | null>(null);
  // Most active = top quartile by total email volume (sent + received).
  // Surfaces the contacts you're in flight with right now.
  const [mostActiveOnly, setMostActiveOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHighlight, setSearchHighlight] = useState<string | null>(null);
  const [hideNames, setHideNames] = useState(false);
  // Reachability filters — default to "show all" so user sees full network until they narrow
  // Hide-isolates / depth filtering were removed from the UI per the
  // simplification pass — kept as constants so the filter pipeline below
  // doesn't need a sweeping refactor.
  const hideIsolates = false;
  const depthFromYou = 0 as 0 | 1 | 2 | 3;
  // Path finding
  const [pathTargetId, setPathTargetId] = useState<string | null>(null);
  const [pathSearch, setPathSearch] = useState('');
  const [showPathFinder, setShowPathFinder] = useState(false);
  const [showIntel, setShowIntel] = useState(false);
  const nodesRef = useRef<Node[]>([]);
  const linksRef = useRef<Link[]>([]);
  const photoCache = useRef<Record<string, HTMLImageElement>>({});
  const animProgressRef = useRef(0);

  // ── Refs mirroring reactive state ──
  // The RAF render loop reads these. Mirroring them as refs lets the RAF
  // useEffect deps stay small (just [dimensions]) so the animation isn't
  // torn down + rebuilt on every click/hover — that rebuild was the glitch.
  const selectedContactIdRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const searchHighlightRef = useRef<string | null>(null);
  const pendingDeleteIdRef = useRef<string | null>(null);
  const pendingDeleteStartedAtRef = useRef<number | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const hideNamesRef = useRef(false);
  const centerIdRef = useRef<string | null>(null);
  const isPanningRef = useRef(false);
  const isDraggingNodeRef = useRef<string | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const mouseDownPosRef = useRef({ x: 0, y: 0 });
  // Tracks what the LAYOUT effect saw last run, so we can detect "only
  // dimensions changed" and skip the 350-tick force sim — instead just
  // rescale existing node positions to the new center. Without this, every
  // ContactPanel open/close (which resizes the canvas) re-runs the sim and
  // the graph visibly re-flows. That was the click-glitch.
  const lastLayoutDeps = useRef<{
    contacts: typeof contacts | null;
    projects: typeof projects | null;
    centerId: string | null;
    strengthFilter: StrengthFilter;
    timeFilter: TimeFilter;
    tagFilter: string | null;
    activeProjectFilter: string | null;
    hideIsolates: boolean;
    depthFromYou: 0 | 1 | 2 | 3;
    mostActiveOnly: boolean;
    width: number;
    height: number;
  }>({
    contacts: null, projects: null, centerId: null,
    strengthFilter: 'all', timeFilter: 'all', tagFilter: null,
    activeProjectFilter: null, hideIsolates: false, depthFromYou: 0,
    mostActiveOnly: false, width: 0, height: 0,
  });

  useEffect(() => {
    const container = canvasRef.current?.parentElement;
    if (!container) return;
    const commit = () => {
      setDimensions({ width: container.clientWidth, height: container.clientHeight });
    };
    // Debounce: when the ContactPanel rail slides in/out, the container width
    // changes continuously for ~250ms. Without debouncing, every intermediate
    // width triggers the layout effect → multiple full re-layouts during one
    // animation. 100ms swallows the slide and commits once it settles.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(commit, 100);
    };
    commit(); // synchronous first measurement
    const ro = new ResizeObserver(debounced);
    ro.observe(container);
    window.addEventListener('resize', debounced);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener('resize', debounced);
    };
  }, []);

  // Build force-directed layout
  useEffect(() => {
    // ── Resize-only fast path ──
    // If only the dimensions changed (e.g. the ContactPanel rail just opened
    // or closed and shrunk the canvas), don't re-run the 350-tick force sim.
    // Just rescale existing node positions to the new center. This is what
    // killed the click-then-exit glitch — every contact click previously
    // restarted the simulation because the side rail resized the canvas.
    const prev = lastLayoutDeps.current;
    const contentSame =
      prev.contacts === contacts &&
      prev.projects === projects &&
      prev.centerId === centerId &&
      prev.strengthFilter === strengthFilter &&
      prev.timeFilter === timeFilter &&
      prev.tagFilter === tagFilter &&
      prev.activeProjectFilter === activeProjectFilter &&
      prev.hideIsolates === hideIsolates &&
      prev.depthFromYou === depthFromYou &&
      prev.mostActiveOnly === mostActiveOnly;
    const dimsChanged = prev.width !== dimensions.width || prev.height !== dimensions.height;
    if (contentSame && dimsChanged && nodesRef.current.length > 0 && prev.width > 0 && prev.height > 0) {
      const oldCx = prev.width / 2;
      const oldCy = prev.height / 2;
      const newCx = dimensions.width / 2;
      const newCy = dimensions.height / 2;
      const sx = newCx / oldCx;
      const sy = newCy / oldCy;
      for (const n of nodesRef.current) {
        n.x = (n.x - oldCx) * sx + newCx;
        n.y = (n.y - oldCy) * sy + newCy;
      }
      lastLayoutDeps.current = { ...prev, width: dimensions.width, height: dimensions.height };
      return;
    }

    const cx = dimensions.width / 2;
    const cy = dimensions.height / 2;
    const isMobileGraph = dimensions.width < 768;
    const maxR = Math.max(50, Math.min(cx, cy) - (isMobileGraph ? 30 : 70));
    const now = new Date();

    if (contacts.length === 0) {
      nodesRef.current = [];
      linksRef.current = [];
      // Mark layout as ready so the loading overlay disappears — otherwise
      // it sits at 0% forever for brand-new users while the background sync
      // populates contacts. The empty-state UI (already rendered at the
      // bottom of this component) takes over and tells them what's happening.
      setLayoutReady(true);
      setLayoutProgress(100);
      return;
    }

    // Filter contacts first
    const activeProject = activeProjectFilter ? projects.find(p => p.id === activeProjectFilter) : null;
    const allTags = [...new Set(contacts.flatMap(c => c.tags || []))];

    // Get events for time-based filtering
    const { events: allEvents } = useCrmStore.getState();

    // ── Pre-compute reachability ──
    // "Connected" = appears in at least one edge in the connections list (i.e. has connections.length > 0)
    const connectedIds = new Set(contacts.filter(c => c.connections.length > 0).map(c => c.id));

    // BFS from is_self for depth filter (only meaningful when is_self has connections, otherwise depth=∞ for all)
    const selfContact = contacts.find(c => (c as any).is_self);
    const reachableByDepth = new Map<string, number>();
    if (selfContact && depthFromYou > 0) {
      const queue: { id: string; d: number }[] = [{ id: selfContact.id, d: 0 }];
      reachableByDepth.set(selfContact.id, 0);
      while (queue.length > 0) {
        const { id, d } = queue.shift()!;
        if (d >= depthFromYou) continue;
        const cur = contacts.find(c => c.id === id);
        if (!cur) continue;
        for (const nb of cur.connections) {
          if (!reachableByDepth.has(nb)) {
            reachableByDepth.set(nb, d + 1);
            queue.push({ id: nb, d: d + 1 });
          }
        }
      }
    }

    // "Most active" set — top contacts by total email volume (sent + received).
    // Computed once per render so the toggle is a cheap set lookup.
    const mostActiveIds = new Set<string>();
    if (mostActiveOnly) {
      const ranked = contacts
        .map((c) => ({
          id: c.id,
          vol: (c.email_stats?.emails_sent || 0) + (c.email_stats?.emails_received || 0),
        }))
        .filter((x) => x.vol > 0)
        .sort((a, b) => b.vol - a.vol)
        .slice(0, 25);
      for (const r of ranked) mostActiveIds.add(r.id);
    }

    // CORE filters always apply — promoted, isolation, depth, project, tag, strength.
    // Time + self are special: time can be relaxed for direct neighbors below.
    const passesCoreFilters = (c: typeof contacts[number]): boolean => {
      if (mostActiveOnly && !mostActiveIds.has(c.id)) return false;
      if ((c as any).is_self) return false;
      if (c.is_promoted === false) return false;
      if (hideIsolates && !connectedIds.has(c.id)) return false;
      if (depthFromYou > 0 && selfContact && connectedIds.has(selfContact.id) && !reachableByDepth.has(c.id)) return false;
      if (activeProject && !activeProject.contactIds.includes(c.id)) return false;
      if (tagFilter && !(c.tags || []).includes(tagFilter)) return false;
      if (strengthFilter !== 'all') {
        const h = computeHealthScore(c);
        if (strengthFilter === 'strong' && h.score < 75) return false;
        if (strengthFilter === 'good' && (h.score < 50 || h.score >= 75)) return false;
        if (strengthFilter === 'fading' && (h.score < 25 || h.score >= 50)) return false;
        if (strengthFilter === 'cold' && h.score >= 25) return false;
      }
      return true;
    };

    const passesTimeFilter = (c: typeof contacts[number]): boolean => {
      if (timeFilter === 'all') return true;
      const maxDays =
        timeFilter === '3days' ? 3 :
        timeFilter === 'week' ? 7 :
        timeFilter === '2weeks' ? 14 :
        timeFilter === 'month' ? 30 :
        90;
      const lastContactedDays = c.last_contacted ? differenceInDays(now, new Date(c.last_contacted)) : 999;
      const firstName = c.name.split(' ')[0].toLowerCase();
      const nameRegex = firstName.length >= 3 ? new RegExp('\\b' + firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b') : null;
      const hasRecentEvent = allEvents.some(e => {
        if (differenceInDays(now, new Date(e.date)) > maxDays) return false;
        if (e.contact_id === c.id) return true;
        return nameRegex ? nameRegex.test(e.title?.toLowerCase() || '') : false;
      });
      return !(lastContactedDays > maxDays && !hasRecentEvent);
    };

    // Primary set: passes everything (including time)
    const primaryIds = new Set<string>();
    for (const c of contacts) {
      if (passesCoreFilters(c) && passesTimeFilter(c)) primaryIds.add(c.id);
    }

    // Edge-expansion: when a time filter is active, also include direct
    // connections of the primary set so the user can see who their
    // time-passing contacts are linked to (their full web — even neighbors
    // who themselves haven't been talked to in 90d).
    // Other filters (strength/project/tag) stay strict — they're intent,
    // not a window.
    const visibleIds = new Set(primaryIds);
    if (timeFilter !== 'all') {
      for (const c of contacts) {
        if (!primaryIds.has(c.id)) continue;
        for (const connId of c.connections || []) {
          if (visibleIds.has(connId)) continue;
          const conn = contacts.find(x => x.id === connId);
          if (conn && passesCoreFilters(conn)) visibleIds.add(connId);
        }
      }
    }

    const filteredContacts = contacts.filter(c => visibleIds.has(c.id));

    if (filteredContacts.length === 0) {
      nodesRef.current = [];
      linksRef.current = [];
      return;
    }

    // Score contacts by REAL recency. Now combines meetings + email signal.
    // Last-signal = max of: last_contacted, email inbound, email outbound, task created,
    // linked-event date, latest notes timestamp. No created_at fallback.
    const scored = filteredContacts.map(c => {
      const candidates: Date[] = [];

      if (c.last_contacted) candidates.push(new Date(c.last_contacted));
      if (c.email_stats?.last_inbound_at) candidates.push(new Date(c.email_stats.last_inbound_at));
      if (c.email_stats?.last_outbound_at) candidates.push(new Date(c.email_stats.last_outbound_at));

      const lastTask = c.tasks.filter(t => t.created_at).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
      if (lastTask) candidates.push(new Date(lastTask.created_at));

      // Linked events ONLY — events.contact_id is now backfilled. No fragile title regex.
      const contactEvents = allEvents.filter(e => e.contact_id === c.id);
      if (contactEvents.length > 0) {
        const sorted = [...contactEvents].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        candidates.push(new Date(sorted[0].date));
      }

      const notesDates = c.notes.match(/\[(\w{3} \d{1,2})\]/g);
      if (notesDates && notesDates.length > 0) {
        const lastNote = notesDates[notesDates.length - 1].replace(/[\[\]]/g, '');
        const parsed = new Date(lastNote + ', ' + now.getFullYear());
        if (!isNaN(parsed.getTime())) candidates.push(parsed);
      }

      const valid = candidates.filter(d => !isNaN(d.getTime()));
      const daysAgo = valid.length > 0
        ? differenceInDays(now, new Date(Math.max(...valid.map(d => d.getTime()))))
        : 365;

      // Frequency: real meetings + email volume (5 emails ≈ 1 meeting)
      const recentEvents = contactEvents.filter(e => differenceInDays(now, new Date(e.date)) <= 90).length;
      const emailVolume = (c.email_stats?.emails_received || 0) + Math.floor((c.email_stats?.emails_sent || 0) / 2);
      const meetingCount = recentEvents + Math.floor(emailVolume / 5);

      return { contact: c, daysAgo, meetingCount };
    });

    // Determine connection depth from center
    const centContactId = centerId || '__you__';
    const directIds = new Set<string>();
    const secondDegreeIds = new Set<string>();

    if (centerId) {
      const cc = contacts.find(c => c.id === centerId);
      cc?.connections.forEach(id => directIds.add(id));
      contacts.filter(c => directIds.has(c.id)).forEach(c => {
        c.connections.forEach(id => {
          if (id !== centerId && !directIds.has(id)) secondDegreeIds.add(id);
        });
      });
    } else {
      // "You" mode — direct = contacts you have, connections of those = 2nd degree
      contacts.forEach(c => directIds.add(c.id));
    }

    // Deterministic hash for consistent positioning
    const hashId = (id: string) => {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
      return h;
    };

    // Pre-compute the set of contact IDs that appear in ANY project so
    // needsAttention() can flag manually-tracked contacts as important
    // without an O(contacts × projects) check inside the per-node map.
    const trackedInProject = new Set<string>();
    for (const p of (projects || [])) for (const cid of (p.contactIds || [])) trackedInProject.add(cid);

    // Build nodes — ring = distance from center based on recency + frequency
    const nodes: Node[] = scored.map(({ contact: c, daysAgo, meetingCount }) => {
      const pendingTasks = c.tasks.filter(t => !t.completed).length;
      const connCount = c.connections.length;
      const isDirect = directIds.has(c.id);
      const is2nd = secondDegreeIds.has(c.id);

      // hasSignal — drives visual prominence. Now distinguishes "people you
      // KNOW" from "people who emailed you once". A cold inbound email no
      // longer earns inner-ring status; you need real engagement to surface.
      const sent = c.email_stats?.emails_sent || 0;            // you replied
      const recv = c.email_stats?.emails_received || 0;
      const threads = c.email_stats?.thread_count || 0;
      const hasEvents = allEvents.some(e => e.contact_id === c.id);
      const hasRealNotes = (c.notes || '').trim().length > 0;
      // KNOWN signals — any one means it's a real relationship:
      //   - you replied at least once
      //   - shared a meeting (real contact)
      //   - multi-thread back-and-forth (recurring contact)
      //   - they're embedded in your network (3+ cc-edges)
      //   - you wrote about them or have pending work for them
      const isKnown = sent >= 1 || hasEvents || threads >= 2 || connCount >= 3
        || hasRealNotes || pendingTasks > 0;
      // hasSignal stays inclusive (so they still RENDER) but isKnown drives
      // visual ranking. Pure cold-inbound contacts (recv only, no reply,
      // no meeting, no notes, no multi-thread) become stardust.
      const hasSignal = isKnown || connCount > 0 || recv > 0;

      // Ring: 0 = inner (close/recent), 1 = mid, 2 = outer (distant/old / no signal)
      let ring: number;
      if (centerId) {
        ring = isDirect ? 0 : is2nd ? 1 : 2;
      } else if (!isKnown) {
        // Cold-inbound + uncategorized → outer regardless of date
        ring = 2;
      } else {
        // Among KNOWN people, rank by recency:
        //   inner = recent and active
        //   mid = recent OR active but not both
        //   outer = stale even though known
        if (daysAgo <= 14 || (daysAgo <= 30 && meetingCount >= 2)) ring = 0;
        else if (daysAgo <= 60 || (daysAgo <= 90 && meetingCount >= 1)) ring = 1;
        else ring = 2;
      }

      // Big difference: signal nodes are sized + tagged + colored; no-signal nodes
      // are tiny "stardust" — visible but visually subordinate.
      const baseR = !hasSignal
        ? (isMobileGraph ? 4 : 5)
        : isMobileGraph
          ? (ring === 0 ? 16 : ring === 1 ? 13 : 10)
          : (ring === 0 ? 22 : ring === 1 ? 17 : 13);

      const hash = hashId(c.id);
      const angle = ((hash & 0xffff) / 0xffff) * Math.PI * 2;
      const spread = maxR * 0.3 + ((hash >> 16) & 0xff) / 255 * maxR * 0.4;
      // Color is now derived purely from recency via the sunset palette —
      // no more random per-contact rotation. Stardust nodes get the deep
      // navy "cold" stop so they still read as part of the graph but
      // visibly recede. The c.color column is ignored (was unused anyway).
      const computedColor = nodeColor(hasSignal ? daysAgo : 365);
      const attention = hasSignal ? needsAttention({
        daysAgo,
        lastInboundAt: c.email_stats?.last_inbound_at,
        lastOutboundAt: c.email_stats?.last_outbound_at,
        emailsSent: sent,
        emailsReceived: recv,
        threadCount: threads,
        meetingCount,
        notesLength: (c.notes || '').trim().length,
        inProject: trackedInProject.has(c.id),
        hasOpenTask: pendingTasks > 0,
        tags: c.tags,
      }) : null;
      return {
        id: c.id, name: c.name, company: c.company, color: computedColor,
        x: cx + Math.cos(angle) * spread, y: cy + Math.sin(angle) * spread,
        radius: baseR + (hasSignal ? Math.min(connCount * (isMobileGraph ? 1.5 : 2.5), isMobileGraph ? 8 : 12) : 0),
        tasks: pendingTasks, connectionCount: connCount,
        notes: c.notes, tags: c.tags || [], photo: c.photo, ring,
        // Floor bumped so cold nodes still read as solid blue marbles instead
        // of fading into the background. Stardust also bumped from 0.22 → 0.32.
        // Math.min(1, …) cap is critical — daysAgo can go NEGATIVE for
        // events scheduled in the future, which pushed recencyAlpha above
        // 1.0, which made nodeAlpha * 255 round to 3-digit hex (e.g. '2ef'),
        // which made the color string '#ff5a3c2ef' (9 chars, invalid) and
        // crashed addColorStop. Belt-and-suspenders with the round() clamp
        // below too.
        daysAgo, recencyAlpha: hasSignal ? Math.min(1, Math.max(0.55, 1 - daysAgo / 90)) : 0.32,
        attention,
        hasSignal,
        ...(() => { const h = computeHealthScore(c); return { healthScore: h.score, healthColor: h.color }; })(),
      };
    });

    // Build links (only between FILTERED contacts)
    const filteredIds = new Set(filteredContacts.map(c => c.id));
    const links: Link[] = [];
    filteredContacts.forEach(c => {
      c.connections.forEach(connId => {
        if (filteredIds.has(connId)) {
          if (!links.find(l => (l.source === c.id && l.target === connId) || (l.source === connId && l.target === c.id))) {
            links.push({ source: c.id, target: connId });
          }
        }
      });
    });

    // D3 force simulation
    const simNodes = nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
    const simLinks = links.map(l => ({ source: l.source, target: l.target }));

    // Aggressive repulsion + longer links for breathing room
    const baseLinkDist = isMobileGraph ? maxR * 0.7 : maxR * 0.65;
    const chargeStrength = isMobileGraph ? -550 : -900;
    // Per-node charge: signal nodes push hard, stardust pushes weakly so the
    // important nodes claim the visual real-estate.
    const chargeFn = (d: any) => {
      const node = nodes.find(n => n.id === d.id);
      return node?.hasSignal ? chargeStrength : chargeStrength * 0.3;
    };

    const sim = forceSimulation(simNodes as any)
      .force('link', forceLink(simLinks as any).id((d: any) => d.id)
        .distance((l: any) => {
          const sourceNode = nodes.find(n => n.id === (typeof l.source === 'object' ? l.source.id : l.source));
          const targetNode = nodes.find(n => n.id === (typeof l.target === 'object' ? l.target.id : l.target));
          const avgDays = ((sourceNode?.daysAgo || 30) + (targetNode?.daysAgo || 30)) / 2;
          const recencyFactor = 0.6 + Math.min(avgDays / 60, 1) * 0.8;
          return baseLinkDist * recencyFactor;
        })
        .strength(0.5))
      .force('charge', forceManyBody().strength(chargeFn))
      .force('center', forceCenter(cx, cy).strength(0.02))
      .force('collide', forceCollide().radius((d: any) => {
        const node = nodes.find(n => n.id === d.id);
        // Signal nodes get MUCH more padding so their labels fit without colliding.
        // Stardust gets just enough to not overlap each other.
        const r = node?.radius || 15;
        return node?.hasSignal ? r + 42 : r + 6;
      }).strength(1))
      .force('radial', forceRadial((d: any) => {
        const node = nodes.find(n => n.id === d.id);
        if (!node) return maxR * 0.85;
        // Wide ring bands so collision force can spread nodes within their band:
        //   Ring 0 (recent + signal)  → 22–55% (pushed out so the You photo has breathing room)
        //   Ring 1 (mid)              → 60–78%
        //   Ring 2 (stale/no-signal)  → 82–100% (outer halo, stardust)
        const ringBase   = node.ring === 0 ? 0.22 : node.ring === 1 ? 0.60 : 0.82;
        const ringSpread = node.ring === 0 ? 0.33 : node.ring === 1 ? 0.18 : 0.18;
        const daysFactor = node.hasSignal ? Math.min(node.daysAgo / 90, 1) : 1;
        return maxR * (ringBase + daysFactor * ringSpread);
      }, cx, cy).strength(0.5))   // Lower strength so collision wins on positioning
      .stop();

    // Snapshot the deps that drove this layout so the next run can detect
    // "only dimensions changed" and take the fast rescale path above.
    lastLayoutDeps.current = {
      contacts, projects, centerId, strengthFilter, timeFilter, tagFilter,
      activeProjectFilter, hideIsolates, depthFromYou, mostActiveOnly,
      width: dimensions.width, height: dimensions.height,
    };

    // Chunk simulation across RAF frames so the main thread doesn't freeze.
    // Preview mode (home page "network map of the week") uses fewer ticks
    // since the graph is smaller and renders inside a card — users want it
    // up fast, not perfectly settled.
    const TOTAL_TICKS = previewMode ? 150 : 350;
    const TICKS_PER_FRAME = 35;
    let tickCount = 0;
    let cancelled = false;
    let rafId = 0;

    const finishLayout = () => {
      for (const simNode of simNodes) {
        const node = nodes.find(n => n.id === (simNode as any).id);
        if (node) {
          node.x = (simNode as any).x;
          node.y = (simNode as any).y;
        }
      }

      const prevNodeIds = new Set(nodesRef.current.map(n => n.id));
      const isFirstLoad = nodesRef.current.length === 0;
      const hasNewNodes = nodes.some(n => !prevNodeIds.has(n.id));
      const hasRemovedNodes = nodesRef.current.some(n => !new Set(nodes.map(nn => nn.id)).has(n.id));

      nodesRef.current = nodes;
      linksRef.current = links;

      for (const node of nodes) {
        if (node.photo && !photoCache.current[node.id]) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = node.photo;
          img.onload = () => { photoCache.current[node.id] = img; };
        }
      }
      const selfForPhoto = contacts.find(c => (c as any).is_self);
      if (selfForPhoto?.photo && !photoCache.current[selfForPhoto.id]) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = selfForPhoto.photo;
        img.onload = () => { photoCache.current[selfForPhoto.id] = img; };
      }

      if (isFirstLoad || hasRemovedNodes) {
        animProgressRef.current = 0;
      } else if (hasNewNodes) {
        animProgressRef.current = Math.max(animProgressRef.current, 0.7);
      }

      setLayoutProgress(100);
      setLayoutReady(true);
    };

    const tickChunk = () => {
      if (cancelled) return;
      const end = Math.min(tickCount + TICKS_PER_FRAME, TOTAL_TICKS);
      for (let i = tickCount; i < end; i++) sim.tick();
      tickCount = end;
      setLayoutProgress(Math.round((tickCount / TOTAL_TICKS) * 100));
      if (tickCount >= TOTAL_TICKS) finishLayout();
      else rafId = requestAnimationFrame(tickChunk);
    };

    rafId = requestAnimationFrame(tickChunk);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [contacts, dimensions, centerId, strengthFilter, timeFilter, tagFilter, activeProjectFilter, projects, hideIsolates, depthFromYou, mostActiveOnly]);

  // Sync reactive state into refs so the RAF render loop can read them
  // without the loop having to restart on every change.
  useEffect(() => { selectedContactIdRef.current = selectedContactId; }, [selectedContactId]);
  useEffect(() => { hoveredNodeRef.current = hoveredNode; }, [hoveredNode]);
  useEffect(() => { searchHighlightRef.current = searchHighlight; }, [searchHighlight]);
  useEffect(() => { pendingDeleteIdRef.current = pendingDeleteId; }, [pendingDeleteId]);
  useEffect(() => { pendingDeleteStartedAtRef.current = pendingDeleteStartedAt; }, [pendingDeleteStartedAt]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);
  useEffect(() => { hideNamesRef.current = hideNames; }, [hideNames]);
  useEffect(() => { centerIdRef.current = centerId; }, [centerId]);

  // Render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const cx = dimensions.width / 2;
    const cy = dimensions.height / 2;
    const maxR = Math.max(0, Math.min(cx, cy) - 70);

    if (dimensions.width === 0 || dimensions.height === 0) return;

    const render = () => {
      if (animProgressRef.current < 1) {
        animProgressRef.current = Math.min(1, animProgressRef.current + 0.035);
      }
      const ease = 1 - Math.pow(1 - animProgressRef.current, 3);

      // Pull dynamic state from refs (closures are stale after first run since
      // the effect doesn't re-bind on every state change — that's the fix).
      const selectedContactId = selectedContactIdRef.current;
      const hoveredNode = hoveredNodeRef.current;
      const searchHighlight = searchHighlightRef.current;
      const pendingDeleteId = pendingDeleteIdRef.current;
      const pendingDeleteStartedAt = pendingDeleteStartedAtRef.current;
      const zoom = zoomRef.current;
      const pan = panRef.current;
      const hideNames = hideNamesRef.current;
      const centerId = centerIdRef.current;

      // Read theme colors from CSS variables
      const rootStyle = getComputedStyle(document.documentElement);
      const textColor = rootStyle.getPropertyValue('--text-primary').trim();
      const bgColor = rootStyle.getPropertyValue('--bg-primary').trim();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, dimensions.width, dimensions.height);
      ctx.save();

      const offsetX = cx + pan.x;
      const offsetY = cy + pan.y;
      ctx.translate(offsetX, offsetY);
      ctx.scale(zoom, zoom);
      ctx.translate(-cx, -cy);

      const nodes = nodesRef.current;
      const links = linksRef.current;
      const time = Date.now() * 0.001;

      const isDarkTheme = !bgColor.startsWith('#f') && !bgColor.startsWith('#e');

      const selfContact = contacts.find(c => (c as any).is_self);
      const centerContact = centerId
        ? contacts.find(c => c.id === centerId)
        : selfContact || null;
      const centerColor = centerContact?.color || '#646cff';
      const centerLabel = centerContact
        ? (centerContact === selfContact ? 'You' : centerContact.name.split(' ')[0])
        : 'You';
      const isMobileCanvas = dimensions.width < 768;
      // Bigger center node so your photo reads at a glance. The expanded inner
      // ring band (radial force config) keeps neighboring contacts from crowding it.
      const youR = centerContact ? (isMobileCanvas ? 26 : 36) : (isMobileCanvas ? 16 : 22);

      // ── Orbital rings (concentric circles) ──
      const ringAlpha = isDarkTheme ? 0.06 : 0.08;
      const ringColor = isDarkTheme ? `rgba(255,255,255,${ringAlpha})` : `rgba(0,0,0,${ringAlpha})`;
      for (let r = 1; r <= 3; r++) {
        const ringR = maxR * (0.25 + r * 0.22);
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 1 / zoom;
        ctx.setLineDash([4 / zoom, 6 / zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw links FIRST (behind everything)

      // Faint lines from "You" only to contacts you directly know
      // A contact is "direct" (yours) if:
      //   - Notes contain a [date] transcript entry (you voice-input about THEM)
      //   - OR they have tasks (you're tracking work with them)
      //   - OR they have NO connections (standalone contact you added)
      // A contact is "2nd degree" (someone else's) if they only exist
      // because they were extracted as a connection name
      if (!centerId) {
        // Only draw spokes to contacts you directly know
        // Uses is_direct flag (set when contact is the primary subject of voice input
        // or manually added). Contacts created via "Create and link" are is_direct=false.
        // Fallback for old contacts without the flag: check for transcript entries.
        const secondDegreeIds = new Set<string>();
        for (const node of nodes) {
          const contact = contacts.find(c => c.id === node.id);
          if (!contact) continue;
          // Explicit flag takes priority
          if (contact.is_direct === false) {
            secondDegreeIds.add(node.id);
            continue;
          }
          if (contact.is_direct === true) continue;
          // Fallback for old contacts: no flag set
          const hasTranscript = /\[\w{3} \d{1,2}\]/.test(contact.notes);
          const hasConnections = contact.connections.length > 0;
          if (!hasTranscript && hasConnections && !contact.notes.trim()) {
            secondDegreeIds.add(node.id);
          }
        }

        for (const node of nodes) {
          if (secondDegreeIds.has(node.id)) continue;
          const nx = cx + (node.x - cx) * ease;
          const ny = cy + (node.y - cy) * ease;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(nx, ny);

          // Vary line style by relationship strength.
          // Alphas bumped from 0.4/0.25/0.12 to 0.6/0.4/0.22 — the old values
          // got swallowed by the dark/light backgrounds and the graph looked
          // like disconnected dots.
          if (node.daysAgo <= 7) {
            // Strong — solid, thick
            ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.6)' : 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = 2 / zoom;
            ctx.setLineDash([]);
          } else if (node.daysAgo <= 30) {
            // Good — dashed
            ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.25)';
            ctx.lineWidth = 1.5 / zoom;
            ctx.setLineDash([6 / zoom, 4 / zoom]);
          } else {
            // Casual — dotted but still visible
            ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.14)';
            ctx.lineWidth = 1 / zoom;
            ctx.setLineDash([3 / zoom, 5 / zoom]);
          }
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Draw links between contacts
      for (const link of links) {
        const source = nodes.find(n => n.id === link.source);
        const target = nodes.find(n => n.id === link.target);
        if (!source || !target) continue;

        const isHighlighted =
          selectedContactId === source.id || selectedContactId === target.id ||
          hoveredNode === source.id || hoveredNode === target.id;
        const dimmed = selectedContactId &&
          selectedContactId !== source.id && selectedContactId !== target.id;
        // Path highlight: edges in the BFS shortest path glow lavender
        const edgeKey = source.id < target.id ? `${source.id}:${target.id}` : `${target.id}:${source.id}`;
        const isOnPath = pathEdgeKeys.has(edgeKey);

        const sx = cx + (source.x - cx) * ease;
        const sy = cy + (source.y - cy) * ease;
        const tx = cx + (target.x - cx) * ease;
        const ty = cy + (target.y - cy) * ease;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);

        const avgDays = (source.daysAgo + target.daysAgo) / 2;

        if (isOnPath) {
          ctx.strokeStyle = '#7c5cff';
          ctx.lineWidth = 3 / zoom;
          ctx.shadowColor = '#7c5cff';
          ctx.shadowBlur = 10;
          ctx.setLineDash([]);
        } else if (isHighlighted) {
          ctx.strokeStyle = source.color + '80';
          ctx.lineWidth = 2 / zoom;
          ctx.shadowColor = source.color;
          ctx.shadowBlur = 6;
          ctx.setLineDash([]);
        } else if (dimmed) {
          ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)';
          ctx.lineWidth = 0.3 / zoom;
          ctx.shadowBlur = 0;
          ctx.setLineDash([]);
        } else if (avgDays <= 7) {
          ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.28)';
          ctx.lineWidth = 1.5 / zoom;
          ctx.shadowBlur = 0;
          ctx.setLineDash([]);
        } else if (avgDays <= 30) {
          ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.18)';
          ctx.lineWidth = 1.2 / zoom;
          ctx.shadowBlur = 0;
          ctx.setLineDash([6 / zoom, 4 / zoom]);
        } else {
          ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.12)';
          ctx.lineWidth = 1 / zoom;
          ctx.shadowBlur = 0;
          ctx.setLineDash([3 / zoom, 5 / zoom]);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);

        // Particle
        if (isHighlighted) {
          const t = (time * 0.3) % 1;
          const px = sx + (tx - sx) * t;
          const py = sy + (ty - sy) * t;
          ctx.beginPath();
          ctx.arc(px, py, 2.5 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = textColor;
          ctx.fill();
        }
      }

      // Center node (drawn AFTER lines so it's on top)
      const youGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, youR * 3);
      youGlow.addColorStop(0, centerColor + '18');
      youGlow.addColorStop(0.5, centerColor + '08');
      youGlow.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(cx, cy, youR * 3, 0, Math.PI * 2);
      ctx.fillStyle = youGlow;
      ctx.fill();

      const youGrad = ctx.createRadialGradient(cx - 4, cy - 4, 0, cx, cy, youR);
      youGrad.addColorStop(0, centerContact ? centerColor : '#646cff');
      youGrad.addColorStop(1, centerContact ? centerColor + 'cc' : '#4f46e5');
      ctx.beginPath();
      ctx.arc(cx, cy, youR, 0, Math.PI * 2);
      ctx.fillStyle = youGrad;
      ctx.fill();
      ctx.shadowColor = centerColor + '66';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = rootStyle.getPropertyValue('--border').trim();
      ctx.lineWidth = 1 / zoom;
      ctx.stroke();

      // Photo on the center node, if your self-contact has one uploaded
      const centerImg = centerContact ? photoCache.current[centerContact.id] : null;
      if (centerImg && centerImg.complete) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, youR - 1, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(centerImg, cx - youR + 1, cy - youR + 1, (youR - 1) * 2, (youR - 1) * 2);
        ctx.restore();
      } else if (!hideNames) {
        const centerFontSize = Math.min(11, youR * 0.4) / Math.max(zoom * 0.8, 0.6);
        ctx.font = `600 ${centerFontSize}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = textColor;
        ctx.fillText(centerLabel, cx, cy);
        ctx.textBaseline = 'alphabetic';
      }

      // Show company under the center node ONLY for someone you've focused on
      // (double-clicked to center). For yourself it's redundant noise — you
      // know where you work — and clutters the hub.
      if (centerContact?.company && !hideNames && centerContact !== selfContact) {
        ctx.font = `${7 / Math.max(zoom * 0.8, 0.6)}px Inter, sans-serif`;
        ctx.fillStyle = rootStyle.getPropertyValue('--text-secondary').trim();
        ctx.fillText(centerContact.company, cx, cy + youR + 12 / zoom);
      }

      // Draw nodes
      for (const node of nodes) {
        const isSelected = selectedContactId === node.id;
        const isHovered = hoveredNode === node.id;
        const isSearchMatch = searchHighlight === node.id;
        const isConnectedToSelected = selectedContactId &&
          links.some(l =>
            (l.source === selectedContactId && l.target === node.id) ||
            (l.target === selectedContactId && l.source === node.id)
          );
        const dimmed = selectedContactId && !isSelected && !isConnectedToSelected;

        const nx = cx + (node.x - cx) * ease;
        const ny = cy + (node.y - cy) * ease;
        // Pop-on-delete: while this node is the pendingDelete target, scale up
        // (1 → 1.35) and fade (1 → 0) over POP_MS. The actual store removal
        // fires at POP_MS end so the node never visually snaps.
        const isPopping = pendingDeleteId === node.id && pendingDeleteStartedAt != null;
        const popT = isPopping ? Math.min(1, (Date.now() - pendingDeleteStartedAt!) / POP_MS) : 0;
        const popEase = popT * (2 - popT); // ease-out
        const popScale = isPopping ? 1 + 0.35 * popEase : 1;
        const popAlphaMul = isPopping ? 1 - popEase : 1;
        const scale = (isSelected ? 1.18 : isHovered ? 1.08 : 1) * popScale;
        const r = node.radius * scale;
        const alpha = (dimmed ? 0.12 : node.recencyAlpha) * popAlphaMul;

        // Search match pulse
        if (isSearchMatch && !dimmed) {
          const pulseScale = 1 + Math.sin(time * 3) * 0.15;
          ctx.beginPath();
          ctx.arc(nx, ny, r * 2.5 * pulseScale, 0, Math.PI * 2);
          ctx.fillStyle = '#06b6d4' + '18';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(nx, ny, r * 1.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#06b6d4' + '60';
          ctx.lineWidth = 2 / zoom;
          ctx.stroke();
        }

        // Glow on select/hover
        if ((isSelected || isHovered || isSearchMatch) && !dimmed) {
          ctx.shadowColor = node.color;
          ctx.shadowBlur = 12;
          const glow = ctx.createRadialGradient(nx, ny, r * 0.5, nx, ny, r * 2);
          glow.addColorStop(0, node.color + '25');
          glow.addColorStop(1, 'transparent');
          ctx.beginPath();
          ctx.arc(nx, ny, r * 2, 0, Math.PI * 2);
          ctx.fillStyle = glow;
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        // Needs-attention halo: soft yellow radial glow behind the node.
        // Drawn FIRST so it sits under the node body and reads as ambient
        // glow rather than a border. Importance modifier (investor/vc/
        // partner tags) makes the halo brighter + larger to draw the eye.
        if (node.attention && !dimmed) {
          const pulse = Math.sin(time * 1.2) * 0.15 + 0.85;
          const important = node.attention.important;
          const reach = r * (important ? 2.6 : 2.2);
          const inner = important ? 0.75 : 0.55;
          const mid = important ? 0.40 : 0.25;
          const halo = ctx.createRadialGradient(nx, ny, r * 0.8, nx, ny, reach);
          halo.addColorStop(0,   `rgba(255, 215, 100, ${inner * pulse * alpha})`);
          halo.addColorStop(0.5, `rgba(255, 200, 80, ${mid * pulse * alpha})`);
          halo.addColorStop(1,   'rgba(255, 200, 80, 0)');
          ctx.beginPath();
          ctx.arc(nx, ny, reach, 0, Math.PI * 2);
          ctx.fillStyle = halo;
          ctx.fill();
        }

        // Node
        const isDark = isDarkTheme;
        const nodeAlpha = isDark ? alpha : Math.min(1, alpha * 1.3 + 0.15);
        // Clamp the byte value into [0,255] before hex — if any caller ever
        // passes alpha > 1 (e.g. future computation that doesn't cap), we
        // still emit a valid 2-char hex instead of 3 chars that produce a
        // 9-char color string and crash addColorStop.
        const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
        const a = clamp255(nodeAlpha * 255).toString(16).padStart(2, '0');
        const aDark = clamp255(nodeAlpha * 220).toString(16).padStart(2, '0');

        // ── Glass / 3D sphere rendering ──
        // Layer 1: soft drop shadow under the node (depth)
        ctx.save();
        ctx.shadowColor = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(17,18,26,0.22)';
        ctx.shadowBlur = (r * 0.65) / zoom;
        ctx.shadowOffsetY = (r * 0.12) / zoom;
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        // Off-center radial gradient — light from top-left, darker bottom-right
        const grad = ctx.createRadialGradient(nx - r * 0.4, ny - r * 0.45, r * 0.05, nx + r * 0.1, ny + r * 0.2, r * 1.15);
        grad.addColorStop(0,    node.color + a);
        grad.addColorStop(0.55, node.color + a);
        grad.addColorStop(1,    node.color + aDark);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();

        // Layer 2: specular highlight (small bright crescent top-left, like a glass sphere catching light)
        const specCx = nx - r * 0.35;
        const specCy = ny - r * 0.4;
        const spec = ctx.createRadialGradient(specCx, specCy, 0, specCx, specCy, r * 0.7);
        spec.addColorStop(0,   `rgba(255,255,255,${Math.min(0.55, alpha * 0.55)})`);
        spec.addColorStop(0.4, `rgba(255,255,255,${Math.min(0.10, alpha * 0.12)})`);
        spec.addColorStop(1,   'rgba(255,255,255,0)');
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fillStyle = spec;
        ctx.fill();

        // Layer 3: bottom inner shadow (sphere bottom darkens slightly — reinforces curvature)
        const bot = ctx.createRadialGradient(nx, ny + r * 0.3, r * 0.4, nx, ny + r * 0.1, r);
        bot.addColorStop(0, 'rgba(0,0,0,0)');
        bot.addColorStop(1, `rgba(0,0,0,${isDark ? 0.30 : 0.15})`);
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fillStyle = bot;
        ctx.fill();

        // Layer 4: rim — thin bright edge on top arc (glass meniscus), thin dark on bottom
        ctx.beginPath();
        ctx.arc(nx, ny, r, Math.PI * 1.1, Math.PI * 1.9);
        ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.45, alpha * 0.5)})`;
        ctx.lineWidth = 0.8 / zoom;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(nx, ny, r, Math.PI * 0.1, Math.PI * 0.9);
        ctx.strokeStyle = `rgba(0,0,0,${isDark ? 0.4 : 0.18})`;
        ctx.lineWidth = 0.8 / zoom;
        ctx.stroke();

        // Task indicator — small red dot at top-right of the node. Drawn
        // AFTER the node body so it sits on top. Replaces the prior gold
        // ring (which fought with the new sunset palette). Pulse keeps it
        // alive without being noisy.
        if (node.tasks > 0 && !dimmed) {
          const pulse = Math.sin(time * 1.6) * 0.15 + 0.85;
          const dx = nx + r * 0.72;
          const dy = ny - r * 0.72;
          const dr = Math.max(2.5, r * 0.22);
          // Small white halo so the dot reads against any node color
          ctx.beginPath();
          ctx.arc(dx, dy, dr + 1.2 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = isDark ? 'rgba(8,8,12,0.85)' : 'rgba(255,255,255,0.85)';
          ctx.fill();
          // The dot itself
          ctx.beginPath();
          ctx.arc(dx, dy, dr, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 80, 70, ${pulse * alpha})`;
          ctx.fill();
        }

        // Selection / hover rim — brighter accent stroke over everything
        if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(nx, ny, r + 0.5 / zoom, 0, Math.PI * 2);
          ctx.strokeStyle = isDark ? `rgba(255,255,255,${isSelected ? 0.7 : 0.45})` : `rgba(17,18,26,${isSelected ? 0.5 : 0.3})`;
          ctx.lineWidth = (isSelected ? 1.8 : 1.2) / zoom;
          ctx.stroke();
        }

        // Health score arc ring
        if (!dimmed && node.healthScore > 0) {
          const ringR = r + 3 / zoom;
          const arcLen = (node.healthScore / 100) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(nx, ny, ringR, -Math.PI / 2, -Math.PI / 2 + arcLen);
          ctx.strokeStyle = node.healthColor + (isSelected || isHovered ? 'cc' : '60');
          ctx.lineWidth = 1.5 / zoom;
          ctx.stroke();
        }

        // Avatar (photo or letter)
        const cachedImg = photoCache.current[node.id];
        if (cachedImg && cachedImg.complete) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(nx, ny, r - 1, 0, Math.PI * 2);
          ctx.clip();
          ctx.globalAlpha = alpha;
          ctx.drawImage(cachedImg, nx - r + 1, ny - r + 1, (r - 1) * 2, (r - 1) * 2);
          ctx.globalAlpha = 1;
          // Glass overlay on photo nodes — same top-left specular as solid nodes
          const photoSpecCx = nx - r * 0.35;
          const photoSpecCy = ny - r * 0.4;
          const photoSpec = ctx.createRadialGradient(photoSpecCx, photoSpecCy, 0, photoSpecCx, photoSpecCy, r * 0.65);
          photoSpec.addColorStop(0,   `rgba(255,255,255,${Math.min(0.35, alpha * 0.4)})`);
          photoSpec.addColorStop(0.5, 'rgba(255,255,255,0)');
          ctx.fillStyle = photoSpec;
          ctx.fill();
          ctx.restore();
        } else {
          const fontSize = Math.max(8, r * 0.5) / Math.max(zoom * 0.8, 0.6);
          ctx.font = `600 ${fontSize}px Inter, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = `rgba(255,255,255,${Math.max(0.7, alpha * 0.95)})`;
          ctx.fillText(displayInitial(node.name), nx, ny);
        }
        ctx.textBaseline = 'alphabetic';

        // Name labels — only for signal nodes (stardust stays unlabeled to reduce clutter)
        if (!hideNames && node.hasSignal) {
          const nameSize = (node.ring === 0 ? 11 : 10) / Math.max(zoom * 0.85, 0.7);
          ctx.font = `500 ${nameSize}px Inter, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = isDark
            ? (dimmed ? 'rgba(240, 240, 240, 0.2)' : 'rgba(240, 240, 240, 0.85)')
            : (dimmed ? 'rgba(10, 10, 10, 0.2)' : 'rgba(10, 10, 10, 0.8)');
          ctx.fillText(displayName(node.name), nx, ny + r + 12 / zoom);
        }

        // Extra info on hover
        if ((isHovered || isSelected) && !dimmed && !hideNames) {
          const metaSize = 7.5 / Math.max(zoom * 0.85, 0.7);
          if (node.company) {
            ctx.font = `${metaSize}px Inter, sans-serif`;
            ctx.fillStyle = `rgba(107, 107, 128, 0.8)`;
            ctx.fillText(node.company, nx, ny + r + 21 / zoom);
          }
          // Recency
          ctx.font = `${metaSize}px Inter, sans-serif`;
          ctx.fillStyle = node.daysAgo <= 3 ? 'rgba(100, 108, 255, 0.7)' : 'rgba(107, 107, 128, 0.5)';
          const recText = node.daysAgo === 0 ? 'today' : node.daysAgo === 1 ? 'yesterday' : `${node.daysAgo}d ago`;
          ctx.fillText(recText, nx, ny + r + (node.company ? 31 : 21) / zoom);
        }

        // Task count badge (gold)
        if (node.tasks > 0 && !dimmed) {
          const bx = nx + r * 0.6;
          const by = ny - r * 0.6;
          const br = 6.5 / Math.max(zoom * 0.8, 0.6);
          ctx.beginPath();
          ctx.arc(bx, by, br, 0, Math.PI * 2);
          ctx.fillStyle = isDark ? '#FFDE73' : '#D4A017';
          ctx.fill();
          ctx.font = `bold ${5.5 / Math.max(zoom * 0.8, 0.6)}px Inter, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = bgColor;
          ctx.fillText(String(node.tasks), bx, by + 2 / zoom);
        }
      }

      // ── Cluster labels: ONLY top 3 biggest org clusters; only when zoomed in close ──
      if (!hideNames && zoom >= 1.2) {
        const PUBLIC_DOMAINS = new Set(['gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','me.com','aol.com','protonmail.com','live.com','msn.com']);
        const clusters: Record<string, { x: number; y: number; count: number; color: string }> = {};
        for (const n of nodesRef.current) {
          const c = contacts.find(c => c.id === n.id);
          const email = c?.email;
          if (!email) continue;
          const domain = email.split('@')[1]?.toLowerCase();
          if (!domain || PUBLIC_DOMAINS.has(domain)) continue;
          const nx = cx + (n.x - cx) * ease;
          const ny = cy + (n.y - cy) * ease;
          if (!clusters[domain]) clusters[domain] = { x: 0, y: 0, count: 0, color: n.color };
          clusters[domain].x += nx;
          clusters[domain].y += ny;
          clusters[domain].count++;
        }
        // Show only top 3 by size, minimum 3 members
        const topClusters = Object.entries(clusters)
          .filter(([, c]) => c.count >= 3)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 3);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const [domain, c] of topClusters) {
          const lx = c.x / c.count;
          const ly = c.y / c.count - (32 + Math.sqrt(c.count) * 5) / zoom;
          const labelText = domain.split('.').slice(0, -1).join('.') || domain;
          ctx.font = `500 ${9 / Math.max(zoom * 0.85, 0.55)}px Inter, sans-serif`;
          const textWidth = ctx.measureText(labelText).width;
          const padX = 5 / zoom;
          const padY = 2.5 / zoom;
          const pillW = textWidth + padX * 2;
          const pillH = 11 / zoom + padY * 2;
          ctx.fillStyle = isDarkTheme ? 'rgba(20,20,28,0.55)' : 'rgba(255,255,255,0.7)';
          ctx.strokeStyle = c.color + '30';
          ctx.lineWidth = 0.7 / zoom;
          const pillX = lx - pillW / 2;
          const pillY = ly - pillH / 2;
          const pillR = 5 / zoom;
          ctx.beginPath();
          ctx.moveTo(pillX + pillR, pillY);
          ctx.lineTo(pillX + pillW - pillR, pillY);
          ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillR, pillR);
          ctx.lineTo(pillX + pillW, pillY + pillH - pillR);
          ctx.arcTo(pillX + pillW, pillY + pillH, pillX + pillW - pillR, pillY + pillH, pillR);
          ctx.lineTo(pillX + pillR, pillY + pillH);
          ctx.arcTo(pillX, pillY + pillH, pillX, pillY + pillH - pillR, pillR);
          ctx.lineTo(pillX, pillY + pillR);
          ctx.arcTo(pillX, pillY, pillX + pillR, pillY, pillR);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = c.color + 'CC';
          ctx.fillText(labelText, lx, ly);
        }
      }

      ctx.restore();

      // Throttle the render loop when the graph is idle. The continuous
      // 60fps redraw was hogging main-thread frames even when nothing was
      // actually changing on screen — that's why CSS animations on other
      // UI (the backfill pill, tooltips, hover states) felt choppy whenever
      // a NetworkGraph or NetworkPreview was on the page.
      //
      // Drop to ~15fps when: layout is settled, no node hovered, no node
      // being dragged, no panning, and the post-mount fade-in is complete.
      // Bumps back to 60fps the moment any of those flip — interaction
      // stays buttery.
      const idle =
        animProgressRef.current >= 1 &&
        !hoveredNodeRef.current &&
        !isDraggingNodeRef.current &&
        !isPanningRef.current &&
        !pendingDeleteIdRef.current;  // keep full fps during the pop animation
      if (idle) {
        idleTimerRef.current = window.setTimeout(() => {
          animRef.current = requestAnimationFrame(render);
        }, previewMode ? 200 : 60);  // 5fps preview, 16fps main when idle
      } else {
        animRef.current = requestAnimationFrame(render);
      }
    };

    render();
    return () => {
      cancelAnimationFrame(animRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  // RAF loop only needs to be torn down on canvas-size changes. All other
  // reactive state is read via refs, no tear-down/restart needed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensions]);

  // ── BFS shortest path from You (is_self) → target contact ──
  const pathResult = useMemo(() => {
    if (!pathTargetId) return null;
    const selfContact = contacts.find(c => (c as any).is_self);
    if (!selfContact) return null;
    if (pathTargetId === selfContact.id) return { hops: [selfContact.id], steps: 0 };

    const adj = new Map<string, string[]>();
    for (const c of contacts) adj.set(c.id, c.connections || []);

    const visited = new Set<string>([selfContact.id]);
    const queue: { id: string; path: string[] }[] = [{ id: selfContact.id, path: [selfContact.id] }];
    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (id === pathTargetId) return { hops: path, steps: path.length - 1 };
      for (const nb of adj.get(id) || []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        queue.push({ id: nb, path: [...path, nb] });
      }
    }
    return { hops: [], steps: -1 }; // unreachable
  }, [pathTargetId, contacts]);

  // Set of edge-keys (sorted) that are part of the path — for highlight rendering
  const pathEdgeKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!pathResult || pathResult.hops.length < 2) return keys;
    for (let i = 0; i < pathResult.hops.length - 1; i++) {
      const a = pathResult.hops[i], b = pathResult.hops[i + 1];
      keys.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
    return keys;
  }, [pathResult]);

  // Filter contacts for path search typeahead
  const pathSearchResults = useMemo(() => {
    if (!pathSearch.trim()) return [];
    const q = pathSearch.toLowerCase();
    return contacts
      .filter(c => !(c as any).is_self && (c.name.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [contacts, pathSearch]);

  // Interaction helpers
  const screenToCanvas = (sx: number, sy: number) => {
    const cxd = dimensions.width / 2;
    const cyd = dimensions.height / 2;
    return {
      x: (sx - cxd - pan.x) / zoom + cxd,
      y: (sy - cyd - pan.y) / zoom + cyd,
    };
  };

  // Check if a point is near a line segment (within threshold pixels)
  const getLinkAtPos = (canvasX: number, canvasY: number): Link | null => {
    const cxd = dimensions.width / 2;
    const cyd = dimensions.height / 2;
    const ease = animProgressRef.current;
    const threshold = 6 / zoom;

    for (const link of linksRef.current) {
      const source = nodesRef.current.find(n => n.id === link.source);
      const target = nodesRef.current.find(n => n.id === link.target);
      if (!source || !target) continue;

      const sx = cxd + (source.x - cxd) * ease;
      const sy = cyd + (source.y - cyd) * ease;
      const tx = cxd + (target.x - cxd) * ease;
      const ty = cyd + (target.y - cyd) * ease;

      // Distance from point to line segment
      const dx = tx - sx;
      const dy = ty - sy;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      const t = Math.max(0, Math.min(1, ((canvasX - sx) * dx + (canvasY - sy) * dy) / lenSq));
      const projX = sx + t * dx;
      const projY = sy + t * dy;
      const dist = Math.sqrt((canvasX - projX) ** 2 + (canvasY - projY) ** 2);
      if (dist < threshold) return link;
    }

    // Also check spoke lines (You → contact)
    for (const node of nodesRef.current) {
      const nx = cxd + (node.x - cxd) * ease;
      const ny = cyd + (node.y - cyd) * ease;
      const dx = nx - cxd;
      const dy = ny - cyd;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      const t = Math.max(0, Math.min(1, ((canvasX - cxd) * dx + (canvasY - cyd) * dy) / lenSq));
      const projX = cxd + t * dx;
      const projY = cyd + t * dy;
      const dist = Math.sqrt((canvasX - projX) ** 2 + (canvasY - projY) ** 2);
      if (dist < threshold) return { source: '__you__', target: node.id };
    }

    return null;
  };

  const getNodeAtPos = (canvasX: number, canvasY: number) => {
    const cxd = dimensions.width / 2;
    const cyd = dimensions.height / 2;
    const ease = animProgressRef.current;
    for (const node of [...nodesRef.current].reverse()) {
      const nx = cxd + (node.x - cxd) * ease;
      const ny = cyd + (node.y - cyd) * ease;
      const dx = canvasX - nx;
      const dy = canvasY - ny;
      if (dx * dx + dy * dy < (node.radius + 4) * (node.radius + 4)) return node;
    }
    return null;
  };

  // Center "You" node lives outside the regular nodes list — hit-test it
  // separately so clicks open the self-contact panel.
  const getCenterHit = (canvasX: number, canvasY: number) => {
    const self = contacts.find(c => (c as any).is_self);
    if (!self && !centerId) return null;
    const isMobileCanvas = dimensions.width < 768;
    const hasCenterContact = !!(centerId ? contacts.find(c => c.id === centerId) : self);
    const youR = hasCenterContact ? (isMobileCanvas ? 26 : 36) : (isMobileCanvas ? 16 : 22);
    const cxd = dimensions.width / 2;
    const cyd = dimensions.height / 2;
    const dx = canvasX - cxd;
    const dy = canvasY - cyd;
    if (dx * dx + dy * dy <= (youR + 4) * (youR + 4)) {
      return (centerId ? contacts.find(c => c.id === centerId)?.id : self?.id) || null;
    }
    return null;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();

    // Dragging a node
    if (isDraggingNodeRef.current) {
      const { x, y } = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
      const node = nodesRef.current.find(n => n.id === isDraggingNodeRef.current);
      if (node) {
        node.x = x;
        node.y = y;
      }
      setTooltip(null);
      return;
    }

    if (isPanningRef.current) {
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      setPan(p => ({ x: p.x + dx, y: p.y + dy }));
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      return;
    }
    const { x, y } = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
    const node = getNodeAtPos(x, y);
    setHoveredNode(node?.id || null);
    if (canvasRef.current) canvasRef.current.style.cursor = node ? 'grab' : 'default';
    setTooltip(node ? { x: e.clientX, y: e.clientY, node } : null);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
    const rect = canvasRef.current!.getBoundingClientRect();
    const { x, y } = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
    const node = getNodeAtPos(x, y);
    if (node) {
      isDraggingNodeRef.current = node.id;
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    } else {
      isPanningRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    const dx = e.clientX - mouseDownPosRef.current.x;
    const dy = e.clientY - mouseDownPosRef.current.y;
    const moved = Math.sqrt(dx * dx + dy * dy);
    const wasClick = moved < 5; // less than 5px = click, not drag

    if (isDraggingNodeRef.current) {
      const draggedId = isDraggingNodeRef.current;
      isDraggingNodeRef.current = null;
      if (canvasRef.current) canvasRef.current.style.cursor = 'default';
      if (wasClick) {
        setSelectedContact(draggedId);
      }
      return;
    }
    if (isPanningRef.current) {
      isPanningRef.current = false;
      if (canvasRef.current) canvasRef.current.style.cursor = 'default';
      if (wasClick) {
        // Could be a click on the center "You" node — it's drawn outside the
        // regular nodes list (is_self gets filtered from passesCoreFilters),
        // so mousedown defaulted to panning mode and we have to recheck here
        // before deselecting. Without this, clicking on yourself does nothing.
        const rect = canvasRef.current!.getBoundingClientRect();
        const { x, y } = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
        const centerHitId = getCenterHit(x, y);
        setSelectedContact(centerHitId);
      }
      return;
    }
    if (wasClick) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const { x, y } = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
      const node = getNodeAtPos(x, y);
      if (node) { setSelectedContact(node.id); return; }
      const centerHitId = getCenterHit(x, y);
      setSelectedContact(centerHitId);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { x, y } = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
    const node = getNodeAtPos(x, y);
    if (node) {
      setCenterId(node.id);
      setPan({ x: 0, y: 0 });
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => Math.max(0.4, Math.min(3, z * (e.deltaY > 0 ? 0.92 : 1.08))));
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const canvasPos = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
    const node = getNodeAtPos(canvasPos.x, canvasPos.y);
    const link = node ? null : getLinkAtPos(canvasPos.x, canvasPos.y);
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node?.id || null, link, canvasPos });
  };

  const handleConnectClick = (e: React.MouseEvent) => {
    if (!connectingFrom) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const { x, y } = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
    const node = getNodeAtPos(x, y);
    if (node && node.id !== connectingFrom) {
      addConnection(connectingFrom, node.id);
      addConnection(node.id, connectingFrom);
      setConnectingFrom(null);
    }
  };

  // Override mouseUp to handle connect mode
  const originalHandleMouseUp = handleMouseUp;
  const wrappedMouseUp = (e: React.MouseEvent) => {
    if (connectingFrom) {
      handleConnectClick(e);
      return;
    }
    originalHandleMouseUp(e);
  };

  const handleAdd = async () => {
    const name = prompt('Contact name:');
    if (name?.trim()) {
      await addContact({ name: name.trim(), is_direct: true });
      await fetchAll();
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {!previewMode && (
        <SharedHeader
          title="Network"
          subtitle="All your relationships, always up to date"
          onAdd={handleAdd}
          addLabel="Add contact"
        />
      )}
      <div className="relative flex-1 overflow-hidden" onClick={() => { setContextMenu(null); if (connectingFrom) setConnectingFrom(null); }}>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={wrappedMouseUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
        onMouseLeave={() => { setTooltip(null); setHoveredNode(null); isPanningRef.current = false; isDraggingNodeRef.current = null; }}
        className="w-full h-full transition-opacity duration-300 ease-out"
        // Hide canvas in preview mode until the force-sim has settled, so
        // the user doesn't see nodes jiggling during the ~80ms simulation
        // chunks. Fade in smoothly when ready.
        style={{
          width: dimensions.width,
          height: dimensions.height,
          opacity: previewMode && !layoutReady ? 0 : 1,
        }}
      />

      <AnimatePresence>
        {/* Two cases that show the orbit-loading overlay:
            1. Layout is still being computed (force sim running) — uses
               layoutProgress for the bar.
            2. Network is empty AND we're still in first-run (firstRunProgress
               below 95) — uses firstRunProgress for the bar so the user
               sees REAL progress + live counts, not a perpetual '0% mapping'
               from a force sim that has nothing to simulate. */}
        {!previewMode && (
          // Three reasons to show the overlay:
          //   1. Force sim is mid-tick (layoutReady=false)
          //   2. User has NO contacts beyond self AND no providers connected
          //      → show 'Connect a provider' CTA
          //   3. User has NO contacts beyond self AND providers connected
          //      but first-run progress < 95% → show real progress
          !layoutReady ||
          (firstRun.contactsCount === 0 && firstRun.providersLoaded && (
            !hasAnyProvider(firstRun) || firstRun.progress < 95
          ))
        ) && (
          <motion.div
            key="orbit-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 z-20 flex flex-col items-center justify-center pointer-events-none"
            style={{
              background: 'color-mix(in srgb, var(--bg-surface) 92%, transparent)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
            }}
          >
            <div className="relative" style={{ width: 160, height: 160 }}>
              {/* Three orbital paths — faint guide rings */}
              <svg viewBox="0 0 160 160" className="absolute inset-0 w-full h-full" style={{ opacity: 0.22 }}>
                <circle cx="80" cy="80" r="44" fill="none" stroke="var(--accent)" strokeWidth="1" />
                <circle cx="80" cy="80" r="62" fill="none" stroke="var(--accent)" strokeWidth="0.8" strokeDasharray="2 4" />
                <circle cx="80" cy="80" r="76" fill="none" stroke="var(--accent)" strokeWidth="0.6" strokeDasharray="1 6" />
              </svg>

              {/* Planet — center sphere with soft glow */}
              <div
                className="absolute"
                style={{
                  top: '50%',
                  left: '50%',
                  width: 30,
                  height: 30,
                  marginTop: -15,
                  marginLeft: -15,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle at 35% 30%, var(--accent), color-mix(in srgb, var(--accent) 55%, #000))',
                  boxShadow:
                    '0 0 26px color-mix(in srgb, var(--accent) 45%, transparent), inset -2px -3px 6px color-mix(in srgb, var(--accent) 40%, #000)',
                }}
              />

              {/* Orbiting stars — different radii, speeds, directions, phase offsets */}
              {[
                { r: 44, size: 4, duration: 3.0, reverse: false, start: 0 },
                { r: 44, size: 3, duration: 3.0, reverse: false, start: 180 },
                { r: 62, size: 5, duration: 4.8, reverse: true, start: 90 },
                { r: 62, size: 3, duration: 4.8, reverse: true, start: 270 },
                { r: 76, size: 4, duration: 7.2, reverse: false, start: 30 },
                { r: 76, size: 2, duration: 7.2, reverse: false, start: 210 },
              ].map((s, i) => (
                <motion.div
                  key={i}
                  className="absolute inset-0"
                  initial={{ rotate: s.start }}
                  animate={{ rotate: s.start + (s.reverse ? -360 : 360) }}
                  transition={{ duration: s.duration, repeat: Infinity, ease: 'linear' }}
                >
                  <div
                    className="absolute"
                    style={{
                      top: `calc(50% - ${s.r}px)`,
                      left: '50%',
                      width: s.size,
                      height: s.size,
                      marginLeft: -s.size / 2,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                      boxShadow: `0 0 ${s.size * 2.5}px var(--accent)`,
                    }}
                  />
                </motion.div>
              ))}
            </div>

            {(() => {
              // Three modes for the overlay:
              //   1. Empty network + no providers → CTA copy
              //   2. Empty network + providers + first-run in progress → unified
              //      progress + live counts
              //   3. Force sim running on a populated network → layout progress
              const empty = firstRun.contactsCount === 0;
              const noProviders = !hasAnyProvider(firstRun);
              if (empty && noProviders && firstRun.providersLoaded) {
                return (
                  <>
                    <div className="mt-7 text-sm font-medium text-[var(--text-primary)]">Connect a provider</div>
                    <div className="mt-3 text-[10.5px] text-[var(--text-secondary)]/70 max-w-[280px] text-center px-4">
                      Microsoft or Google pulls in your calendar, contacts, and email so we can map your network.
                    </div>
                  </>
                );
              }
              const showFirstRun = empty;
              const pct = showFirstRun ? firstRun.progress : layoutProgress;
              return (
                <>
                  <div className="mt-7 text-sm font-medium text-[var(--text-primary)]">
                    {empty ? 'Setting up your network' : 'Mapping your network'}
                  </div>
                  <div
                    className="mt-3 w-48 h-1 rounded-full overflow-hidden"
                    style={{ background: 'color-mix(in srgb, var(--accent) 18%, transparent)' }}
                  >
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: 'var(--accent)' }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                    />
                  </div>
                  <div className="mt-2 text-[11px] tabular-nums text-[var(--text-secondary)]">{pct}%</div>
                  {showFirstRun && (
                    <div className="mt-3 text-[10.5px] text-[var(--text-secondary)]/70 max-w-[280px] text-center tabular-nums px-4">
                      {firstRun.scannedTotal > 0
                        ? (firstRun.totalMailbox
                            ? `${firstRun.scannedTotal.toLocaleString()} of ${firstRun.totalMailbox.toLocaleString()} messages scanned · full history takes 2–5 min`
                            : `${firstRun.scannedTotal.toLocaleString()} messages scanned`)
                        : (firstRun.hasMicrosoft
                            ? 'Pulling your calendar, contacts, and email — 30–60 seconds.'
                            : 'Pulling your calendar and contacts — usually 30–60 seconds.')}
                    </div>
                  )}
                </>
              );
            })()}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Center indicator + back button */}
      {centerId && (
        <motion.button
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          onClick={() => { setCenterId(null); setPan({ x: 0, y: 0 }); }}
          className="absolute top-4 left-1/2 -translate-x-1/2 glass rounded-full px-4 py-2 flex items-center gap-2 text-xs
                   hover:border-[var(--teal)]/40 transition-colors"
        >
          <Home size={12} className="text-[var(--teal)]" />
          <span className="text-[var(--text-secondary)]">Viewing {contacts.find(c => c.id === centerId)?.name}&apos;s orbit</span>
          <span className="text-[var(--teal)]">Back to You</span>
        </motion.button>
      )}

      {/* Zoom controls — bottom right, slim */}
      {!previewMode && (
        <div className="absolute bottom-4 right-4 flex items-center gap-0.5 bg-[var(--bg-surface)]/85 backdrop-blur-md border border-[var(--border)] rounded-lg p-0.5 z-20">
          <button onClick={() => setZoom(z => Math.max(0.4, z * 0.8))}
            className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors"
            title="Zoom out">
            <ZoomOut size={12} />
          </button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); setCenterId(null); }}
            className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors"
            title="Reset view">
            <RotateCcw size={11} />
          </button>
          <button onClick={() => setZoom(z => Math.min(3, z * 1.25))}
            className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors"
            title="Zoom in">
            <ZoomIn size={12} />
          </button>
        </div>
      )}

      {/* Tooltip */}
      <AnimatePresence>
        {tooltip && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
            className="fixed pointer-events-none z-50"
            style={{ left: tooltip.x + 14, top: tooltip.y - 6 }}
          >
            <div className="glass rounded-lg p-2.5 min-w-[160px] max-w-[220px] shadow-xl border border-[var(--border)]">
              <div className="flex items-center gap-2">
                {tooltip.node.photo ? (
                  <img src={tooltip.node.photo} alt="" className="w-5 h-5 rounded-full object-cover" />
                ) : (
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
                    style={{ backgroundColor: tooltip.node.color + '25', color: tooltip.node.color }}>
                    {displayInitial(tooltip.node.name)}
                  </div>
                )}
                <div>
                  <p className="text-[11px] font-medium">{displayName(tooltip.node.name)}</p>
                  {tooltip.node.company && <p className="text-[9px] text-[var(--text-secondary)]">{tooltip.node.company}</p>}
                </div>
              </div>
              {tooltip.node.notes && (
                <p className="text-[9px] text-[var(--text-secondary)] mt-1.5 line-clamp-2 leading-relaxed">
                  {tooltip.node.notes.slice(0, 100)}{tooltip.node.notes.length > 100 ? '...' : ''}
                </p>
              )}
              {tooltip.node.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {tooltip.node.tags.slice(0, 3).map((tag) => {
                    const hue = [...tag].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
                    const color = `hsl(${hue}, 60%, 65%)`;
                    return <span key={tag} className="px-1.5 py-0 rounded text-[8px]" style={{ backgroundColor: color + '20', color }}>{tag}</span>;
                  })}
                </div>
              )}
              <div className="flex items-center gap-2 mt-1.5 text-[8px] text-[var(--text-secondary)]">
                {tooltip.node.connectionCount > 0 && <span className="text-[var(--accent)]">{tooltip.node.connectionCount} connections</span>}
                {tooltip.node.tasks > 0 && <span style={{ color: 'rgb(255, 80, 70)' }}>{tooltip.node.tasks} task{tooltip.node.tasks === 1 ? '' : 's'}</span>}
              </div>
              {tooltip.node.attention && (
                <div
                  className="mt-1.5 pt-1.5 border-t border-[var(--border)] text-[9.5px] flex items-center gap-1.5"
                  style={{ color: tooltip.node.attention.important ? 'rgb(255, 180, 60)' : 'rgb(255, 200, 80)' }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: tooltip.node.attention.important ? 'rgb(255, 180, 60)' : 'rgb(255, 200, 80)' }}
                  />
                  {tooltip.node.attention.reason}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty state — distinguishes "actively syncing" from "truly empty" */}
      {contacts.length === 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 flex items-center justify-center">
          <div className="text-center text-[var(--text-secondary)] max-w-xs px-6">
            <div className="w-14 h-14 rounded-full bg-[var(--accent)]/12 flex items-center justify-center mx-auto mb-4">
              <Loader2 size={20} className="animate-spin text-[var(--accent)]" />
            </div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Building your network</p>
            <p className="text-[11.5px] mt-2 leading-relaxed opacity-60">
              Pulling contacts from your calendar and email. First sync usually takes 30–60 seconds. Refresh if it&apos;s been a while.
            </p>
          </div>
        </motion.div>
      )}

      {/* Connect mode indicator */}
      {connectingFrom && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 glass-elevated rounded-full px-4 py-2 text-xs flex items-center gap-2 z-50">
          <span className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
          Click a contact to connect · <button onClick={() => setConnectingFrom(null)} className="text-[var(--text-secondary)] hover:text-white">Cancel</button>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-[60] glass-elevated rounded-xl py-1.5 min-w-[160px] text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.link ? (
            <>
              {/* Clicked on a line */}
              {contextMenu.link.source === '__you__' ? (
                /* Spoke line to You — no real connection to remove, just info */
                <p className="px-3 py-2 text-xs text-[var(--text-secondary)]">
                  Your connection to {contacts.find(c => c.id === contextMenu.link!.target)?.name}
                </p>
              ) : (
                <>
                  <p className="px-3 py-1.5 text-[10px] text-[var(--text-secondary)]">
                    {contacts.find(c => c.id === contextMenu.link!.source)?.name} — {contacts.find(c => c.id === contextMenu.link!.target)?.name}
                  </p>
                  <button
                    onClick={async () => {
                      await removeConnection(contextMenu.link!.source, contextMenu.link!.target);
                      await removeConnection(contextMenu.link!.target, contextMenu.link!.source);
                      setContextMenu(null);
                      await fetchAll();
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-[var(--hover-bg)] transition-colors text-xs text-red-400"
                  >
                    Remove connection
                  </button>
                </>
              )}
            </>
          ) : contextMenu.nodeId ? (
            <>
              <button
                onClick={() => {
                  setConnectingFrom(contextMenu.nodeId);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-2 hover:bg-[var(--hover-bg)] transition-colors flex items-center gap-2"
              >
                <span className="text-xs">Connect to...</span>
              </button>
              {/* Show existing connections to remove */}
              {(() => {
                const contact = contacts.find(c => c.id === contextMenu.nodeId);
                if (!contact || contact.connections.length === 0) return null;
                return (
                  <>
                    <div className="divider my-1" />
                    <p className="px-3 py-1 text-[10px] text-[var(--text-secondary)]">Remove connection:</p>
                    {contact.connections.map(connId => {
                      const conn = contacts.find(c => c.id === connId);
                      if (!conn) return null;
                      return (
                        <button
                          key={connId}
                          onClick={async () => {
                            await removeConnection(contact.id, connId);
                            await removeConnection(connId, contact.id);
                            setContextMenu(null);
                            await fetchAll();
                          }}
                          className="w-full text-left px-3 py-1.5 hover:bg-[var(--hover-bg)] transition-colors text-xs text-red-400/80 hover:text-red-400"
                        >
                          {conn.name}
                        </button>
                      );
                    })}
                  </>
                );
              })()}
              <div className="divider my-1" />
              <button
                onClick={async () => {
                  const nodeId = contextMenu.nodeId!;
                  const contact = contacts.find((c) => c.id === nodeId);
                  setContextMenu(null);
                  const ok = await confirm({
                    title: contact ? `Delete ${contact.name}?` : 'Delete this contact?',
                    description: 'This removes them, their tasks, and all their connections. This cannot be undone.',
                    confirmLabel: 'Delete',
                    destructive: true,
                  });
                  if (ok) {
                    try { await deleteWithPop(nodeId); }
                    catch (e: any) { addToast({ message: `Delete failed: ${e?.message || 'try again'}`, type: 'error' }); }
                  }
                }}
                className="w-full text-left px-3 py-2 hover:bg-[var(--hover-bg)] transition-colors text-xs text-red-400"
              >
                Delete contact
              </button>
            </>
          ) : (
            <button
              onClick={async () => {
                const name = prompt('Contact name:');
                if (!name?.trim()) { setContextMenu(null); return; }
                await addContact({ name: name.trim(), is_direct: true });
                await fetchAll();
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-2 hover:bg-[var(--hover-bg)] transition-colors flex items-center gap-2"
            >
              <span className="text-xs">Add contact here</span>
            </button>
          )}
        </div>
      )}

      {/* ── Intel popover — Network Health + AI Insights, gated on showIntel ── */}
      <AnimatePresence>
        {showIntel && !previewMode && (() => {
          const insights = getNetworkInsights(contacts);
          const insightIcons: Record<string, any> = { alert: AlertTriangle, clock: ClockIcon, users: UsersIcon, tasks: TasksIcon, trending: TrendingUp };
          return (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.18 }}
              className="absolute bottom-[calc(128px+env(safe-area-inset-bottom,0px))] md:bottom-16 left-4 z-40 w-[280px] bg-[var(--bg-surface)]/95 backdrop-blur-xl border border-[var(--border)] rounded-xl p-4 shadow-lg space-y-4"
            >
              {/* Health */}
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">Network health</span>
                  <button onClick={() => setShowIntel(false)} className="text-[var(--text-secondary)]/60 hover:text-[var(--text-primary)]">
                    <X size={11} />
                  </button>
                </div>
                <div className="flex items-center gap-3.5">
                  <div className="relative w-14 h-14 flex-shrink-0">
                    <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
                      <circle cx="32" cy="32" r="28" fill="none" stroke="var(--border)" strokeWidth="4" />
                      <circle cx="32" cy="32" r="28" fill="none" stroke={insights.color} strokeWidth="4"
                        strokeDasharray={`${insights.score * 1.76} ${176 - insights.score * 1.76}`}
                        strokeLinecap="round" className="transition-all duration-700" />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-base font-semibold" style={{ color: insights.color }}>{insights.score}</span>
                      <span className="text-[7px] text-[var(--text-secondary)]">{insights.label}</span>
                    </div>
                  </div>
                  <div className="flex-1 space-y-1.5">
                    {[
                      { label: 'Strength', value: insights.strength },
                      { label: 'Engagement', value: insights.engagement },
                      { label: 'Reachability', value: insights.reachability },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <div className="flex justify-between text-[9px] text-[var(--text-secondary)] mb-0.5">
                          <span>{label}</span>
                          <span>{value}%</span>
                        </div>
                        <div className="h-1 bg-[var(--border)] rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700" style={{
                            width: `${value}%`,
                            backgroundColor: insights.color,
                          }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Insights */}
              {insights.insights.length > 0 && (
                <div className="pt-3 border-t border-[var(--border)]">
                  <span className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-secondary)] block mb-2">AI insights</span>
                  <div className="space-y-1.5 max-h-[180px] overflow-y-auto">
                    {insights.insights.slice(0, 5).map((insight, i) => {
                      const Icon = insightIcons[insight.icon] || AlertTriangle;
                      return (
                        <div key={i} className="flex items-start gap-2">
                          <Icon size={11} style={{ color: insight.color }} className="flex-shrink-0 mt-0.5" />
                          <span className="text-[11.5px] leading-snug">{insight.text}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Edge-style legend */}
              <div className="pt-3 border-t border-[var(--border)] flex items-center justify-between text-[9px] text-[var(--text-secondary)]">
                <span className="flex items-center gap-1">
                  <svg width="14" height="2"><line x1="0" y1="1" x2="14" y2="1" stroke="currentColor" strokeWidth="2" opacity="0.8" /></svg> Strong
                </span>
                <span className="flex items-center gap-1">
                  <svg width="14" height="2"><line x1="0" y1="1" x2="14" y2="1" stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" opacity="0.5" /></svg> Good
                </span>
                <span className="flex items-center gap-1">
                  <svg width="14" height="2"><line x1="0" y1="1" x2="14" y2="1" stroke="currentColor" strokeWidth="1" strokeDasharray="1.5 2" opacity="0.25" /></svg> Casual
                </span>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* ── Unified toolbar — bottom-left tray ── */}
      {!previewMode && (
        <div className="absolute bottom-[calc(72px+env(safe-area-inset-bottom,0px))] md:bottom-4 left-4 right-4 md:right-auto flex items-center gap-1.5 z-40">
          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]" />
            <input
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (e.target.value.trim()) {
                  const match = nodesRef.current.find(n => n.name.toLowerCase().includes(e.target.value.toLowerCase()));
                  setSearchHighlight(match?.id || null);
                } else {
                  setSearchHighlight(null);
                }
              }}
              placeholder="Find…"
              className="w-36 bg-[var(--bg-surface)]/85 backdrop-blur-md border border-[var(--border)] rounded-lg pl-7 pr-2 py-1.5 text-[11.5px] focus:outline-none focus:border-[var(--accent)]/40 transition-colors placeholder:text-[var(--text-secondary)]/50"
            />
            {searchQuery && (
              <button onClick={() => { setSearchQuery(''); setSearchHighlight(null); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                <X size={10} />
              </button>
            )}
          </div>

          {/* Filter */}
          <button onClick={() => { setShowFilters(!showFilters); setShowPathFinder(false); setShowIntel(false); }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] border transition-all btn-press ${
              (strengthFilter !== 'all' || timeFilter !== 'all' || tagFilter || hideIsolates || depthFromYou !== 0)
                ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--bg-surface)]/85 backdrop-blur-md text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Filter by strength, recency, tags, reachability">
            <Filter size={11} />
            <span className="text-[10px] text-[var(--text-secondary)]">{nodesRef.current.length}/{contacts.length}</span>
          </button>

          {/* Path */}
          <button onClick={() => { setShowPathFinder(!showPathFinder); setShowFilters(false); setShowIntel(false); }}
            className={`p-2 rounded-lg border transition-all btn-press ${
              pathTargetId
                ? 'border-[#7c5cff]/40 bg-[#7c5cff]/10 text-[#7c5cff]'
                : 'border-[var(--border)] bg-[var(--bg-surface)]/85 backdrop-blur-md text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Find shortest path">
            <GitBranch size={11} />
          </button>

          {/* Intel — health + AI insights */}
          <button onClick={() => { setShowIntel(!showIntel); setShowFilters(false); setShowPathFinder(false); }}
            className={`p-2 rounded-lg border transition-all btn-press ${
              showIntel
                ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--bg-surface)]/85 backdrop-blur-md text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Network health & insights">
            <Activity size={11} />
          </button>

          {/* Hide names */}
          <button onClick={() => setHideNames(!hideNames)}
            className={`p-2 rounded-lg border transition-all btn-press ${
              hideNames
                ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--bg-surface)]/85 backdrop-blur-md text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title={hideNames ? 'Show names' : 'Hide names'}>
            {hideNames ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        </div>
      )}

      {/* ── Path finder panel ── */}
      <AnimatePresence>
        {showPathFinder && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="absolute bottom-[calc(128px+env(safe-area-inset-bottom,0px))] md:bottom-16 left-4 z-40 bg-[var(--bg-surface)]/95 backdrop-blur-xl border border-[var(--border)] rounded-xl p-3 w-[300px] shadow-lg"
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] flex items-center gap-1.5">
                <GitBranch size={11} className="text-[#7c5cff]" /> Find path to…
              </p>
              <button onClick={() => { setShowPathFinder(false); setPathTargetId(null); setPathSearch(''); }}
                className="text-[var(--text-secondary)]/60 hover:text-[var(--text-primary)]">
                <X size={11} />
              </button>
            </div>

            <input
              value={pathSearch}
              onChange={(e) => { setPathSearch(e.target.value); setPathTargetId(null); }}
              placeholder="Type a contact name…"
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-[var(--input-bg)] border border-[var(--border)] text-sm focus:outline-none focus:border-[#7c5cff]/40 transition-colors placeholder:text-[var(--text-secondary)]/50"
            />

            {/* Typeahead results */}
            {pathSearch.trim() && pathSearchResults.length > 0 && !pathTargetId && (
              <div className="mt-2 max-h-[180px] overflow-y-auto space-y-0.5">
                {pathSearchResults.map((c) => (
                  <button key={c.id} onClick={() => setPathTargetId(c.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--hover-bg)] transition-colors text-left">
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-semibold flex-shrink-0"
                      style={{ backgroundColor: (c.color || '#7c5cff') + '20', color: c.color || '#7c5cff' }}>
                      {c.name.charAt(0)}
                    </div>
                    <span className="text-[12px] truncate">{c.name}</span>
                    {c.company && <span className="text-[10px] text-[var(--text-secondary)] truncate ml-auto">{c.company}</span>}
                  </button>
                ))}
              </div>
            )}

            {/* Path result */}
            {pathTargetId && pathResult && (
              <div className="mt-3 pt-3 border-t border-[var(--border)]">
                {pathResult.steps === -1 ? (
                  <p className="text-[11.5px] text-[var(--danger)] flex items-center gap-1.5">
                    <X size={11} /> No path — they're disconnected from your graph
                  </p>
                ) : (
                  <>
                    <p className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mb-2">
                      Shortest path · {pathResult.steps} hop{pathResult.steps !== 1 ? 's' : ''}
                    </p>
                    <div className="space-y-1">
                      {pathResult.hops.map((hopId, i) => {
                        const c = contacts.find(x => x.id === hopId);
                        if (!c) return null;
                        const isYou = (c as any).is_self;
                        const isTarget = i === pathResult.hops.length - 1;
                        return (
                          <div key={hopId} className="flex items-center gap-2">
                            <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-semibold flex-shrink-0"
                              style={{
                                backgroundColor: isYou ? '#7c5cff' : (c.color || '#94a3b8') + '20',
                                color: isYou ? 'white' : (c.color || '#94a3b8'),
                              }}>
                              {isYou ? 'Y' : c.name.charAt(0)}
                            </div>
                            <span className={`text-[12px] ${isTarget ? 'font-medium text-[#7c5cff]' : ''}`}>
                              {isYou ? 'You' : c.name}
                            </span>
                            {i < pathResult.hops.length - 1 && (
                              <ArrowRight size={10} className="ml-auto text-[var(--text-secondary)]/40" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <button
                      onClick={() => { setSelectedContact(pathTargetId); }}
                      className="mt-3 w-full text-[11px] py-1.5 rounded-md bg-[#7c5cff]/10 text-[#7c5cff] hover:bg-[#7c5cff]/20 transition-colors"
                    >
                      Open contact panel
                    </button>
                  </>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Filter panel — slides down ── */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="absolute bottom-[calc(128px+env(safe-area-inset-bottom,0px))] md:bottom-16 left-4 z-40 bg-[var(--bg-surface)]/90 backdrop-blur-xl border border-[var(--border)] rounded-xl p-3 space-y-3 min-w-[280px] shadow-lg"
          >
            {/* Time — the only "narrow" the user actually reaches for. */}
            <div>
              <p className="text-[9px] text-[var(--text-secondary)] tracking-[0.1em] mb-1.5">TIME</p>
              <div className="flex flex-wrap gap-1">
                {([
                  ['all', 'All'],
                  ['3days', '3 days'],
                  ['week', '1 week'],
                  ['2weeks', '2 weeks'],
                  ['month', '1 month'],
                  ['3months', '3 months'],
                ] as const).map(([val, label]) => (
                  <button key={val} onClick={() => setTimeFilter(val)}
                    className={`px-2 py-1 rounded-md text-[10px] transition-all btn-press ${timeFilter === val ? 'bg-[var(--accent)]/15 text-[var(--accent)] font-medium' : 'text-[var(--text-secondary)] opacity-50 hover:opacity-100'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Most active — top 25 by email volume */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={mostActiveOnly}
                  onChange={(e) => setMostActiveOnly(e.target.checked)}
                  className="w-3 h-3 accent-[var(--accent)]" />
                <span className="text-[10px] text-[var(--text-primary)]">Most active conversations</span>
              </label>
              <p className="text-[9px] text-[var(--text-secondary)] mt-0.5 ml-5">Top 25 by email volume</p>
            </div>

            {/* Clear all */}
            {(timeFilter !== 'all' || mostActiveOnly) && (
              <button onClick={() => { setTimeFilter('all'); setMostActiveOnly(false); }}
                className="text-[10px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors">
                Clear all
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}

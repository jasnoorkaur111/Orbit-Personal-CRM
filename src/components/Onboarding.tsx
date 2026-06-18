'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, ChevronLeft, ChevronDown, Loader2, Sun, Moon, Monitor, Check, Calendar, AlertCircle, ExternalLink } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useCrmStore } from '@/store/useCrmStore';
import { getStorage, setStorage, removeStorage } from '@/lib/storage';
import OrbitLogo from '@/components/OrbitLogo';

// Module-scoped start markers — survive React strict-mode double-invoke AND
// component re-mount. Without this the hero loader visibly restarted on every
// effect re-run, which read as "loading twice." Two markers because the entry
// loader (step 0) and the exit loader (after step 6) each own their timeline.
const heroStart: { current: number | null } = { current: null };
const exitStart: { current: number | null } = { current: null };
// Tracks which user the timers belong to. If the auth user changes (logout
// then a different sign-in in the same browser tab), the timers are zeroed
// so the new user actually sees their loader animate from 0%. Module-scoped
// so it persists alongside heroStart/exitStart — they need to invalidate
// together or not at all.
const lastUserId: { current: string | null } = { current: null };

export default function Onboarding({ onComplete }: { onComplete: () => void }) {
  // Step persists across OAuth bounces (user clicks Connect → leaves → returns).
  // If the URL shows ?microsoft=connected or ?google=connected, jump straight to
  // the post-connect step (skip the hero/intro re-watch).
  const [step, setStep] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const url = new URL(window.location.href);
    if (url.searchParams.get('microsoft') === 'connected' || url.searchParams.get('google') === 'connected') {
      // Steps: Hero=0, Name=1, How=2, Connect=3, Appearance=4, Ready=6 (5 unused)
      // After OAuth bounce, skip past Connect to Appearance.
      return 4;
    }
    const saved = parseInt(getStorage('crm-onboarding-step') || '0', 10);
    return Number.isFinite(saved) && saved >= 0 && saved <= 6 ? saved : 0;
  });
  const [googleUrl, setGoogleUrl] = useState('');
  const [outlookUrl, setOutlookUrl] = useState('');
  const [saving, setSaving] = useState(false);
  // OAuth connection state — polled while the user is on the connect step
  const [msConnected, setMsConnected] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Default matches app default (dark); use saved choice if present
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>(() => {
    const saved = getStorage('crm-theme');
    return (saved === 'dark' || saved === 'light' || saved === 'system') ? saved : 'dark';
  });
  const { user } = useAuth();
  const { syncCalendar, fetchAll } = useCrmStore();
  // Pre-fill name from supabase auth metadata (Google sign-in usually carries
  // full_name; magic-link / email-pw usually doesn't). User can edit either way.
  const initialName =
    ((user?.user_metadata as { full_name?: string; name?: string } | undefined)?.full_name) ||
    ((user?.user_metadata as { full_name?: string; name?: string } | undefined)?.name) ||
    '';
  const [nameInput, setNameInput] = useState(initialName);
  // Keep nameInput in sync if auth resolves after first render.
  useEffect(() => { if (initialName && !nameInput) setNameInput(initialName); }, [initialName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Survives across React strict-mode's dev-only mount → unmount → remount.
  // Was a closure var inside the canvas effect; that reset on every re-run,
  // restarting the animation visibly and reading as a "double refresh".
  const canvasStartRef = useRef<number>(0);

  // If the auth user changed since the last time we ran (logout → different
  // sign-in on the same tab), clear the module-scoped loader timers so the
  // new user actually sees their loader animate from 0%, not auto-fast-forward
  // to 100% off whatever the previous user's clock was.
  useEffect(() => {
    if (!user?.id) return;
    if (lastUserId.current !== user.id) {
      heroStart.current = null;
      exitStart.current = null;
      lastUserId.current = user.id;
    }
  }, [user?.id]);

  // True while the "Entering Orbit" exit loader is running on top of step 6.
  // When the loader completes, onComplete fires and we leave onboarding.
  const [exiting, setExiting] = useState(false);

  // Provider-first sub-view nav inside the Connect step. Picking a provider
  // slides in a sub-view scoped to that provider's connection options
  // (OAuth + link for Microsoft/Google, link-only for Apple). Null = the
  // provider list. Internal to step 3, not a route change — the step
  // counter still reads "3 of 6" so it doesn't feel like leaving onboarding.
  const [connectSubview, setConnectSubview] = useState<'microsoft' | 'google' | 'apple' | null>(null);

  // OAuth callback failure — usually means the user's admin blocks third-party
  // apps. We surface a banner on the Connect step and pre-expand the iCal
  // section so they have an obvious path forward instead of bouncing.
  const [oauthError, setOauthError] = useState<{ provider: string; message: string } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const err = url.searchParams.get('error');
    if (!err) return;
    // Best-effort provider attribution from the same URL.
    const provider = url.searchParams.get('microsoft') === 'error' ? 'Microsoft'
      : url.searchParams.get('google') === 'error' ? 'Google'
      : 'Direct sign-in';
    setOauthError({ provider, message: err });
    // Land the user directly inside the failed provider's sub-view so they
    // see the failure context AND the alternate path (calendar link) on the
    // same screen.
    if (provider === 'Microsoft') setConnectSubview('microsoft');
    else if (provider === 'Google') setConnectSubview('google');
  }, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  // ── Custom cursor (pure DOM, no state) ──
  useEffect(() => {
    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!dot || !ring) return;

    let mx = 0, my = 0, rx = 0, ry = 0;

    const onMove = (e: MouseEvent) => { mx = e.clientX; my = e.clientY; };
    const onOver = (e: MouseEvent) => {
      const t = (e.target as HTMLElement).closest('button, a, input, label, summary, [role="button"]');
      if (t) { ring.style.width = '56px'; ring.style.height = '56px'; ring.style.borderColor = 'rgba(6,182,212,0.6)'; }
      else { ring.style.width = '36px'; ring.style.height = '36px'; ring.style.borderColor = 'rgba(255,255,255,0.2)'; }
    };

    // Smooth ring follow with lerp
    let raf: number;
    const animate = () => {
      rx += (mx - rx) * 0.15;
      ry += (my - ry) * 0.15;
      dot.style.transform = `translate(${mx - 4}px, ${my - 4}px)`;
      ring.style.transform = `translate(${rx - parseFloat(ring.style.width || '36') / 2}px, ${ry - parseFloat(ring.style.height || '36') / 2}px)`;
      raf = requestAnimationFrame(animate);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseover', onOver);
    animate();

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseover', onOver);
      cancelAnimationFrame(raf);
    };
  }, []);

  // ── Particle network canvas ──
  // Deferred: the hero step mounts a 3D silhouette (Three.js dynamic import)
  // AND the entrance motion at the same time. Adding 80 particles with
  // O(n²) pair-connection drawing into that same first-paint window made
  // the hero animation visibly stutter. We now wait 220ms (past the hero's
  // first paint) before initializing, and use 50 particles instead of 80.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf: number = 0;
    let cancelled = false;
    let mouse = { x: -999, y: -999 };
    let ctx: CanvasRenderingContext2D | null = null;
    // Each particle has a current position + a target (where it lives in the
    // drift phase). Bloom phase eases current → target; then drift takes over.
    const particles: { x: number; y: number; tx: number; ty: number; vx: number; vy: number }[] = [];
    // Hero choreography: orbital scene + loader holds ~2.4s while the
    // percentage ticks to 100, then particles disperse outward. Bloom is
    // gated so it kicks in just as the loader completes.
    const BLOOM_DELAY = 2400;
    const BLOOM_MS = 900;

    const onMove = (e: MouseEvent) => { mouse = { x: e.clientX, y: e.clientY }; };
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };

    // Smooth easeOutCubic — feels snappy at the start, settles softly.
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const draw = (ts: number) => {
      if (!ctx) return;
      // Stable start timestamp — stored on a ref that survives strict-mode
      // remount, so the bloom timing doesn't restart from 0 on every effect
      // re-run during dev.
      if (!canvasStartRef.current) canvasStartRef.current = ts;
      const elapsed = ts - canvasStartRef.current;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      // ── Phase 1: Pre-bloom (silhouette is the star) ──
      // Nothing drawn. Particles stay at center, invisible. Canvas is dark
      // so the silhouette + drop-shadow read cleanly.
      if (elapsed < BLOOM_DELAY) {
        raf = requestAnimationFrame(draw);
        return;
      }

      // ── Phase 2 / 3: Bloom (disperse outward) → Drift ──
      const sinceBloom = elapsed - BLOOM_DELAY;
      const blooming = sinceBloom < BLOOM_MS;
      const bloomProgress = Math.min(1, sinceBloom / BLOOM_MS);
      const eased = easeOutCubic(bloomProgress);

      for (const p of particles) {
        if (blooming) {
          p.x = cx + (p.tx - cx) * eased;
          p.y = cy + (p.ty - cy) * eased;
        } else {
          const dx = p.x - mouse.x;
          const dy = p.y - mouse.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            p.vx += dx * 0.0003;
            p.vy += dy * 0.0003;
          }
          p.x += p.vx;
          p.y += p.vy;
          p.vx *= 0.999;
          p.vy *= 0.999;
          if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
          if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        }
      }

      const linkAlpha = 0.06 * eased;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 140) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(99, 102, 241, ${linkAlpha * (1 - dist / 140)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      const radius = 0.4 + 1.1 * eased;
      const dotAlpha = 0.05 + 0.2 * eased;
      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(6, 182, 212, ${dotAlpha})`;
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };

    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMove);
    const cxInit = canvas.width / 2;
    const cyInit = canvas.height / 2;
    for (let i = 0; i < 50; i++) {
      // Small jitter around center for the spawn so particles don't all share
      // one pixel — gives a tiny cluster that explodes outward.
      const jx = cxInit + (Math.random() - 0.5) * 8;
      const jy = cyInit + (Math.random() - 0.5) * 8;
      particles.push({
        x: jx,
        y: jy,
        tx: Math.random() * canvas.width,
        ty: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
      });
    }
    raf = requestAnimationFrame(draw);

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  // Persist step across OAuth bounce + reloads
  useEffect(() => { setStorage('crm-onboarding-step', String(step)); }, [step]);

  // Poll user_settings every 2s while on the connect step so the UI updates
  // the moment the OAuth callback writes tokens (popup or redirect-flow return).
  useEffect(() => {
    if (step !== 3 || !user) return;
    const check = async () => {
      const { data } = await supabase
        .from('user_settings')
        .select('microsoft_access_token, google_access_token')
        .eq('user_id', user.id)
        .maybeSingle();
      if (data) {
        setMsConnected(!!data.microsoft_access_token);
        setGoogleConnected(!!data.google_access_token);
      }
    };
    check();
    const id = setInterval(check, 2000);
    return () => clearInterval(id);
  }, [step, user]);

  const handleSaveCalendars = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const settings: Record<string, unknown> = { user_id: user.id, updated_at: new Date().toISOString() };
      if (googleUrl.trim()) settings.google_calendar_url = googleUrl.trim();
      if (outlookUrl.trim()) settings.outlook_calendar_url = outlookUrl.trim();
      // Upsert avoids a race between two clicks (or a pre-existing row from OAuth)
      // creating a unique-constraint collision.
      await supabase.from('user_settings').upsert(settings, { onConflict: 'user_id' });
    } finally { setSaving(false); }
  };

  const applyTheme = (t: 'dark' | 'light' | 'system') => {
    setTheme(t);
    if (t === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', t);
    }
    setStorage('crm-theme', t);   // matches the key the layout boot script + ThemeToggle read
  };

  // Fire-and-forget: don't block the Continue button on the save round-trip.
  // The save is purely additive (auth metadata + self-contact row); if it
  // hits a network blip, the next sync still picks up the name from auth
  // metadata. Previously this was awaited, so any throw (or a slow round-trip)
  // left the button spinning and the user stuck on this step.
  const saveNameInBackground = (name: string) => {
    if (!name || !user) return;
    (async () => {
      try {
        await supabase.auth.updateUser({ data: { full_name: name } });
        await supabase
          .from('contacts')
          .update({ name })
          .eq('user_id', user.id)
          .eq('is_self', true);
        fetchAll(); // also background — don't await
      } catch (e) {
        console.error('[onboarding] save name failed (advancing anyway):', e);
      }
    })();
  };

  const handleNext = async () => {
    if (step === 1) {
      if (!nameInput.trim()) return;
      saveNameInBackground(nameInput.trim());
    }
    if (step === 3 && (googleUrl.trim() || outlookUrl.trim())) {
      try { await handleSaveCalendars(); syncCalendar(); }
      catch (e) { console.error('[onboarding] calendar save failed (advancing anyway):', e); }
    }
    if (step < 6) {
      // Step 5 (the old pricing step) is gone — skip straight to Ready (6).
      let next = step + 1;
      if (next === 5) next = 6;
      setStep(next);
    } else {
      // Dead path — nav bar hides at step 6 so handleNext can't be invoked
      // from the Continue button. Kept for safety if a keybinding wires here.
      removeStorage('crm-onboarding-step');
      onComplete();
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-[#08080c] text-white overflow-y-auto" style={{ cursor: 'none' }}>
      {/* Custom cursor */}
      <div ref={dotRef} className="hidden md:block fixed top-0 left-0 pointer-events-none z-[300]"
        style={{ width: 8, height: 8, background: '#fff', borderRadius: '50%', mixBlendMode: 'difference' }} />
      <div ref={ringRef} className="hidden md:block fixed top-0 left-0 pointer-events-none z-[300] rounded-full"
        style={{ width: 36, height: 36, border: '1px solid rgba(255,255,255,0.2)', transition: 'width 0.3s, height 0.3s, border-color 0.3s' }} />

      {/* Particle canvas */}
      <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none" style={{ zIndex: 0 }} />

      {/* Exit loader — appears when user clicks "Enter Orbit" on step 6.
         Same orbital scene + percentage UX as the network graph loader.
         When it completes, onComplete fires and we leave onboarding. */}
      <AnimatePresence>
        {exiting && (
          <ExitLoader onDone={onComplete} />
        )}
      </AnimatePresence>

      <div className="relative z-10 min-h-screen flex flex-col items-center justify-center px-5 md:px-8 py-16">
        {/* Progress — top */}
        <div className="fixed top-8 left-1/2 -translate-x-1/2 flex items-center gap-2 w-[240px] z-20">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <button key={i} onClick={() => setStep(i)}
              className={`h-[2px] rounded-full transition-all duration-700 flex-1 ${i <= step ? 'bg-[#06b6d4]' : 'bg-white/[0.04]'}`} />
          ))}
        </div>

        <AnimatePresence mode="wait">
          {/* ── Step 0: Cinematic 3-beat reveal ──
              Beat 0: silhouette alone (ORBIT mark above)
              Beat 1: + headline drops in below
              Beat 2: + description + CTA
              Auto-advances every 2.4s; click anywhere or press Space/Enter to skip ahead. */}
          {step === 0 && <HeroSequence onContinue={handleNext} />}

          {/* ── Step 1: Name ── */}
          {step === 1 && (
            <motion.div key="name" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }} className="max-w-md mx-auto w-full">

              <div className="text-center mb-12">
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
                  className="text-[10px] text-[#06b6d4] font-semibold mb-4" style={{ letterSpacing: '0.2em' }}>HELLO</motion.p>
                <motion.h2 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.6 }}
                  style={{ fontSize: 'clamp(1.8rem, 4vw, 2.8rem)', fontWeight: 700, letterSpacing: '-0.04em' }}>
                  What should we <span className="text-[#06b6d4]">call you?</span>
                </motion.h2>
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}
                  className="text-white/30 mt-3" style={{ fontWeight: 300, fontSize: '0.9rem' }}>
                  This is the name that anchors your network. You sit at the center of the graph.
                </motion.p>
              </div>

              <motion.input
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && nameInput.trim()) handleNext(); }}
                placeholder="Your name"
                autoFocus
                className="w-full bg-white/[0.02] border border-white/[0.06] rounded-xl px-5 py-4 text-base text-center
                           focus:outline-none focus:border-[#06b6d4]/40 transition-all placeholder:text-white/15"
              />

              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }}
                className="text-[11px] text-white/20 mt-4 text-center">
                You can change this any time in Settings.
              </motion.p>
            </motion.div>
          )}

          {/* ── Step 2: How it works — clean, spaced ── */}
          {step === 2 && (
            <motion.div key="how" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }} className="max-w-xl mx-auto w-full">

              <div className="text-center mb-12">
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
                  className="text-[10px] text-[#06b6d4] font-semibold mb-4" style={{ letterSpacing: '0.2em' }}>HOW IT WORKS</motion.p>
                <motion.h2 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.6 }}
                  style={{ fontSize: 'clamp(1.8rem, 4vw, 2.8rem)', fontWeight: 700, letterSpacing: '-0.04em' }}>
                  Speak. Parse. <span className="text-[#06b6d4]">Connect.</span>
                </motion.h2>
              </div>

              {/* Rows centered as a group so they sit on the same vertical
                 axis as the headline above. Grid keeps numbers right-aligned
                 in their column, titles left-aligned in theirs — creates a
                 visual spine running down the middle. */}
              <div className="max-w-sm mx-auto space-y-5">
                {[
                  { num: '01', title: 'Speak naturally about anyone you met' },
                  { num: '02', title: 'We extract contacts, tasks, and connections' },
                  { num: '03', title: 'Your network graph updates in real-time' },
                ].map((item, i) => (
                  <motion.div key={item.num} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 + i * 0.15, duration: 0.6 }}
                    className="grid grid-cols-[auto_1fr] items-center gap-5">
                    <span className="text-3xl font-bold text-right text-white/30 tabular-nums" style={{ letterSpacing: '-0.04em' }}>{item.num}</span>
                    <p className="text-[15px] font-medium text-white/75" style={{ letterSpacing: '-0.01em' }}>{item.title}</p>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── Step 3: Connect — provider-first list → sub-view ── */}
          {step === 3 && (
            <motion.div key="cal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }} className="max-w-lg mx-auto w-full">
              <AnimatePresence mode="wait">
                {!connectSubview ? (
                  /* ── Provider list ── */
                  <motion.div
                    key="provider-list"
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <div className="text-center mb-10">
                      <p className="text-[10px] text-[#06b6d4] font-semibold mb-4" style={{ letterSpacing: '0.2em' }}>CONNECT</p>
                      <h2 style={{ fontSize: 'clamp(1.8rem, 4vw, 2.8rem)', fontWeight: 700, letterSpacing: '-0.04em' }}>
                        Which calendar do you <span className="text-[#06b6d4]">use?</span>
                      </h2>
                      <p className="text-white/30 mt-3 max-w-md mx-auto" style={{ fontWeight: 300, fontSize: '0.9rem' }}>
                        We&apos;ll pull your calendar + email to map who you actually talk to.
                        <br className="hidden md:inline" />
                        {' '}Nothing leaves your account.
                      </p>
                    </div>

                    <div className="space-y-3">
                      {/* Microsoft */}
                      <ProviderRow
                        onClick={() => setConnectSubview('microsoft')}
                        connected={msConnected}
                        accent="#0078D4"
                        title="Microsoft / Outlook"
                        sub="Work email, school, or Office 365"
                        icon={<svg width="18" height="18" viewBox="0 0 21 21" fill="#0078D4"><rect x="1" y="1" width="9" height="9"/><rect x="11" y="1" width="9" height="9"/><rect x="1" y="11" width="9" height="9"/><rect x="11" y="11" width="9" height="9"/></svg>}
                      />
                      {/* Google */}
                      <ProviderRow
                        onClick={() => setConnectSubview('google')}
                        connected={googleConnected}
                        accent="#4285F4"
                        title="Google"
                        sub="Gmail, Workspace, or anything @google"
                        icon={<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>}
                      />
                      {/* Apple */}
                      <ProviderRow
                        onClick={() => setConnectSubview('apple')}
                        connected={!!outlookUrl.trim() || !!googleUrl.trim()}
                        accent="#06b6d4"
                        title="Apple Calendar"
                        sub="iCloud, or any other calendar"
                        icon={<Calendar size={16} className="text-[#06b6d4]" strokeWidth={1.8} />}
                      />
                    </div>

                    {!msConnected && !googleConnected && !googleUrl && !outlookUrl && (
                      <p className="text-center text-[10px] text-white/20 mt-6">
                        You can skip and set this up later in Settings — the app works best with at least one source.
                      </p>
                    )}
                  </motion.div>
                ) : (
                  /* ── Provider sub-view (back to list with back arrow) ── */
                  <motion.div
                    key={`sub-${connectSubview}`}
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <button
                      type="button"
                      onClick={() => setConnectSubview(null)}
                      className="flex items-center gap-1.5 text-[11px] text-white/35 hover:text-white/70 transition-colors mb-6"
                    >
                      <ChevronLeft size={12} /> All options
                    </button>

                    <div className="mb-8">
                      <p className="text-[10px] text-[#06b6d4] font-semibold mb-3" style={{ letterSpacing: '0.2em' }}>
                        {connectSubview === 'microsoft' ? 'MICROSOFT / OUTLOOK'
                          : connectSubview === 'google' ? 'GOOGLE'
                          : 'APPLE CALENDAR'}
                      </p>
                      <h3 style={{ fontSize: '1.6rem', fontWeight: 700, letterSpacing: '-0.03em' }}>
                        {connectSubview === 'apple'
                          ? <>Add your <span className="text-[#06b6d4]">iCloud link</span></>
                          : <>Sign in or <span className="text-[#06b6d4]">paste a link</span></>}
                      </h3>
                    </div>

                    {/* OAuth failure banner — only when the failure was for THIS provider */}
                    {oauthError && oauthError.provider.toLowerCase() === connectSubview && (
                      <div className="mb-5 px-4 py-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] flex items-start gap-2.5">
                        <AlertCircle size={14} className="text-amber-300/80 mt-0.5 flex-shrink-0" />
                        <div className="flex-1 text-[11.5px] text-amber-100/80 leading-relaxed">
                          Sign-in didn&apos;t go through. Often this means your work admin blocks third-party apps. Use the calendar link below instead.
                        </div>
                      </div>
                    )}

                    {/* OAuth primary CTA (Microsoft + Google only) */}
                    {(connectSubview === 'microsoft' || connectSubview === 'google') && (
                      <a
                        href={user ? `/api/auth/${connectSubview}?user_id=${user.id}&return_to=${encodeURIComponent('/')}` : '#'}
                        className={`flex items-center justify-center gap-2.5 w-full px-5 py-3.5 rounded-xl border transition-all ${
                          (connectSubview === 'microsoft' ? msConnected : googleConnected)
                            ? 'border-[#10b981]/30 bg-[#10b981]/[0.04] text-[#10b981]'
                            : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12] text-white'
                        }`}
                      >
                        {(connectSubview === 'microsoft' ? msConnected : googleConnected) ? (
                          <><Check size={14} /> <span className="text-[13px] font-medium">Connected</span></>
                        ) : (
                          <span className="text-[13px] font-medium">
                            Sign in with {connectSubview === 'microsoft' ? 'Microsoft' : 'Google'}
                          </span>
                        )}
                      </a>
                    )}

                    {/* "or" divider — only between OAuth and the link option */}
                    {(connectSubview === 'microsoft' || connectSubview === 'google') && (
                      <div className="flex items-center gap-3 my-6">
                        <div className="flex-1 h-px bg-white/[0.06]" />
                        <span className="text-[9px] text-white/30 uppercase" style={{ letterSpacing: '0.18em' }}>or</span>
                        <div className="flex-1 h-px bg-white/[0.06]" />
                      </div>
                    )}

                    {/* iCal / link section — scoped to this provider */}
                    {(() => {
                      const guides = {
                        microsoft: {
                          href: 'https://outlook.office.com/calendar/options/calendar/sharedCalendars',
                          cta: 'Open Outlook Calendar settings',
                          inputLabel: 'Outlook ICS link',
                          inputPlaceholder: 'https://outlook.office365.com/owa/calendar/…/calendar.ics',
                          value: outlookUrl,
                          set: setOutlookUrl,
                          intro: 'If sign-in is blocked, paste a calendar link instead:',
                          steps: [
                            'Open Outlook Calendar settings (button above).',
                            'Go to "Shared calendars" → "Publish a calendar".',
                            'Pick your calendar, click Publish, then copy the ICS link.',
                          ],
                        },
                        google: {
                          href: 'https://calendar.google.com/calendar/u/0/r/settings',
                          cta: 'Open Google Calendar settings',
                          inputLabel: 'Google iCal link',
                          inputPlaceholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
                          value: googleUrl,
                          set: setGoogleUrl,
                          intro: 'If sign-in is blocked, paste a calendar link instead:',
                          steps: [
                            'Open Google Calendar settings (button above).',
                            'In the left sidebar, click the calendar you want to share.',
                            'Scroll to "Integrate calendar" and copy the "Secret address in iCal format".',
                          ],
                        },
                        apple: {
                          href: 'https://www.icloud.com/calendar',
                          cta: 'Open iCloud Calendar',
                          inputLabel: 'iCloud Calendar link',
                          inputPlaceholder: 'https://p…-caldav.icloud.com/published/…',
                          value: outlookUrl,
                          set: setOutlookUrl,
                          intro: '',
                          steps: [
                            'Open iCloud Calendar (button above) and sign in.',
                            'Hover over a calendar in the sidebar, click the wifi-style share icon.',
                            'Toggle "Public Calendar" on, then copy the URL it shows. Replace webcal:// with https://',
                          ],
                        },
                      }[connectSubview];
                      return (
                        <div className="space-y-4">
                          {guides.intro && (
                            <p className="text-[12px] text-white/45">{guides.intro}</p>
                          )}

                          {/* Deeplink — opens the provider's actual settings page */}
                          <a
                            href={guides.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-between gap-2 px-4 py-3 rounded-lg border border-[#06b6d4]/25 bg-[#06b6d4]/[0.06] hover:bg-[#06b6d4]/[0.1] transition-colors text-[12.5px] text-[#06b6d4] font-medium"
                          >
                            <span>{guides.cta}</span>
                            <ExternalLink size={12} />
                          </a>

                          {/* 3 imperative steps */}
                          <ol className="space-y-2.5 pl-1">
                            {guides.steps.map((step, i) => (
                              <li key={i} className="flex items-start gap-3 text-[12px] text-white/65 leading-relaxed">
                                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-white/[0.06] text-white/55 text-[9px] font-semibold flex items-center justify-center mt-0.5">
                                  {i + 1}
                                </span>
                                <span>{step}</span>
                              </li>
                            ))}
                          </ol>

                          {/* Input */}
                          <div className="pt-1">
                            <label className="block text-[9px] text-white/30 mb-1.5 font-medium" style={{ letterSpacing: '0.1em' }}>
                              {guides.inputLabel.toUpperCase()}
                            </label>
                            <input
                              value={guides.value}
                              onChange={(e) => guides.set(e.target.value)}
                              placeholder={guides.inputPlaceholder}
                              className="w-full bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2.5 text-sm
                                         focus:outline-none focus:border-[#06b6d4]/40 transition-all placeholder:text-white/15"
                            />
                            {guides.value.trim() && (
                              <p className="text-[10.5px] text-[#10b981] mt-2 flex items-center gap-1.5">
                                <Check size={11} /> Link added — we&apos;ll sync once you continue.
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {/* ── Step 4: Theme picker (Appearance) ── */}
          {step === 4 && (
            <motion.div key="theme" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }} className="max-w-lg mx-auto w-full text-center">

              <div className="mb-14">
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
                  className="text-[10px] text-[#06b6d4] font-semibold mb-4" style={{ letterSpacing: '0.2em' }}>APPEARANCE</motion.p>
                <motion.h2 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.6 }}
                  style={{ fontSize: 'clamp(1.8rem, 4vw, 2.8rem)', fontWeight: 700, letterSpacing: '-0.04em' }}>
                  Choose your <span className="text-[#06b6d4]">mode</span>
                </motion.h2>
              </div>

              <div className="flex gap-4 justify-center">
                {([
                  { id: 'dark' as const, icon: Moon, label: 'Dark' },
                  { id: 'light' as const, icon: Sun, label: 'Light' },
                  { id: 'system' as const, icon: Monitor, label: 'System' },
                ]).map((opt, i) => (
                  <motion.button key={opt.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 + i * 0.1 }}
                    onClick={() => applyTheme(opt.id)}
                    className={`relative flex-1 max-w-[160px] flex flex-col items-center gap-4 p-8 rounded-2xl border transition-all duration-500 ${
                      theme === opt.id
                        ? 'border-[#06b6d4]/30 bg-[#06b6d4]/[0.04]'
                        : 'border-white/[0.03] bg-white/[0.01] hover:bg-white/[0.03]'
                    }`}>
                    <opt.icon size={28} strokeWidth={1} className={`transition-all duration-500 ${theme === opt.id ? 'text-[#06b6d4]' : 'text-white/20'}`} />
                    <span className={`text-sm font-medium transition-colors duration-500 ${theme === opt.id ? 'text-white' : 'text-white/30'}`}>{opt.label}</span>
                    {theme === opt.id && (
                      <motion.div layoutId="themeBar" className="absolute bottom-3 w-8 h-[2px] rounded-full bg-[#06b6d4]"
                        transition={{ type: 'spring', stiffness: 500, damping: 35 }} />
                    )}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── Step 6: Ready ── */}
          {step === 6 && (
            <motion.div key="ready" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }} className="text-center max-w-lg mx-auto">

              <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.1, duration: 0.6 }}
                className="w-16 h-16 rounded-2xl bg-[#06b6d4]/8 flex items-center justify-center mx-auto mb-10
                           shadow-[0_0_80px_rgba(6,182,212,0.08)]">
                <OrbitLogo size={32} className="text-white" />
              </motion.div>

              <motion.h2 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3, duration: 0.6 }}
                style={{ fontSize: 'clamp(1.8rem, 4vw, 2.8rem)', fontWeight: 700, letterSpacing: '-0.04em' }}>
                You're <span className="text-[#06b6d4]">ready</span>
              </motion.h2>

              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}
                className="text-white/20 mt-4 mb-16" style={{ fontWeight: 300, fontSize: '0.95rem' }}>
                Every conversation matters. Start building.
              </motion.p>

              <motion.button initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.7, duration: 0.5 }}
                onClick={() => { removeStorage('crm-onboarding-step'); setExiting(true); }}
                className="px-9 py-4 rounded-full bg-white text-[#08080c] text-sm font-medium
                           hover:shadow-[0_0_50px_rgba(255,255,255,0.15)] hover:scale-[1.03] active:scale-[0.97]
                           transition-all duration-300">
                Enter Orbit
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Navigation — shown on every step except hero (0) and final (6). */}
        {step > 0 && step < 6 && (
          <div className="fixed bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-6 z-20">
            <button onClick={() => setStep(step - 1)}
              className="flex items-center gap-1 text-sm text-white/20 hover:text-white/40 transition-colors">
              <ChevronLeft size={14} /> Back
            </button>
            <button onClick={() => { removeStorage('crm-onboarding-step'); onComplete(); }} className="text-[10px] text-white/10 hover:text-white/25 transition-colors" style={{ letterSpacing: '0.1em' }}>SKIP</button>
            <button onClick={handleNext}
              disabled={saving || (step === 1 && !nameInput.trim())}
              className="flex items-center gap-1.5 px-6 py-2.5 rounded-full bg-white/[0.06] border border-white/[0.06] text-sm text-white/70
                         hover:bg-white/[0.1] hover:border-white/[0.1] active:scale-[0.97] transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed">
              {saving && <Loader2 size={13} className="animate-spin" />}
              Continue <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// HeroSequence — orbital "loading scene" that fills a percentage bar to
// 100%, then dissolves into the wordmark. Same visual vocabulary as the
// network graph's loading overlay (planet + stars + progress + percent),
// so every "the app is materializing" moment in the product feels like
// one continuous brand.
//
// Timing is driven by a single startRef so React's strict-mode dev
// double-invoke can't restart the animation mid-flight (was reading as
// a "double refresh").
// ─────────────────────────────────────────────
function HeroSequence({ onContinue }: { onContinue: () => void }) {
  const LOAD_MS = 2200;
  const HOLD_MS = 250;
  // Capture the start time exactly once across all remounts — module-scoped
  // so strict-mode dev mount→cleanup→mount (and any other lifecycle quirk)
  // can't restart the timeline. Computed progress is then a pure function of
  // wall-clock elapsed time, so even if this effect re-runs the animation
  // CONTINUES from where it actually is, not from 0.
  if (heroStart.current === null) heroStart.current = performance.now();
  const initialPct = Math.min(100, Math.round(((performance.now() - heroStart.current) / LOAD_MS) * 100));
  const [progress, setProgress] = useState(initialPct);
  const [phase, setPhase] = useState<'loading' | 'reveal'>(initialPct >= 100 ? 'reveal' : 'loading');

  useEffect(() => {
    if (phase !== 'loading') return;
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const elapsed = performance.now() - (heroStart.current ?? performance.now());
      const pct = Math.min(100, Math.round((elapsed / LOAD_MS) * 100));
      setProgress(pct);
      if (pct >= 100) {
        setTimeout(() => { if (!cancelled) setPhase('reveal'); }, HOLD_MS);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelled = true; if (raf) cancelAnimationFrame(raf); };
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') onContinue();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onContinue]);

  return (
    <motion.div
      key="hero"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="text-center max-w-4xl mx-auto select-none flex flex-col items-center justify-center min-h-[80vh] px-6"
    >
      {/* Phase 'loading' — orbital scene + progress bar + percent counter.
         Same visual vocabulary as the NetworkGraph loading overlay so the
         brand reads as one continuous loading→ready transition. */}
      <AnimatePresence>
        {phase === 'loading' && (
          <motion.div
            key="loading-scene"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none flex flex-col items-center"
          >
            {/* Orbital scene */}
            <div className="relative" style={{ width: 260, height: 260 }}>
              <svg viewBox="0 0 260 260" className="absolute inset-0 w-full h-full" style={{ opacity: 0.28 }}>
                <circle cx="130" cy="130" r="70" fill="none" stroke="#06b6d4" strokeWidth="1" />
                <circle cx="130" cy="130" r="100" fill="none" stroke="#06b6d4" strokeWidth="0.9" strokeDasharray="2 5" />
                <circle cx="130" cy="130" r="124" fill="none" stroke="#06b6d4" strokeWidth="0.7" strokeDasharray="1 7" />
              </svg>

              <div
                className="absolute"
                style={{
                  top: '50%',
                  left: '50%',
                  width: 44,
                  height: 44,
                  marginTop: -22,
                  marginLeft: -22,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle at 35% 30%, #22d3ee, #0e7490)',
                  boxShadow: '0 0 36px rgba(6,182,212,0.45), inset -3px -4px 8px rgba(0,0,0,0.45)',
                }}
              />

              {[
                { r: 70, size: 5, duration: 3.4, reverse: false, start: 0 },
                { r: 70, size: 3, duration: 3.4, reverse: false, start: 200 },
                { r: 100, size: 6, duration: 5.2, reverse: true, start: 80 },
                { r: 100, size: 4, duration: 5.2, reverse: true, start: 260 },
                { r: 124, size: 5, duration: 7.8, reverse: false, start: 40 },
                { r: 124, size: 3, duration: 7.8, reverse: false, start: 220 },
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
                      background: '#06b6d4',
                      boxShadow: `0 0 ${s.size * 2.8}px #06b6d4`,
                    }}
                  />
                </motion.div>
              ))}
            </div>

            {/* Caption + progress bar + percentage */}
            <div className="mt-4 text-[10px] font-medium tracking-[0.2em] text-white/40 uppercase">
              Let&apos;s map your network
            </div>
            <div
              className="mt-3 w-56 h-[3px] rounded-full overflow-hidden"
              style={{ background: 'rgba(6,182,212,0.12)' }}
            >
              <motion.div
                className="h-full rounded-full"
                style={{ background: '#06b6d4' }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.15, ease: 'linear' }}
              />
            </div>
            <div className="mt-2 text-[11px] tabular-nums text-[#06b6d4]/80">
              {progress}%
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Phase 'reveal' — text cascades in after the loader completes.
         Gating on phase (not delay) means the timing is single-take: no
         restart on dev strict-mode remount, no race with the canvas. */}
      {phase === 'reveal' && (
        <>
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.0, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center justify-center gap-2 mb-6"
          >
            <OrbitLogo size={18} className="text-white" />
            <span className="text-[10px] font-semibold text-white/30" style={{ letterSpacing: '0.2em' }}>ORBIT</span>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            style={{ letterSpacing: '-0.05em', lineHeight: 0.95 }}
          >
            <span className="inline-block mr-[0.3em]" style={{ fontSize: 'clamp(2.4rem, 6vw, 4.5rem)', fontWeight: 700 }}>Every</span>
            <span className="inline-block mr-[0.3em]" style={{ fontSize: 'clamp(2.4rem, 6vw, 4.5rem)', fontWeight: 700 }}>relationship,</span>
            <br />
            <span className="inline-block text-[#06b6d4]" style={{ fontSize: 'clamp(2.4rem, 6vw, 4.5rem)', fontWeight: 700 }}>remembered.</span>
          </motion.div>

          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="text-white/35 max-w-md mx-auto leading-relaxed mt-7"
            style={{ fontSize: 'clamp(0.85rem, 1.5vw, 1.05rem)', fontWeight: 300 }}
          >
            Voice-first CRM that maps your network, tracks every interaction,
            and keeps every connection alive.
          </motion.p>

          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.6, ease: [0.16, 1, 0.3, 1] }}
            onClick={onContinue}
            className="mt-10 px-9 py-4 rounded-full bg-white text-[#08080c] text-sm font-medium
                       hover:shadow-[0_0_50px_rgba(255,255,255,0.15)] hover:scale-[1.03] active:scale-[0.97]
                       transition-all duration-300"
          >
            Get started <ChevronRight size={14} className="inline ml-1" />
          </motion.button>
        </>
      )}
    </motion.div>
  );
}

// ─────────────────────────────────────────────
// ExitLoader — the same orbital + percentage loader the user saw at step 0,
// reused as the "Entering Orbit" transition between the last onboarding
// step and the live app. Keeps brand language consistent across every
// "the app is materializing" moment.
// Timing is shorter (1.6s) than the entry loader (2.2s) because they've
// already seen this shape once — it just needs to feel like a deliberate
// transition, not a wait.
// ─────────────────────────────────────────────
function ExitLoader({ onDone }: { onDone: () => void }) {
  const LOAD_MS = 1600;
  const HOLD_MS = 220;
  if (exitStart.current === null) exitStart.current = performance.now();
  const initialPct = Math.min(100, Math.round(((performance.now() - exitStart.current) / LOAD_MS) * 100));
  const [progress, setProgress] = useState(initialPct);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    let doneTimer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (cancelled) return;
      const elapsed = performance.now() - (exitStart.current ?? performance.now());
      const pct = Math.min(100, Math.round((elapsed / LOAD_MS) * 100));
      setProgress(pct);
      if (pct >= 100) {
        doneTimer = setTimeout(() => { if (!cancelled) onDone(); }, HOLD_MS);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (doneTimer) clearTimeout(doneTimer);
    };
  }, [onDone]);

  return (
    <motion.div
      key="exit-loader"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-[#08080c]"
    >
      <div className="relative" style={{ width: 260, height: 260 }}>
        <svg viewBox="0 0 260 260" className="absolute inset-0 w-full h-full" style={{ opacity: 0.28 }}>
          <circle cx="130" cy="130" r="70" fill="none" stroke="#06b6d4" strokeWidth="1" />
          <circle cx="130" cy="130" r="100" fill="none" stroke="#06b6d4" strokeWidth="0.9" strokeDasharray="2 5" />
          <circle cx="130" cy="130" r="124" fill="none" stroke="#06b6d4" strokeWidth="0.7" strokeDasharray="1 7" />
        </svg>

        <div
          className="absolute"
          style={{
            top: '50%',
            left: '50%',
            width: 44,
            height: 44,
            marginTop: -22,
            marginLeft: -22,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 30%, #22d3ee, #0e7490)',
            boxShadow: '0 0 36px rgba(6,182,212,0.45), inset -3px -4px 8px rgba(0,0,0,0.45)',
          }}
        />

        {[
          { r: 70, size: 5, duration: 3.4, reverse: false, start: 0 },
          { r: 70, size: 3, duration: 3.4, reverse: false, start: 200 },
          { r: 100, size: 6, duration: 5.2, reverse: true, start: 80 },
          { r: 100, size: 4, duration: 5.2, reverse: true, start: 260 },
          { r: 124, size: 5, duration: 7.8, reverse: false, start: 40 },
          { r: 124, size: 3, duration: 7.8, reverse: false, start: 220 },
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
                background: '#06b6d4',
                boxShadow: `0 0 ${s.size * 2.8}px #06b6d4`,
              }}
            />
          </motion.div>
        ))}
      </div>

      <div className="mt-4 text-[10px] font-medium tracking-[0.2em] text-white/40 uppercase">
        Entering orbit
      </div>
      <div
        className="mt-3 w-56 h-[3px] rounded-full overflow-hidden"
        style={{ background: 'rgba(6,182,212,0.12)' }}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ background: '#06b6d4' }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.15, ease: 'linear' }}
        />
      </div>
      <div className="mt-2 text-[11px] tabular-nums text-[#06b6d4]/80">
        {progress}%
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────
// ProviderRow — the card-style button used in the Connect step's
// provider list (Microsoft / Google / Apple). Clicking it slides the
// user into that provider's sub-view. Visual state is the SAME shape
// across all three so users don't have to learn three card patterns.
// ─────────────────────────────────────────────
function ProviderRow({
  onClick, connected, accent, title, sub, icon,
}: {
  onClick: () => void;
  connected: boolean;
  accent: string;
  title: string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-4 px-5 py-4 rounded-xl border transition-all ${
        connected
          ? 'border-[#10b981]/30 bg-[#10b981]/[0.04]'
          : 'border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.04]'
      }`}
      style={!connected ? { borderColor: 'rgba(255,255,255,0.05)' } : undefined}
    >
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: `${accent}26` }}
      >
        {icon}
      </div>
      <div className="flex-1 text-left">
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="text-[11px] text-white/30 mt-0.5">{sub}</p>
      </div>
      {connected ? (
        <span className="text-[11px] text-[#10b981] font-medium flex items-center gap-1">
          <Check size={12} /> Connected
        </span>
      ) : (
        <ChevronRight size={14} className="text-white/40" />
      )}
    </button>
  );
}

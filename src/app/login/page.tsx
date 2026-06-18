'use client';

import { useState, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import OrbitLogo from '@/components/OrbitLogo';

// Same particle silhouette used by Onboarding step 0 — sits behind the form
// as ambient atmosphere so the sign-in surface visually rhymes with onboarding.
const HumanSilhouette = dynamic(() => import('@/components/HumanSilhouette'), {
  ssr: false, loading: () => null,
});

export default function LoginPage() {
  // Suspense boundary required because LoginContent reads useSearchParams,
  // which Next.js wants wrapped at the page boundary for streaming.
  return (
    <Suspense fallback={<div className="h-screen w-screen flex items-center justify-center bg-[#08080c] text-white" />}>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Single toggle for both password fields — when the user reveals one they
  // almost always want to verify the other matches, so separate toggles would
  // just be extra clicks.
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { signIn, signUp } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Read where to send the user after auth. Only accept paths starting with
  // a single "/" so we can't be tricked into sending users to an attacker
  // URL via ?next=https://evil.com (open-redirect bug). Defaults to /.
  const nextRaw = searchParams.get('next');
  const next = nextRaw && nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/';

  const isSignUp = mode === 'signup';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccess('');
    setSubmitting(true);

    if (isSignUp) {
      if (password !== confirmPassword) {
        setError('Passwords do not match'); setSubmitting(false); return;
      }
      const { error, session } = await signUp(email, password);
      if (error) {
        setError(error);
      } else if (session) {
        // Supabase email-confirmation OFF → instant session → straight to onboarding.
        router.push(next);
      } else {
        // Confirmation ON → wait for email click.
        setSuccess('Check your email to confirm your account.');
      }
    } else {
      const { error } = await signIn(email, password);
      if (error) setError(typeof error === 'string' ? error : (error as any).message);
      else router.push(next);
    }

    setSubmitting(false);
  };

  return (
    <div
      className="relative h-screen w-screen flex items-center justify-center overflow-hidden"
      style={{ background: '#08080c', color: 'white' }}
    >
      {/* Ambient silhouette — soft, blurred, behind everything */}
      <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-[0.45]"
        style={{ filter: 'blur(0.4px)' }}>
        <div className="w-[640px] h-[640px] max-w-[90vw] max-h-[90vh]"
          style={{ filter: 'drop-shadow(0 8px 60px rgba(124,92,255,0.25))' }}>
          <HumanSilhouette />
        </div>
      </div>

      {/* Radial vignette + lavender wash so the form is readable over the figure */}
      <div className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(8,8,12,0.0) 0%, rgba(8,8,12,0.55) 50%, rgba(8,8,12,0.92) 100%)',
        }} />

      {/* Form card */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-[340px] mx-4"
      >
        {/* ORBIT mark — matches onboarding header */}
        <motion.div
          initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.7 }}
          className="flex items-center justify-center gap-2 mb-10"
        >
          <OrbitLogo size={16} className="text-white" />
          <span className="text-[10px] font-semibold text-white/25" style={{ letterSpacing: '0.2em' }}>ORBIT</span>
        </motion.div>

        <h1 className="text-[20px] font-semibold text-center mb-2 tracking-tight text-white/95">
          {isSignUp ? 'Create your account' : 'Welcome back'}
        </h1>
        <p className="text-white/40 text-center mb-8 text-[13px]">
          {isSignUp ? 'Start mapping your network.' : 'Sign in to your network.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-2.5">
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus
            placeholder="Email"
            className="w-full px-4 py-3 rounded-xl text-[14px] text-white placeholder-white/30 transition-colors focus:outline-none"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(124,92,255,0.45)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)')}
          />
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required
              placeholder="Password"
              className="w-full px-4 py-3 pr-11 rounded-xl text-[14px] text-white placeholder-white/30 transition-colors focus:outline-none"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(124,92,255,0.45)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)')}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-white/30 hover:text-white/70 transition-colors"
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          <AnimatePresence>
            {isSignUp && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required
                    placeholder="Confirm password"
                    className="w-full px-4 py-3 pr-11 rounded-xl text-[14px] text-white placeholder-white/30 transition-colors focus:outline-none"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(124,92,255,0.45)')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-white/30 hover:text-white/70 transition-colors"
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {error && <p className="text-[#ff6b6b] text-[11.5px] text-center pt-1">{error}</p>}
          {success && <p className="text-[#7c5cff] text-[11.5px] text-center pt-1">{success}</p>}

          <button
            type="submit" disabled={submitting}
            className="w-full mt-3 py-3 rounded-xl bg-white text-[#08080c] text-[13.5px] font-medium
                       hover:shadow-[0_0_50px_rgba(255,255,255,0.18)] hover:scale-[1.01] active:scale-[0.98]
                       transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {submitting ? <Loader2 size={13} className="animate-spin" /> : null}
            {submitting ? 'Working…' : isSignUp ? 'Create account' : 'Sign in'}
            {!submitting && <ChevronRight size={13} />}
          </button>
        </form>

        <p className="text-center mt-7 text-[11px] text-white/30">
          {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            onClick={() => { setMode(isSignUp ? 'signin' : 'signup'); setError(''); setSuccess(''); }}
            className="text-white/60 hover:text-white transition-colors underline-offset-4 hover:underline"
          >
            {isSignUp ? 'Sign in' : 'Sign up'}
          </button>
        </p>
      </motion.div>
    </div>
  );
}

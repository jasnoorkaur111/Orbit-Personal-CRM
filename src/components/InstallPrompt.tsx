'use client';

import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, Share, Plus } from 'lucide-react';
import { getStorage, setStorage } from '@/lib/storage';
import { useAuth } from '@/lib/auth';
import { useCrmStore } from '@/store/useCrmStore';

export default function InstallPrompt() {
  const [show, setShow] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSSteps, setShowIOSSteps] = useState(false);
  const deferredPromptRef = useRef<any>(null);
  const { user } = useAuth();
  const { contacts } = useCrmStore();

  useEffect(() => {
    // Gate: never show during onboarding (no completion flag yet) or with empty state.
    // Onboarding is annoying enough without an install pop blocking it.
    if (!user) return;
    const onboarded = getStorage(`crm-onboarded-${user.id}`);
    if (!onboarded || contacts.length === 0) return;
    // Already installed as PWA — don't show
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    // Already dismissed
    if (getStorage('crm-install-dismissed')) return;

    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setIsIOS(ios);

    if (ios) {
      // Show after a short delay on iOS
      const timer = setTimeout(() => setShow(true), 3000);
      return () => clearTimeout(timer);
    }

    // Android/Chrome — intercept the install prompt
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e;
      setShow(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [user, contacts.length]);

  const handleInstall = async () => {
    if (deferredPromptRef.current) {
      deferredPromptRef.current.prompt();
      const result = await deferredPromptRef.current.userChoice;
      if (result.outcome === 'accepted') {
        setShow(false);
      }
      deferredPromptRef.current = null;
    }
  };

  const handleDismiss = () => {
    setShow(false);
    setStorage('crm-install-dismissed', 'true');
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed bottom-[calc(80px+env(safe-area-inset-bottom,0px))] md:bottom-6 left-4 right-4 md:left-auto md:right-6 z-[55] md:w-[320px]"
        >
          <div className="glass-elevated rounded-2xl p-4 gradient-border">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-[var(--accent)]/15 flex items-center justify-center flex-shrink-0">
                <Download size={18} className="text-[var(--accent)]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Install CRM</p>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Add to your home screen for a faster, app-like experience.
                </p>
              </div>
              <button
                onClick={handleDismiss}
                className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
              >
                <X size={14} />
              </button>
            </div>

            {isIOS ? (
              <div className="mt-3">
                <button
                  onClick={() => setShowIOSSteps(!showIOSSteps)}
                  className="w-full py-2 px-3 bg-[var(--accent)] hover:bg-[var(--accent-light)] rounded-xl text-sm font-medium transition-colors"
                >
                  Show me how
                </button>

                <AnimatePresence>
                  {showIOSSteps && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-3 space-y-2.5 overflow-hidden"
                    >
                      <div className="flex items-center gap-3 text-xs">
                        <div className="w-7 h-7 rounded-lg bg-[var(--input-bg)] flex items-center justify-center flex-shrink-0">
                          <Share size={14} className="text-[var(--accent)]" />
                        </div>
                        <p className="text-[var(--text-secondary)]">
                          Tap the <span className="text-[var(--text-primary)] font-medium">Share</span> button in Safari
                        </p>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <div className="w-7 h-7 rounded-lg bg-[var(--input-bg)] flex items-center justify-center flex-shrink-0">
                          <Plus size={14} className="text-[var(--accent)]" />
                        </div>
                        <p className="text-[var(--text-secondary)]">
                          Scroll down and tap <span className="text-[var(--text-primary)] font-medium">Add to Home Screen</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <div className="w-7 h-7 rounded-lg bg-[var(--input-bg)] flex items-center justify-center flex-shrink-0">
                          <Download size={14} className="text-[var(--teal)]" />
                        </div>
                        <p className="text-[var(--text-secondary)]">
                          Tap <span className="text-[var(--text-primary)] font-medium">Add</span> — that's it!
                        </p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleInstall}
                  className="flex-1 py-2 px-3 bg-[var(--accent)] hover:bg-[var(--accent-light)] rounded-xl text-sm font-medium transition-colors"
                >
                  Install
                </button>
                <button
                  onClick={handleDismiss}
                  className="py-2 px-3 bg-[var(--input-bg)] hover:bg-[var(--hover-bg)] rounded-xl text-sm text-[var(--text-secondary)] transition-colors"
                >
                  Not now
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

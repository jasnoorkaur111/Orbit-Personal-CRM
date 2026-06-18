'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';

export default function ServiceWorkerRegister() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').then((registration) => {
      // Check for updates periodically
      setInterval(() => registration.update(), 60 * 1000);

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available — show toast
            setUpdateAvailable(true);
          }
        });
      });
    }).catch(() => {});

    // If the new SW takes over, reload
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }, []);

  const handleUpdate = () => {
    navigator.serviceWorker.getRegistration().then((reg) => {
      reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  return (
    <AnimatePresence>
      {updateAvailable && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[70]"
        >
          <div className="glass-elevated rounded-xl px-4 py-3 flex items-center gap-3">
            <RefreshCw size={14} className="text-[var(--text-primary)]" />
            <span className="text-sm">New version available</span>
            <button
              onClick={handleUpdate}
              className="px-3 py-1 bg-[var(--text-primary)] text-[var(--bg-primary)] rounded-lg text-xs font-medium hover:opacity-90 transition-opacity"
            >
              Update
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

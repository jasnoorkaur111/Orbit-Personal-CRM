'use client';

import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';

/**
 * In-app replacement for native window.confirm(). Browsers always prepend the
 * origin URL to native dialogs ("example.com says…") as a security
 * feature, with no way to suppress it. A custom modal lets us own the copy,
 * the styling, and the brand.
 *
 * Usage (anywhere under <ConfirmProvider>):
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: 'Delete Sarah?', confirmLabel: 'Delete', destructive: true })) {
 *     deleteContact(id);
 *   }
 *
 * Mount <ConfirmProvider> once at the app root.
 */

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type Resolver = (value: boolean) => void;
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return fn;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    setOpts(options);
    setOpen(true);
    return new Promise<boolean>((resolve) => { resolverRef.current = resolve; });
  }, []);

  const close = useCallback((result: boolean) => {
    setOpen(false);
    resolverRef.current?.(result);
    resolverRef.current = null;
  }, []);

  // Keyboard: Esc cancels, Enter confirms.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const title = opts?.title ?? '';
  const description = opts?.description;
  const confirmLabel = opts?.confirmLabel ?? 'Confirm';
  const cancelLabel = opts?.cancelLabel ?? 'Cancel';
  const destructive = !!opts?.destructive;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AnimatePresence>
        {open && opts && (
          <motion.div
            key="confirm-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => close(false)}
            className="fixed inset-0 z-[500] flex items-center justify-center px-4"
            style={{
              background: 'color-mix(in srgb, var(--bg-primary) 60%, transparent)',
              backdropFilter: 'blur(6px)',
            }}
          >
            <motion.div
              key="confirm-card"
              initial={{ opacity: 0, scale: 0.94, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 6 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              className="w-full max-w-[380px] rounded-2xl overflow-hidden shadow-2xl"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
              }}
            >
              <div className="px-5 pt-5 pb-3">
                <div className="flex items-start gap-3">
                  {destructive && (
                    <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                      style={{ background: 'color-mix(in srgb, var(--danger, #ef4444) 14%, transparent)' }}>
                      <AlertTriangle size={15} className="text-[var(--danger,#ef4444)]" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <h2 id="confirm-title" className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">
                      {title}
                    </h2>
                    {description && (
                      <p className="text-[12.5px] text-[var(--text-secondary)] leading-relaxed mt-1.5">
                        {description}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="px-5 pb-4 pt-1 flex items-center justify-end gap-2">
                <button
                  onClick={() => close(false)}
                  className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors"
                >
                  {cancelLabel}
                </button>
                <button
                  autoFocus
                  onClick={() => close(true)}
                  className="px-4 py-1.5 rounded-lg text-[12.5px] font-medium text-white transition-all hover:scale-[1.02] active:scale-[0.98]"
                  style={{
                    background: destructive ? 'var(--danger, #ef4444)' : 'var(--accent)',
                  }}
                >
                  {confirmLabel}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ConfirmContext.Provider>
  );
}

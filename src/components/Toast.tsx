'use client';

import { create } from 'zustand';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, Mic, Calendar, Link2, Trash2 } from 'lucide-react';

interface ToastItem {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  icon?: 'contact' | 'task' | 'voice' | 'calendar' | 'connection' | 'delete';
  undo?: () => void;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, 'id'>) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },
  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

const iconMap = {
  contact: Check,
  task: Check,
  voice: Mic,
  calendar: Calendar,
  connection: Link2,
  delete: Trash2,
};

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  return (
    <div className="fixed bottom-[calc(60px+env(safe-area-inset-bottom,0px))] md:bottom-6 left-4 md:left-[72px] right-4 md:right-auto z-[60] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((toast) => {
          const Icon = toast.icon ? iconMap[toast.icon] : Check;
          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ type: 'spring', damping: 20, stiffness: 300 }}
              className="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl glass-elevated"
            >
              <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                toast.type === 'success' ? 'bg-[var(--accent)]/15 text-[var(--accent)]' :
                toast.type === 'error' ? 'bg-red-500/15 text-red-400' :
                'bg-[var(--accent)]/15 text-[var(--accent)]/70'
              }`}>
                <Icon size={12} />
              </div>
              <span className="text-sm text-[var(--text-primary)]">{toast.message}</span>
              {toast.undo && (
                <button
                  onClick={() => { toast.undo?.(); removeToast(toast.id); }}
                  className="text-xs text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors ml-2"
                >
                  Undo
                </button>
              )}
              <button
                onClick={() => removeToast(toast.id)}
                className="ml-1 p-1 text-[var(--text-secondary)] hover:text-white transition-colors"
              >
                <X size={12} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

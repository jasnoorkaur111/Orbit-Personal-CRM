'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { motion } from 'framer-motion';
import { Sun, Moon } from 'lucide-react';
import { getStorage, setStorage } from '@/lib/storage';

type Theme = 'dark' | 'light';

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
  initTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: 'light',
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    setStorage('crm-theme', next);
    set({ theme: next });
  },
  initTheme: () => {
    const saved = getStorage('crm-theme') as Theme | null;
    const theme = saved || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },
}));

export default function ThemeToggle() {
  const { theme, toggleTheme, initTheme } = useThemeStore();

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  return (
    <button
      onClick={toggleTheme}
      className="w-10 h-10 rounded-lg flex items-center justify-center transition-all
                 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)]"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <motion.div
        key={theme}
        initial={{ scale: 0.5, rotate: -90, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      >
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </motion.div>
    </button>
  );
}

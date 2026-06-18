'use client';

import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<{ error: string | null; session: Session | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signUp: async () => ({ error: null, session: null }),
  signIn: async () => ({ error: null }),
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Identity-dedupe `user` so we don't fire dependents (page.tsx auto-sync,
    // fetchAll) on every TOKEN_REFRESHED / INITIAL_SESSION event. Supabase emits
    // fresh User objects each time, even when the actual user is unchanged.
    const applySession = (s: Session | null) => {
      setSession(s);
      setUser((prev) => {
        const next = s?.user ?? null;
        return prev?.id === next?.id ? prev : next;
      });
      setLoading(false);
    };

    supabase.auth.getSession().then(({ data: { session } }) => applySession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => applySession(session));

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    // When email-verify is OFF (our config), `data.session` is present and the
    // user is instantly authed. When ON, session is null and the caller should
    // show "check your email".
    return { error: error?.message ?? null, session: data?.session ?? null };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    // Wipe IndexedDB cache so the next user on this device doesn't see prior
    // user's data flash before the real sync. Best-effort — auth signOut
    // always runs even if cache clear fails.
    try {
      const mod = await import('./localCache');
      await mod.clearCache();
    } catch {}
    await supabase.auth.signOut();
  };

  // Memoize the context value so consumers only re-render when something real changes
  const value = useMemo(
    () => ({ user, session, loading, signUp, signIn, signOut }),
    [user, session, loading]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

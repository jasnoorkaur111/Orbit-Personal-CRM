// Shared auth check for API routes. Validates Bearer JWT against Supabase,
// returns the authenticated user object + a Supabase client scoped to that user.
// Routes that previously trusted body-supplied userId are write-any-row-as-any-user
// vectors; use this instead.

import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { User } from '@supabase/supabase-js';

export interface AuthedRequest {
  user: User;
  supabase: SupabaseClient;
  token: string;
}

export async function requireAuth(
  request: NextRequest,
): Promise<AuthedRequest | NextResponse> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return { user, supabase, token };
}

// Compile-time contract: the real Supabase client must satisfy the interface `SupabaseTransport`
// is written against. If a Supabase release changes the Realtime API, `pnpm typecheck` fails here
// instead of the relay breaking in production. Nothing imports this file.
import { createClient } from '@supabase/supabase-js';
import type { RealtimeClientLike } from './transports.js';

const client = createClient('https://example.supabase.co', 'anon-key');
export const assignable: RealtimeClientLike = client;

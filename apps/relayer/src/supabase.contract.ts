// Compile-time contract: the real Supabase client must satisfy `DatabaseLike`. If a release changes
// `rpc` or `from().insert()`, `pnpm typecheck` fails here instead of the relayer breaking in
// production. Nothing imports this file.
import { createClient } from '@supabase/supabase-js';
import type { DatabaseLike } from './adapters.js';

const client = createClient('https://example.supabase.co', 'service-role-key');
export const assignable: DatabaseLike = client;

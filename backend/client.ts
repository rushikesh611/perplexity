import { createClient } from '@supabase/supabase-js';

export function createsupabaseClient() {
  return createClient(
    "https://jiqavfhivzcfeqlzhrtv.supabase.co",
    process.env.SUPABASE_API_SECRET_KEY!
  )
}

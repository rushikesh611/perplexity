import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    "https://jiqavfhivzcfeqlzhrtv.supabase.co",
    "sb_publishable_hNcK55mVW41suJwzLxVhlg_E8ZjCDpU"
  )
}

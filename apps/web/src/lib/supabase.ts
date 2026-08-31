import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { apiFetch } from "./api.js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

let browserClient: SupabaseClient | null = null;

export function getSupabaseClient() {
  if (!supabaseUrl || !supabasePublishableKey) return null;

  browserClient ??= createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return browserClient;
}

export async function adminFetch(path: string, init: RequestInit = {}) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase browser authentication is not configured.");

  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new Error("ADMIN_SESSION_REQUIRED");

  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${data.session.access_token}`);

  return apiFetch(path, { ...init, headers });
}

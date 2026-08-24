import { createClient } from "@supabase/supabase-js";
import type { AdminIdentity } from "@commondays/shared";

export type AdminTokenVerification =
  | { status: "authenticated"; user: AdminIdentity }
  | { status: "invalid" }
  | { status: "unavailable" };

export type AdminTokenVerifier = (accessToken: string) => Promise<AdminTokenVerification>;

export function createAdminTokenVerifier(
  options: {
    supabaseUrl?: string;
    publishableKey?: string;
  } = {},
): AdminTokenVerifier | null {
  const supabaseUrl = options.supabaseUrl ?? process.env.SUPABASE_URL;
  const publishableKey = options.publishableKey ?? process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) return null;

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  return async (accessToken) => {
    try {
      const { data, error } = await supabase.auth.getUser(accessToken);
      if (error) {
        return error.status && error.status >= 500 ? { status: "unavailable" } : { status: "invalid" };
      }
      if (!data.user) return { status: "invalid" };

      return {
        status: "authenticated",
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
        },
      };
    } catch {
      return { status: "unavailable" };
    }
  };
}

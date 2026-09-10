import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { AccountProfile } from "@/lib/account";
import { profileFromUserMetadata } from "@/lib/account";

// Share only concurrent reads. Settled results are never cached across auth events.
const pendingUsers = new Map<string, ReturnType<typeof supabase.auth.getUser>>();
const pendingProfiles = new Map<string, Promise<AccountProfile | null>>();

function concurrentRead<T>(pending: Map<string, Promise<T>>, key: string, read: () => Promise<T>) {
  const existing = pending.get(key);
  if (existing) return existing;
  const request = read().finally(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  pending.set(key, request);
  return request;
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let verification = 0;
    let verifiedUserId: string | undefined;

    async function fetchProfile(nextUser: User): Promise<AccountProfile | null> {
      const { data, error } = await supabase
        .from("user_profiles")
        .select(
          "user_id,email,full_name,account_type,account_tier,user_role,professional_role,organization_name,professional_status,created_at,updated_at",
        )
        .eq("user_id", nextUser.id)
        .maybeSingle();

      if (error) {
        console.warn("Profil utilisateur indisponible, fallback user_metadata.", error.message);
        return profileFromUserMetadata(nextUser);
      }

      return (data as AccountProfile | null) ?? profileFromUserMetadata(nextUser);
    }

    async function verifySession(nextSession: Session | null) {
      const currentVerification = ++verification;
      setAuthError(null);
      if (nextSession?.user.id !== verifiedUserId) {
        setLoading(true);
        setSession(null);
        setUser(null);
        setProfile(null);
      }
      if (!nextSession) {
        verifiedUserId = undefined;
        setSession(null);
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      const verificationKey = `${nextSession.user.id}:${nextSession.access_token}`;
      const { data, error } = await concurrentRead(pendingUsers, verificationKey, () =>
        supabase.auth.getUser(),
      ).catch(() => ({ data: { user: null }, error: new Error("Identity unavailable") }));
      if (!active || currentVerification !== verification) return;
      if (error || !data.user || data.user.id !== nextSession.user.id) {
        verifiedUserId = undefined;
        setSession(null);
        setAuthError(
          "Votre session n’a pas pu être vérifiée. Reconnectez-vous pour ouvrir l’annonce.",
        );
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      const nextProfile = await concurrentRead(pendingProfiles, verificationKey, () =>
        fetchProfile(data.user!),
      ).catch(() => profileFromUserMetadata(data.user!));
      if (!active || currentVerification !== verification) return;
      verifiedUserId = data.user.id;
      setSession(nextSession);
      setUser(data.user);
      setProfile(nextProfile);
      setLoading(false);
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      void verifySession(s);
    });

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active && verification === 0) void verifySession(data.session);
      })
      .catch(() => {
        if (!active || verification !== 0) return;
        setAuthError(
          "Votre session n’a pas pu être vérifiée. Reconnectez-vous pour ouvrir l’annonce.",
        );
        setLoading(false);
      });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, user, profile, loading, authError };
}

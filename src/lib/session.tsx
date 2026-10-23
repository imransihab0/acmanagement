import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";

const TOKEN_KEY = "ac.session";

type Session = {
  /** Null until the token has been checked against the server. */
  token: string | null;
  status: "loading" | "signedOut" | "signedIn";
  /** Whether a passcode has ever been set on this deployment. */
  configured: boolean | undefined;
  expiresAt: number | null;
  signIn: (token: string, expiresAt: number) => void;
  signOut: () => void;
  /** Extends a live session by another day. */
  renew: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  const config = useQuery(api.auth.status, {});
  // The server is the authority — a token in localStorage proves nothing.
  const check = useQuery(api.auth.validate, token ? { token } : "skip");
  const logoutMutation = useMutation(api.auth.logout);
  const renewMutation = useMutation(api.auth.renew);

  const signIn = useCallback((next: string, nextExpiresAt: number) => {
    localStorage.setItem(TOKEN_KEY, next);
    setToken(next);
    setExpiresAt(nextExpiresAt);
  }, []);

  const signOut = useCallback(() => {
    const current = localStorage.getItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setExpiresAt(null);
    if (current) void logoutMutation({ token: current });
  }, [logoutMutation]);

  const renew = useCallback(async () => {
    const current = localStorage.getItem(TOKEN_KEY);
    if (!current) return;
    const result = await renewMutation({ token: current });
    setExpiresAt(result.expiresAt);
  }, [renewMutation]);

  // Drop a token the server rejects, so we never sit in a half-signed-in state.
  useEffect(() => {
    if (token && check && !check.valid) {
      localStorage.removeItem(TOKEN_KEY);
      setToken(null);
      setExpiresAt(null);
    } else if (check?.valid) {
      setExpiresAt(check.expiresAt);
    }
  }, [token, check]);

  // Sign out the moment the session lapses, without waiting for a reload.
  useEffect(() => {
    if (!expiresAt) return;
    const ms = expiresAt - Date.now();
    if (ms <= 0) {
      signOut();
      return;
    }
    const timer = setTimeout(signOut, ms);
    return () => clearTimeout(timer);
  }, [expiresAt, signOut]);

  const status: Session["status"] =
    config === undefined || (token !== null && check === undefined)
      ? "loading"
      : token !== null && check?.valid
        ? "signedIn"
        : "signedOut";

  const value = useMemo<Session>(
    () => ({
      token: status === "signedIn" ? token : null,
      status,
      configured: config?.configured,
      expiresAt,
      signIn,
      signOut,
      renew,
    }),
    [token, status, config, expiresAt, signIn, signOut, renew],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

/* ------------------------------------------------------- authed wrappers */

/*
  Every data function takes a `token`. These wrappers inject it so pages call
  `useAuthedQuery(api.products.list, { search })` and never handle the token
  themselves — which also means a call site cannot forget to send it.
*/

type WithToken = { token: string };

/*
  The exported signatures below are precise; the casts are confined to the
  hook calls, where Convex's generic arg types do not survive being wrapped.
*/

export function useAuthedQuery<Args extends WithToken, Output>(
  reference: FunctionReference<"query", "public", Args, Output>,
  args?: Omit<Args, "token"> | "skip",
): Output | undefined {
  const { token } = useSession();
  const resolved = args ?? ({} as Omit<Args, "token">);
  const full = token && resolved !== "skip" ? { ...resolved, token } : "skip";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return useQuery(reference as any, full as any) as Output | undefined;
}

export function useAuthedMutation<Args extends WithToken, Output>(
  reference: FunctionReference<"mutation", "public", Args, Output>,
): (args: Omit<Args, "token">) => Promise<Output> {
  const { token } = useSession();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = useMutation(reference as any) as (a: unknown) => Promise<Output>;
  return useCallback(
    (args: Omit<Args, "token">) => {
      if (!token) return Promise.reject(new Error("Not signed in."));
      return run({ ...args, token });
    },
    [run, token],
  );
}

type OptionalToken = { token?: string };

export function useAuthedAction<Args extends OptionalToken, Output>(
  reference: FunctionReference<"action", "public", Args, Output>,
): (args: Omit<Args, "token">) => Promise<Output> {
  const { token } = useSession();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = useAction(reference as any) as (a: unknown) => Promise<Output>;
  return useCallback(
    (args: Omit<Args, "token">) => {
      return run(token ? { ...args, token } : args);
    },
    [run, token],
  );
}

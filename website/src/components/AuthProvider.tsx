'use client';

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { authApi, userApi } from '@/lib/api';
import type { LoginRequest, Me, RegisterRequest } from '@/lib/types';

interface AuthContextValue {
  user: Me | null;
  /** True while bootstrapping or reconciling a login or logout. */
  loading: boolean;
  login: (body: LoginRequest) => Promise<Me>;
  register: (body: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<Me | null>;
  setUser: (user: Me | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthOperation {
  controller: AbortController;
  transitioning: boolean;
}

interface AuthState {
  user: Me | null;
  loading: boolean;
  owner: AuthOperation | null;
}

function superseded() {
  return new DOMException('Authentication operation superseded', 'AbortError');
}

/**
 * Session lives in HttpOnly cookies issued by the auth service, so the only way
 * to know who is signed in is to ask the gateway. A 401 here is the normal
 * "signed out" case, not an error worth surfacing.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [{ user, loading, owner }, setState] = useState<AuthState>({
    user: null,
    loading: true,
    owner: null,
  });
  const mounted = useRef(false);
  const active = useRef<AuthOperation | null>(null);

  const begin = useCallback((transitioning: boolean) => {
    if (!mounted.current) return null;
    const previous = active.current;
    const operation = { controller: new AbortController(), transitioning };
    active.current = operation;
    previous?.controller.abort();
    // Retire the previous identity before the session's cookies can change.
    if (transitioning) setState({ user: null, loading: true, owner: null });
    return operation;
  }, []);

  const finish = useCallback((operation: AuthOperation, me: Me | null) => {
    if (active.current !== operation) return false;
    operation.transitioning = false;
    // A later operation can take ownership before React processes this update.
    setState((current) =>
      active.current === operation ? { user: me, loading: false, owner: operation } : current,
    );
    return true;
  }, []);

  const readSession = useCallback(
    async (operation: AuthOperation): Promise<Me | null> => {
      try {
        const me = await userApi.me(operation.controller.signal);
        return finish(operation, me) ? me : null;
      } catch {
        finish(operation, null);
        return null;
      }
    },
    [finish],
  );

  const refresh = useCallback(async () => {
    // Outside a transition the most recently started read owns the result.
    // Login and logout reconcile their own cookies before any separate reads.
    if (active.current?.transitioning) return null;
    const operation = begin(false);
    return operation ? readSession(operation) : null;
  }, [begin, readSession]);

  useLayoutEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      const operation = active.current;
      active.current = null;
      operation?.controller.abort();
    };
  }, [refresh]);

  const login = useCallback(
    async (body: LoginRequest) => {
      const operation = begin(true);
      if (!operation) throw superseded();
      try {
        await authApi.login(body);
      } catch (error) {
        // A failed sign-in can leave the original session alive. Re-read it
        // under this operation instead of reusing a retired identity.
        if (active.current !== operation) throw superseded();
        await readSession(operation);
        if (active.current !== operation) throw superseded();
        throw error;
      }
      if (active.current !== operation) throw superseded();
      try {
        const me = await userApi.me(operation.controller.signal);
        if (!finish(operation, me)) throw superseded();
        return me;
      } catch (error) {
        if (!finish(operation, null)) throw superseded();
        throw error;
      }
    },
    [begin, finish, readSession],
  );

  const register = useCallback(async (body: RegisterRequest) => {
    await authApi.register(body);
  }, []);

  const logout = useCallback(async () => {
    const operation = begin(true);
    if (!operation) return;
    try {
      await authApi.logout();
    } finally {
      finish(operation, null);
    }
  }, [begin, finish]);

  // Settings can update the signed-in profile. A callback retained across
  // an auth operation cannot replace or clear the new session's identity.
  const setUser = useCallback(
    (me: Me | null) => {
      setState((current) =>
        owner &&
        active.current === owner &&
        current.owner === owner &&
        (!me || me.id === current.user?.id)
          ? { ...current, user: me }
          : current,
      );
    },
    [owner],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, register, logout, refresh, setUser }),
    [user, loading, login, register, logout, refresh, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

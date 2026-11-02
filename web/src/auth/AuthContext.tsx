import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User } from '@shared/api-types';
import { api, ApiError, onUnauthorized } from '../api/client';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'unreachable';

interface AuthValue {
  user: User | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, password: string, nickname: string) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  const refresh = useCallback(async () => {
    try {
      const res = await api.me();
      setUser(res.user);
      setStatus('authenticated');
    } catch (err) {
      setUser(null);
      setStatus(err instanceof ApiError && err.status === 401 ? 'anonymous' : 'unreachable');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
        setStatus('anonymous');
      }),
    [],
  );

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login({ email, password });
    setUser(res.user);
    setStatus('authenticated');
    return res.user;
  }, []);

  const register = useCallback(async (email: string, password: string, nickname: string) => {
    const res = await api.register({ email, password, nickname });
    setUser(res.user);
    setStatus('authenticated');
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo(
    () => ({ user, status, login, register, logout, refresh }),
    [user, status, login, register, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

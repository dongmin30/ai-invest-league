import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ErrorState, Loading } from '../components/ui';
import { ApiError } from '../api/client';
import { useAuth } from './AuthContext';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, refresh } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Loading label="로그인 상태 확인 중…" />;
  if (status === 'unreachable') {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <ErrorState error={new ApiError(0, 'network', '서버에 연결할 수 없습니다.')} onRetry={() => void refresh()} />
      </div>
    );
  }
  if (status === 'anonymous') {
    const from = location.pathname + location.search;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <>{children}</>;
}

/** Redirects signed-in users away from login/register. */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Loading />;
  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }
  return <>{children}</>;
}

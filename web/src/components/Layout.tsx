import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatFullDateTime, PRICE_SOURCE_LABEL } from '../lib/format';
import { usePriceInfo } from '../lib/PriceInfoContext';
import ThemeToggle from './ThemeToggle';
import { Badge, cx } from './ui';

const NAV = [
  { to: '/', label: '대시보드', end: true },
  { to: '/leagues', label: '리그', end: false },
  { to: '/agents', label: 'AI 에이전트', end: false },
];

export function Footer() {
  const { source, lastQuoteTs } = usePriceInfo();
  return (
    <footer className="border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-4 text-center text-xs text-slate-500 dark:text-slate-400">
      <p>가상자금으로 하는 교육용 모의투자입니다. 투자 권유가 아닙니다.</p>
      <p className="mt-1">
        시세 출처: {source ? PRICE_SOURCE_LABEL[source] : '확인 중'}
        {lastQuoteTs !== null && <> · 최근 시세 {formatFullDateTime(lastQuoteTs)} (KST)</>}
      </p>
    </footer>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  // Server mode (sim provider, e.g. `npm run practice`), not the source of individual quotes.
  const [simMode, setSimMode] = useState(false);

  useEffect(() => {
    api.health().then(
      (h) => setSimMode(h.provider === 'sim'),
      () => undefined,
    );
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <NavLink to="/" className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100">
              AI Invest League
            </NavLink>
            {simMode && <Badge tone="amber">연습 모드 · 가상 시세</Badge>}
          </div>
          <nav className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    'whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium',
                    isActive ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <ThemeToggle />
            {user && (
              <>
                <span className="max-w-[9rem] truncate font-medium text-slate-700 dark:text-slate-200">{user.nickname}</span>
                {user.role === 'admin' && <Badge tone="amber">관리자</Badge>}
                <button type="button" onClick={handleLogout} className="rounded-md px-2 py-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700">
                  로그아웃
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Footer } from '../components/Layout';
import ThemeToggle from '../components/ThemeToggle';
import { Alert, btn, inputClass } from '../components/ui';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex justify-end px-4 pt-3">
        <ThemeToggle />
      </div>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <div className="text-lg font-bold tracking-tight">AI Invest League</div>
            <h1 className="mt-4 text-2xl font-bold">{title}</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-6 shadow-sm">{children}</div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell title="로그인" subtitle="사람 vs AI, 가상자금 모의투자 리그">
      <form className="space-y-4" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="이메일">
          <input className={inputClass} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="비밀번호">
          <input
            className={inputClass}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button type="submit" className={`${btn.primary} w-full`} disabled={busy}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
        계정이 없으신가요?{' '}
        <Link to="/register" className="font-medium text-slate-900 dark:text-slate-100 underline">
          회원가입
        </Link>
      </p>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const [params] = useSearchParams();
  // `/register?code=XXXX` (the share link) fills the code in.
  const [signupCode, setSignupCode] = useState(() => params.get('code') ?? '');
  const [codeRequired, setCodeRequired] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .signupOptions()
      .then((o) => alive && setCodeRequired(o.signup_code_required))
      // Unknown: show the field anyway; the server ignores a code it does not need.
      .catch(() => alive && setCodeRequired(true));
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const nick = nickname.trim();
    if (nick.length < 2 || nick.length > 20) return setError('닉네임은 2~20자로 입력해 주세요.');
    if (password.length < 8) return setError('비밀번호는 8자 이상이어야 합니다.');
    setBusy(true);
    setError(null);
    try {
      await register(email.trim(), password, nick, codeRequired ? signupCode.trim() : undefined);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell title="회원가입" subtitle="가입 후 바로 공식 리그에 참가할 수 있습니다">
      <form className="space-y-4" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        {codeRequired && (
          <Field label="입장코드" hint="초대한 사람에게 받은 코드를 입력하세요.">
            <input
              className={`${inputClass} font-mono uppercase tracking-widest`}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              maxLength={100}
              value={signupCode}
              onChange={(e) => setSignupCode(e.target.value)}
            />
          </Field>
        )}
        <Field label="이메일">
          <input className={inputClass} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="닉네임" hint="2~20자, 랭킹에 표시됩니다.">
          <input
            className={inputClass}
            autoComplete="nickname"
            required
            minLength={2}
            maxLength={20}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
        </Field>
        <Field label="비밀번호" hint="8자 이상">
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button type="submit" className={`${btn.primary} w-full`} disabled={busy || codeRequired === null}>
          {busy ? '가입 중…' : '가입하기'}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
        이미 계정이 있으신가요?{' '}
        <Link to="/login" className="font-medium text-slate-900 dark:text-slate-100 underline">
          로그인
        </Link>
      </p>
    </AuthShell>
  );
}

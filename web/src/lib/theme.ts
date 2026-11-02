import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

// Keep the key and class logic in sync with public/theme-init.js (runs before first paint).
const STORAGE_KEY = 'theme';
const query = '(prefers-color-scheme: dark)';

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function resolve(theme: Theme): ResolvedTheme {
  return theme === 'dark' || (theme === 'system' && window.matchMedia(query).matches) ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  const dark = resolve(theme) === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

let current: Theme = readStored();
const listeners = new Set<() => void>();

function emit() {
  applyTheme(current);
  listeners.forEach((l) => l());
}

function setTheme(theme: Theme) {
  current = theme;
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private mode etc.): the choice still applies for this session.
  }
  emit();
}

// Follow OS changes while on "system", and theme changes made in other tabs.
window.matchMedia(query).addEventListener('change', () => {
  if (current === 'system') emit();
});
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY || e.key === null) {
    current = readStored();
    emit();
  }
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `theme` is the user's setting; `resolved` is what is actually shown. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current);
  const resolved = useSyncExternalStore(subscribe, () => resolve(current));
  return { theme, resolved, setTheme: useCallback(setTheme, []) };
}

import { useCallback, useEffect, useRef, useState, type DependencyList, type Dispatch, type SetStateAction } from 'react';

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Re-runs the request. A silent reload keeps the current data on screen. */
  reload: (opts?: { silent?: boolean }) => void;
  setData: Dispatch<SetStateAction<T | undefined>>;
}

/** Runs `fn` whenever `deps` change; stale responses from earlier runs are discarded. */
export function useApi<T>(fn: () => Promise<T>, deps: DependencyList): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const runId = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback((silent: boolean) => {
    const id = ++runId.current;
    if (!silent) setLoading(true);
    fnRef.current().then(
      (result) => {
        if (id !== runId.current) return;
        setData(result);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (id !== runId.current) return;
        if (!silent) setError(err);
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    setData(undefined);
    run(false);
    return () => {
      runId.current++;
    };
  }, deps);

  const reload = useCallback((opts?: { silent?: boolean }) => run(opts?.silent ?? false), [run]);

  return { data, error, loading, reload, setData };
}

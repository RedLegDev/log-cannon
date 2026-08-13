'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type UseFetchOptions<T> = {
  initialData: T;
  /** Map the JSON body to T. Default: identity. */
  select?: (json: unknown) => T;
  /** Failed fetches leave data as-is and do not set error. */
  optional?: boolean;
  errorMessage?: string;
};

function readError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * GET `url` and hold the result. setState runs in the fetch callbacks, not the
 * effect body — that's what react-hooks/set-state-in-effect requires.
 *
 * `loading` is the initial request only. `refetch` (mutations, refresh buttons)
 * updates data in place without flipping the page back to a spinner.
 */
export function useFetch<T>(url: string, options: UseFetchOptions<T>) {
  const { initialData, select, optional = false, errorMessage = 'Request failed' } = options;

  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectRef = useRef(select);
  const optionalRef = useRef(optional);
  const errorMessageRef = useRef(errorMessage);
  useEffect(() => {
    selectRef.current = select;
    optionalRef.current = optional;
    errorMessageRef.current = errorMessage;
  });

  const applyJson = useCallback((json: unknown) => {
    const mapped = selectRef.current ? selectRef.current(json) : (json as T);
    setData(mapped);
    setError(null);
    setLoading(false);
  }, []);

  const fail = useCallback((cause: unknown) => {
    setLoading(false);
    if (optionalRef.current) return;
    setError(readError(cause, errorMessageRef.current));
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(errorMessageRef.current);
        return res.json();
      })
      .then((json: unknown) => {
        applyJson(json);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        fail(cause);
      });

    return () => controller.abort();
  }, [url, applyJson, fail]);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(errorMessageRef.current);
      applyJson(await res.json());
    } catch (cause) {
      fail(cause);
    }
  }, [url, applyJson, fail]);

  return { data, loading, error, setError, setData, refetch };
}

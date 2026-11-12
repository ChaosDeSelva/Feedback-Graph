import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api.ts';

/** A list page of x-next-offset pages: the rows, where the next page starts, and loading more without losing your place. */
export function usePaged<T>(load: (offset: number) => Promise<{ items: T[]; next: number | null }>, idOf: (t: T) => string, deps: unknown[]) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const at = ++generation.current;
    setLoaded(false);
    setError(null);
    setNext(null);
    load(0).then(({ items: page, next: more }) => {
      if (at !== generation.current) return;
      setItems(page);
      setNext(more);
      setLoaded(true);
    }, (e) => { if (at === generation.current) { setError(errorMessage(e)); setItems([]); setLoaded(true); } });
  }, deps);
  const loadMore = () => {
    if (next === null) return;
    const at = generation.current;
    setLoadingMore(true);
    load(next).then(({ items: page, next: more }) => {
      if (at !== generation.current) return;
      setItems((xs) => { const seen = new Set(xs.map(idOf)); return [...xs, ...page.filter((x) => !seen.has(idOf(x)))]; });
      setNext(more);
    }, (e) => setError(errorMessage(e))).finally(() => setLoadingMore(false));
  };
  return { items, setItems, next, loaded, loadingMore, loadMore, error, setError };
}


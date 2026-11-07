import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * The text an editor shows for one field: what the user is typing, or else
 * the field's current value in the chart.
 *
 * The buffer is seeded from `source` and reseeded when `resetKey` changes
 * (a different node or connection was selected). While the user types, the
 * buffer is the typed text and `source` follows it, so an unchanged or
 * echoing `source` never rewrites the field. When `source` changes to
 * something the user did not write, someone else changed the field, and the
 * buffer adopts it. Adopting never touches a field being typed in: the
 * chart keeps the user's text until it is saved, so a remote change to that
 * field cannot reach `source` before then.
 *
 * `mixed` means `source` stands for several differing values (a multi-node
 * selection), so it is a placeholder, not something to show.
 */
export function useFieldBuffer(
  source: string,
  resetKey: string,
  mixed: boolean,
): [string, (value: string) => void] {
  const [buffer, setBuffer] = useState(source);
  const lastWritten = useRef<string | null>(null);
  const seen = useRef({ source, resetKey });

  const write = useCallback((value: string) => {
    lastWritten.current = value;
    setBuffer(value);
  }, []);

  useLayoutEffect(() => {
    const previous = seen.current;
    seen.current = { source, resetKey };
    if (resetKey !== previous.resetKey) {
      lastWritten.current = null;
      setBuffer(source);
    } else if (source !== previous.source && source !== lastWritten.current && !mixed) {
      // The buffer now matches the source, so what the user typed earlier
      // no longer says which later source values are their own.
      lastWritten.current = null;
      setBuffer(source);
    }
  }, [resetKey, source]); // eslint-disable-line react-hooks/exhaustive-deps -- `mixed` is read on the render that changed `source`; a change of `mixed` alone must not resync

  return [buffer, write];
}

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * The text an editor shows for one field: what the user is typing, or else
 * the field's current value in the chart.
 *
 * The buffer is seeded from `source` and reseeded when `resetKey` changes
 * (a different node or connection was selected). While the user types, the
 * buffer is the typed text and `source` follows it, so an unchanged or
 * echoing `source` never rewrites the field. Any other change of `source`
 * is adopted: the hook cannot tell a collaborator's save from a stale value
 * the chart reverted to. Keeping a field stable under the user's hands while
 * they type is therefore the chart's job (it keeps the user's unsaved text
 * as `source`), not this hook's. A multi-selection whose values differ
 * passes `''`, which the editor shows as its "Multiple values" placeholder.
 */
export function useFieldBuffer(
  source: string,
  resetKey: string,
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
    const reselected = resetKey !== previous.resetKey;
    const changedElsewhere = source !== previous.source && source !== lastWritten.current;
    if (reselected || changedElsewhere) {
      // The buffer now matches the source, so what the user typed earlier
      // no longer says which later source values are their own.
      lastWritten.current = null;
      setBuffer(source);
    }
  }, [resetKey, source]);

  return [buffer, write];
}

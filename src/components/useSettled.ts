import { useEffect, useState } from 'react';

/** How long a search waits for the typing to pause before it asks. */
export const TYPING_PAUSE = 160;

/** A value as it was a moment ago, so that what follows it is not redone at every keystroke. Emptied, it follows at once. */
export function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (!value.trim()) return setSettled(value);
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value.trim() ? settled : value;
}

import type { ReactNode } from 'react';

/** Where in a text something was found: each a start and an end, in order, none overlapping. */
export type Ranges = [number, number][];

/** A text, or the stretch of it from `from` to `to`, with the found parts marked. The ranges are places in the whole text. */
export function Marked({ text, ranges, from = 0, to = text.length }: { text: string; ranges?: Ranges; from?: number; to?: number }) {
  if (!ranges?.length) return <>{text.slice(from, to)}</>;
  const out: ReactNode[] = [];
  let at = from;
  for (const [a, b] of ranges) {
    const [start, end] = [Math.max(a, from), Math.min(b, to)];
    if (start >= end) continue;
    if (start > at) out.push(text.slice(at, start));
    out.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < to) out.push(text.slice(at, to));
  return <>{out}</>;
}

/**
 * A text box whose text has the found parts marked. A text box cannot mark part of what is in
 * it, so the marks are drawn behind it, in the same place and the same letters, and show through.
 * While the box is being typed in they are out of the way. The wrapper is there whether or not
 * anything is marked, so that the box itself is never made anew when a search begins or ends.
 */
export function MarkedField({ text, ranges, children }: { text: string; ranges?: Ranges; children: ReactNode }) {
  return (
    <span className="hl-field">
      {!!ranges?.length && (
        <span className="hl-back" aria-hidden="true">
          <Marked text={text} ranges={ranges} />
        </span>
      )}
      {children}
    </span>
  );
}

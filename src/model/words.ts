import type { Term } from './types';

/**
 * How the app quotes a name in what it says: between curly quotes, “Film”. One function, so that
 * every message quotes the same way wherever it is worked out.
 */
export const quoted = (text: string): string => `“${text}”`;

/** A term's name, quoted; a term without one, or one that is gone, is “Unnamed”. */
export const quotedName = (t: Pick<Term, 'name'> | undefined): string => quoted(t?.name || 'Unnamed');

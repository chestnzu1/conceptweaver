import { Lexer } from 'n3';

/**
 * Where in a file of data a node is, for a finding to say: the line of a Turtle (or N-Triples, or
 * TriG) file on which statements about it begin, by reading the file as tokens, each of which
 * knows its line. A node that is the subject of no statement is placed where it is first named.
 * Blank nodes are not placed: the label a file gives one is not the one it has once read.
 */
export function subjectLines(text: string, iris: Set<string>): Map<string, number> {
  const subject = new Map<string, number>();
  const named = new Map<string, number>();
  if (!iris.size) return subject;
  let tokens: { type: string; value: string; prefix?: string; line: number }[];
  try {
    tokens = new Lexer().tokenize(text) as never;
  } catch {
    // What does not read as Turtle has no lines to give: the engine said so already.
    return subject;
  }
  const prefixes = new Map<string, string>();
  let base = '';
  const resolve = (iri: string) => {
    if (!base) return iri;
    try {
      return new URL(iri, base).href;
    } catch {
      return iri;
    }
  };
  /** Where a statement may begin: at the start, after a full stop, inside a graph. Not inside [ ] or ( ). */
  let starts = true;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case '@prefix':
      case 'PREFIX': {
        const name = tokens[i + 1];
        const iri = tokens[i + 2];
        if (name?.type === 'prefix' && iri?.type === 'IRI') prefixes.set(name.value, resolve(iri.value));
        i += 2;
        // "@prefix" ends with a full stop; "PREFIX" does not.
        starts = true;
        continue;
      }
      case '@base':
      case 'BASE': {
        const iri = tokens[i + 1];
        if (iri?.type === 'IRI') base = resolve(iri.value);
        i += 1;
        starts = true;
        continue;
      }
      case '.':
      case '{':
      case '}':
        if (depth === 0) starts = true;
        continue;
      case '[':
      case '(':
        if (starts && depth === 0) starts = false;
        depth++;
        continue;
      case ']':
      case ')':
        depth = Math.max(0, depth - 1);
        continue;
      case 'IRI':
      case 'prefixed': {
        const iri = t.type === 'IRI' ? resolve(t.value) : prefixes.has(t.prefix ?? '') ? prefixes.get(t.prefix ?? '')! + t.value : undefined;
        const at = starts && depth === 0;
        starts = false;
        if (!iri || !iris.has(iri)) continue;
        if (at && !subject.has(iri)) subject.set(iri, t.line);
        if (!named.has(iri)) named.set(iri, t.line);
        continue;
      }
      default:
        if (t.type !== 'eof') starts = false;
    }
  }
  for (const [iri, line] of named) if (!subject.has(iri)) subject.set(iri, line);
  return subject;
}

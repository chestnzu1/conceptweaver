import { localName } from '../model/iri';

/**
 * IRI templates (ADR-019): what each row's IRI is, as text with placeholders for its columns.
 * {Code} is the value as written, with what an IRI cannot hold percent-encoded; {Name:name} is the
 * value made into a name the way the editor makes an IRI from a name. "{{" and "}}" are braces.
 */

export type TemplatePart = { text: string } | { column: string; style: 'encoded' | 'name' };

/** The parts of a template; an error for one that does not read. */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if ((c === '{' || c === '}') && template[i + 1] === c) {
      text += c;
      i++;
      continue;
    }
    if (c === '}') throw new Error('A “}” closes no placeholder: write }} for a brace.');
    if (c !== '{') {
      text += c;
      continue;
    }
    const end = template.indexOf('}', i);
    if (end < 0) throw new Error('A placeholder is not closed with “}”.');
    const inside = template.slice(i + 1, end);
    const named = inside.endsWith(':name');
    const column = (named ? inside.slice(0, -5) : inside).trim();
    if (!column) throw new Error('A placeholder names no column.');
    if (text) parts.push({ text });
    text = '';
    parts.push({ column, style: named ? 'name' : 'encoded' });
    i = end;
  }
  if (text) parts.push({ text });
  return parts;
}

/** The columns a template is made from. */
export const templateColumns = (template: string): string[] => {
  try {
    return parseTemplate(template).flatMap((p) => ('column' in p ? [p.column] : []));
  } catch {
    return [];
  }
};

/** A value as an IRI may hold it: what is not allowed in one percent-encoded, as UTF-8. */
const encode = (value: string) => value.replace(/[^\p{L}\p{N}\-._~!$&'()*+,;=:@/]/gu, (c) => [...new TextEncoder().encode(c)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''));

/** A template filled in from a row: the IRI, or why there is none. */
export function fillTemplate(parts: TemplatePart[], value: (column: string) => string | undefined): { iri: string } | { error: string } {
  let iri = '';
  for (const p of parts) {
    if ('text' in p) {
      iri += p.text;
      continue;
    }
    const v = value(p.column)?.trim();
    if (v === undefined) return { error: `there is no column “${p.column}” for the IRI` };
    if (!v) return { error: `it has no value for ${p.column}, which its IRI is made from` };
    iri += p.style === 'name' ? localName(v, false) : encode(v);
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(iri)) return { error: `its IRI, ${iri || '(empty)'}, is not an IRI` };
  return { iri };
}

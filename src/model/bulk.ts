import { COLORS, DATATYPES, type ExtraField, type RelKind, type TermType } from './types';

export interface BulkTerm {
  name: string;
  /** Only set when the input gives one, so existing terms keep theirs. */
  type?: TermType;
  /** Datatype of a data property, e.g. "xsd:date". */
  range?: string;
  description: string;
  synonyms: string;
  color?: string;
  fields: ExtraField[];
}

export interface BulkRelation {
  from: string;
  to: string;
  label: string;
  kind: RelKind;
  line: number;
}

export interface Parsed<T> {
  items: T[];
  /** Lines that could not be used as written, with the reason. */
  notes: string[];
}

const TYPES: Record<string, { type: TermType }> = {
  concept: { type: 'concept' },
  class: { type: 'concept' },
  property: { type: 'property' },
  attribute: { type: 'property' },
  'data property': { type: 'property' },
  'datatype property': { type: 'property' },
  instance: { type: 'instance' },
  individual: { type: 'instance' },
};

/** Cells of a row: tab-separated (as pasted from a spreadsheet) or separated by "|". */
const cells = (line: string) => (line.includes('\t') ? line.split('\t') : line.split('|')).map((c) => c.trim());

const rows = (text: string) =>
  text
    .split('\n')
    .map((raw, i) => ({ raw: raw.replace(/\r$/, ''), line: i + 1 }))
    .filter((r) => r.raw.trim() && !r.raw.trim().startsWith('#'));

/**
 * Terms and their metadata, one term per row:
 *
 *   Name | Type | Description | Synonyms
 *
 * Only the name is required. If the first row is a header starting with "Name", its column
 * names decide what each column is, and any other column becomes an extra field.
 */
export function parseTerms(text: string): Parsed<BulkTerm> {
  const out: Parsed<BulkTerm> = { items: [], notes: [] };
  const all = rows(text);
  if (!all.length) return out;
  let columns = ['name', 'type', 'description', 'synonyms'];
  const first = cells(all[0].raw);
  const header = /^(name|term)$/i.test(first[0]);
  if (header) {
    columns = first.map((c) => c.toLowerCase());
    all.shift();
  }
  const byName = new Map<string, BulkTerm>();
  for (const { raw, line } of all) {
    let cs = cells(raw);
    // Shorthand kept from the single-box format: "Name: description".
    if (!header && cs.length === 1 && raw.indexOf(':') > 0) cs = [raw.slice(0, raw.indexOf(':')).trim(), '', raw.slice(raw.indexOf(':') + 1).trim()];
    const t: BulkTerm = { name: '', description: '', synonyms: '', fields: [] };
    cs.forEach((value, i) => {
      const col = columns[i];
      if (!value || !col) return;
      if (col === 'name' || col === 'term') t.name = value;
      else if (col === 'type' || col === 'kind') {
        const type = TYPES[value.toLowerCase()];
        if (type) Object.assign(t, type);
        else if (/^object property$/i.test(value)) out.notes.push(`Line ${line}: an object property is a relationship, not a term. Add it in step 2 or under Entities.`);
        else out.notes.push(`Line ${line}: “${value}” is not a type (concept, data property or instance); left as is.`);
      } else if (col === 'range' || col === 'datatype') {
        const v = value.toLowerCase();
        const datatype = DATATYPES.find((d) => d.id.toLowerCase() === v || d.id.split(':')[1].toLowerCase() === v || d.label === v);
        if (datatype) t.range = datatype.id;
        else out.notes.push(`Line ${line}: “${value}” is not a datatype (${DATATYPES.map((d) => d.id.split(':')[1]).join(', ')}).`);
      } else if (col === 'description' || col === 'definition') t.description = value;
      else if (col === 'synonyms' || col === 'synonym') t.synonyms = value;
      else if (col === 'colour' || col === 'color') {
        if ((COLORS as readonly string[]).includes(value.toLowerCase())) t.color = value.toLowerCase();
        else out.notes.push(`Line ${line}: “${value}” is not one of the colours (${COLORS.filter(Boolean).join(', ')}).`);
      } else t.fields.push({ key: first[i], value });
    });
    if (!t.name) {
      out.notes.push(`Line ${line}: no name, skipped.`);
      continue;
    }
    const dup = byName.get(t.name.toLowerCase());
    if (dup) {
      Object.assign(dup, { ...t, description: t.description || dup.description, synonyms: t.synonyms || dup.synonyms, fields: [...dup.fields, ...t.fields] });
      continue;
    }
    byName.set(t.name.toLowerCase(), t);
    out.items.push(t);
  }
  return out;
}

/**
 * Relationships, one per row, as arrows or as columns:
 *
 *   From -> label -> To          From | label | To
 *   From -> To                   From | To
 *
 * The labels "is a" and "has property" produce those relation kinds.
 */
export function parseRelations(text: string): Parsed<BulkRelation> {
  const out: Parsed<BulkRelation> = { items: [], notes: [] };
  rows(text).forEach(({ raw, line }, i) => {
    const parts = raw.includes('->') ? raw.split('->').map((p) => p.trim()) : cells(raw);
    if (i === 0 && /^(from|source|subject)$/i.test(parts[0])) return;
    const from = parts[0];
    const to = parts.length > 1 ? parts[parts.length - 1] : '';
    if (!from || !to) {
      out.notes.push(`Line ${line}: expected “From -> label -> To”, skipped.`);
      return;
    }
    let label = parts.length > 2 ? parts.slice(1, -1).join(' ').trim() : '';
    let kind: RelKind = 'association';
    if (/^(is[- ]an?|kind of|subclass of|(has )?broader( term)?|bt)$/i.test(label)) {
      kind = 'generalization';
      label = '';
    } else if (/^((has )?narrower( term)?|nt)$/i.test(label)) {
      // "A narrower B" says B is the more specific one.
      out.items.push({ from: to, to: from, label: '', kind: 'generalization', line });
      return;
    } else if (/^has property$/i.test(label)) {
      kind = 'property';
      label = '';
    }
    out.items.push({ from, to, label, kind, line });
  });
  return out;
}

export interface Outline {
  /** Names in the order they appear, each once. */
  terms: string[];
  /** One entry per indented line: the term and the term it sits under. */
  rels: BulkRelation[];
}

/**
 * A hierarchy written as an indented list: each line is a term, and a line indented further
 * than the one above it is narrower than (a kind of) that term.
 *
 *   Animals
 *     Mammals
 *       Dogs
 *     Birds
 */
export function parseOutline(text: string): Parsed<never> & Outline {
  const out: Parsed<never> & Outline = { items: [], notes: [], terms: [], rels: [] };
  const seen = new Set<string>();
  const stack: { indent: number; name: string }[] = [];
  for (const { raw, line } of rows(text)) {
    const indent = raw.match(/^[\t ]*/)![0].replace(/\t/g, '    ').length;
    const name = raw.trim().replace(/^[-*•]\s+/, '');
    if (!name) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.terms.push(name);
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      if (parent.name.toLowerCase() === name.toLowerCase()) out.notes.push(`Line ${line}: “${name}” cannot sit under itself, skipped.`);
      else out.rels.push({ from: name, to: parent.name, label: '', kind: 'generalization', line });
    }
    stack.push({ indent, name });
  }
  return out;
}

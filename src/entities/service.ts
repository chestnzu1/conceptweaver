import { EntityQueryError, type CallOptions, type EntityDescription, type EntityFilterSpec, type ListKind, type EntityMatch, type EntityPage, type EntityQuery, type EntityQueryService, type EntitySortSpec, type FilterOption, type FilterValues, type OntologyRef, type OptionsPage, type OptionsQuery, type SearchText } from './contracts';

/**
 * The searching, sorting and filtering themselves, over entities held as records: what each is
 * searched by, what it is under each sort, and what it has for each filter. Where the records
 * come from is not known here. The model in the editor gives them today (local.ts); anything
 * else that can give them, or answer the questions outright, takes its place.
 */

export interface EntityRecord {
  key: string;
  iri?: string;
  label: string;
  /** What it is searched by, the name first. */
  texts: SearchText[];
  /** What it is under each sort: a text or a number. Nothing: it comes after everything that has one. */
  sort: Record<string, string | number | undefined>;
  /** For each filter, the options it has; `ON` for a filter that is on or off. */
  facts: Record<string, string[]>;
}

/** An entity there is to choose as a filter's option, with what it is found by: its name and prefixed IRI, and its full IRI, in lower case. */
export interface Candidate extends FilterOption {
  text: string;
  iri?: string;
}

export interface RecordSource extends OntologyRef {
  /** The entities of a kind, in the order the ontology has them. */
  records(kind: ListKind): EntityRecord[];
  sorts(kind: ListKind): EntitySortSpec[];
  filters(kind: ListKind): EntityFilterSpec[];
  /**
   * For a filter that costs something to answer (it asks a reasoner): the options each entity
   * has, by key. It is asked for only when the filter is on. Nothing: the records have it.
   */
  costly?(kind: ListKind, filter: string): { facts: Map<string, string[]>; note?: string } | undefined;
  /** The entities there are to choose from for a filter whose options are entities. */
  candidates?(kind: ListKind, filter: string): Candidate[];
}

/** How many rows a page has when nothing is asked for, and at most. */
export const PAGE = 150;
export const MAX_PAGE = 1000;
/** How many words of a search are looked for; the rest are let be. */
const MAX_WORDS = 8;
/** How many of the places a text was found in are told for one entity. */
const MAX_MATCHES = 4;

/** The words of a search: what is between the spaces, in lower case, each once. */
export function wordsOf(search: string | undefined): string[] {
  return [...new Set((search ?? '').toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_WORDS);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const lowered = new WeakMap<EntityRecord, string[]>();
const lower = (r: EntityRecord): string[] => lowered.get(r) ?? lowered.set(r, r.texts.map((t) => t.text.toLowerCase())).get(r)!;

/**
 * Whether a word is written the way part of an IRI is. Only such a word is looked for in a full
 * IRI: every IRI under http://example.org/ has "http", "example" and "org" in it, and a search
 * for the class Organisation by "org" is not a search for all of those.
 */
const iriLike = (word: string) => /[:/#.]/.test(word);
/** Whether a word is found in one of the texts an entity is searched by. */
const inText = (r: EntityRecord, texts: string[], i: number, word: string) => texts[i].includes(word) && (r.texts[i].field !== 'iri' || iriLike(word));

/** Whether every word is somewhere in what the entity is searched by. */
const found = (r: EntityRecord, words: string[]): boolean => {
  const texts = lower(r);
  return words.every((w) => texts.some((_, i) => inText(r, texts, i, w)));
};

/** Where in a text the words are: every occurrence of each, the ones that touch or overlap made one. */
function rangesIn(text: string, words: string[]): [number, number][] {
  const found: [number, number][] = [];
  for (const w of words) for (let at = text.indexOf(w); at >= 0; at = text.indexOf(w, at + w.length)) found.push([at, at + w.length]);
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const r of found) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function matchesOf(r: EntityRecord, words: string[]): EntityMatch[] {
  const texts = lower(r);
  const out: EntityMatch[] = [];
  for (let i = 0; i < texts.length && out.length < MAX_MATCHES; i++) {
    const here = words.filter((w) => inText(r, texts, i, w));
    if (here.length) out.push({ ...r.texts[i], ranges: rangesIn(texts[i], here) });
  }
  return out;
}

const clamp = (n: number | undefined, otherwise: number, max: number) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : otherwise);

/**
 * The filters of a question as they will be applied: the ones that are on, each with the
 * options chosen. A filter the kind does not have is a question that makes no sense.
 */
function chosen(specs: EntityFilterSpec[], values: FilterValues | undefined): { spec: EntityFilterSpec; values: string[] }[] {
  const out: { spec: EntityFilterSpec; values: string[] }[] = [];
  for (const [id, picked] of Object.entries(values ?? {})) {
    const spec = specs.find((f) => f.id === id);
    if (!spec) throw new EntityQueryError('invalid', `There is no filter “${id}” for this kind of entity.`);
    if (!Array.isArray(picked)) throw new EntityQueryError('invalid', `The filter “${id}” is given as a list of the options chosen.`);
    const values_ = [...new Set(picked.map(String))];
    if (values_.length) out.push({ spec, values: spec.type === 'one' || spec.type === 'flag' ? values_.slice(0, 1) : values_ });
  }
  return out;
}

export function createRecordService(current: () => RecordSource): EntityQueryService {
  const at = (query: OntologyRef, options?: CallOptions): RecordSource => {
    if (options?.signal?.aborted) throw new EntityQueryError('aborted', 'The question was given up.');
    const now = current();
    if (query.ontologyId !== now.ontologyId || query.revisionId !== now.revisionId) throw new EntityQueryError('stale-revision', 'The ontology has changed since this was asked about.');
    return now;
  };
  return {
    async describe(query, options): Promise<EntityDescription> {
      const source = at(query, options);
      return { kind: query.kind, revisionId: source.revisionId, total: source.records(query.kind).length, sorts: source.sorts(query.kind), filters: source.filters(query.kind) };
    },

    async query(query: EntityQuery, options): Promise<EntityPage> {
      const source = at(query, options);
      const all = source.records(query.kind);
      const words = wordsOf(query.search);
      const notes: string[] = [];
      const sort = query.sort;
      if (sort && !source.sorts(query.kind).some((s) => s.id === sort.by)) throw new EntityQueryError('invalid', `This kind of entity is not sorted by “${sort.by}”.`);

      // Each filter that is on, as a question put to one entity.
      const tests: ((r: EntityRecord) => boolean)[] = [];
      for (const { spec, values } of chosen(source.filters(query.kind), query.filters)) {
        if (spec.unavailable) {
          // It is let be rather than answered with nothing: what is listed is then at least true.
          notes.push(`“${spec.label}” is not applied: ${spec.unavailable}`);
          continue;
        }
        const costly = source.costly?.(query.kind, spec.id);
        if (costly?.note) notes.push(costly.note);
        const has = (r: EntityRecord) => costly?.facts.get(r.key) ?? r.facts[spec.id] ?? [];
        tests.push(spec.type === 'all' ? (r) => values.every((v) => has(r).includes(v)) : (r) => values.some((v) => has(r).includes(v)));
      }

      let left = tests.length || words.length ? all.filter((r) => tests.every((t) => t(r)) && (!words.length || found(r, words))) : all;
      if (sort) {
        const sign = sort.dir === 'desc' ? -1 : 1;
        // Array.prototype.sort is stable: what is equal under the sort stays in the ontology's order.
        left = [...left].sort((a, b) => {
          const [x, y] = [a.sort[sort.by], b.sort[sort.by]];
          const [noX, noY] = [x === undefined || x === '', y === undefined || y === ''];
          // An entity that has nothing to be sorted by comes last, whichever way the sort runs.
          if (noX || noY) return noX === noY ? 0 : noX ? 1 : -1;
          return sign * (typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y)));
        });
      }
      const offset = Math.max(0, Math.min(left.length, Math.floor(query.offset ?? 0) || 0));
      const limit = clamp(query.limit, PAGE, MAX_PAGE);
      const rows = left.slice(offset, offset + limit).map((r) => ({ key: r.key, ...(r.iri ? { iri: r.iri } : {}), label: r.label, ...(words.length ? { matches: matchesOf(r, words) } : {}) }));
      return { kind: query.kind, revisionId: source.revisionId, rows, offset, total: all.length, matched: left.length, words, notes };
    },

    async options(query: OptionsQuery, options): Promise<OptionsPage> {
      const source = at(query, options);
      const spec = source.filters(query.kind).find((f) => f.id === query.filter);
      if (!spec?.entities) throw new EntityQueryError('invalid', `There is no filter “${query.filter}” with entities to choose from for this kind of entity.`);
      const words = wordsOf(query.search);
      const all = source.candidates?.(query.kind, query.filter) ?? [];
      const hits = words.length ? all.filter((c) => words.every((w) => c.text.includes(w) || (iriLike(w) && !!c.iri?.includes(w)))) : all;
      const q = (query.search ?? '').trim().toLowerCase();
      // By name first (the same, then starting with the text, then holding it), then the ones most entities have.
      const score = (c: Candidate) => {
        const label = c.label.toLowerCase();
        return !q ? 0 : label === q ? 0 : label.startsWith(q) ? 1 : label.includes(q) ? 2 : 3;
      };
      const best = [...hits].sort((a, b) => score(a) - score(b) || (b.count ?? 0) - (a.count ?? 0) || collator.compare(a.label, b.label));
      return { options: best.slice(0, clamp(query.limit, 8, 50)).map(({ text: _text, iri: _iri, ...option }) => option), total: hits.length };
    },
  };
}

import { describe, expect, it } from 'vitest';
import { EntityQueryError, ON, type EntityFilterSpec, type EntityQuery, type EntitySortSpec } from './contracts';
import { createRecordService, MAX_PAGE, PAGE, wordsOf, type Candidate, type EntityRecord, type RecordSource } from './service';

const REF = { ontologyId: 'onto', revisionId: 'r1' };

/** A class as a record: `supers` and `subs` are counts, `texts` what it is found by besides its name and IRI. */
const record = (label: string, more: { supers?: number; subs?: number; alt?: string[]; tags?: string[]; iri?: string | null } = {}): EntityRecord => {
  const iri = more.iri === null ? undefined : (more.iri ?? 'http://example.org/onto#' + label.replace(/\s+/g, ''));
  return {
    key: label.toLowerCase(),
    ...(iri ? { iri } : {}),
    label,
    texts: [{ field: 'name', text: label }, ...(more.alt ?? []).map((text) => ({ field: 'label' as const, property: 'skos:altLabel', text })), ...(iri ? [{ field: 'iri' as const, text: iri }, { field: 'curie' as const, text: 'ex:' + iri.split('#')[1] }] : [])],
    sort: { name: label, iri, superclasses: more.supers ?? 0, subclasses: more.subs ?? 0 },
    facts: { position: [...(more.supers ? [] : ['root']), ...(more.subs ? [] : ['leaf'])], multiple: (more.supers ?? 0) > 1 ? [ON] : [], tag: more.tags ?? [] },
  };
};

const RECORDS = [
  record('Party', { subs: 2 }),
  record('person', { supers: 1, subs: 2, alt: ['Human being', 'Natural person'] }),
  record('Organisation', { supers: 1, subs: 1, alt: ['Legal person'], tags: ['legal'] }),
  record('Clerk 10', { supers: 1 }),
  record('Clerk 9', { supers: 2, tags: ['legal', 'staff'] }),
  record('Charity', { supers: 1, tags: ['staff'] }),
  record('', { iri: null }),
  record('Ghost'),
];
const SORTS: EntitySortSpec[] = [
  { id: 'name', label: 'Name' },
  { id: 'iri', label: 'IRI' },
  { id: 'superclasses', label: 'Superclasses', numeric: true },
  { id: 'subclasses', label: 'Subclasses', numeric: true },
];
const FILTERS: EntityFilterSpec[] = [
  { id: 'position', label: 'Hierarchy', about: '', type: 'all', options: [{ value: 'root', label: 'Root' }, { value: 'leaf', label: 'Leaf' }] },
  { id: 'multiple', label: 'Multiple inheritance', about: '', type: 'flag', options: [{ value: ON, label: 'Yes' }] },
  { id: 'tag', label: 'Tag', about: '', type: 'any', options: [{ value: 'legal', label: 'Legal' }, { value: 'staff', label: 'Staff' }] },
  { id: 'empty', label: 'Unsatisfiable', about: '', type: 'flag', options: [{ value: ON, label: 'Yes' }] },
  { id: 'broken', label: 'Inferred', about: '', type: 'flag', options: [{ value: ON, label: 'Yes' }], unavailable: 'the ontology is inconsistent.' },
  { id: 'member', label: 'Member of', about: '', type: 'any', options: [], entities: true },
];
const CANDIDATES: Candidate[] = [
  { value: 'party', label: 'Party', count: 1, text: 'party\nex:party', iri: 'http://example.org/onto#party' },
  { value: 'person', label: 'Person', count: 5, text: 'person\nex:person', iri: 'http://example.org/onto#person' },
  { value: 'personnel', label: 'Personnel', count: 9, text: 'personnel\nex:personnel', iri: 'http://example.org/onto#personnel' },
  { value: 'superperson', label: 'Superperson', count: 2, text: 'superperson\nex:superperson', iri: 'http://example.org/onto#superperson' },
];

function service(records = RECORDS) {
  const asked: string[] = [];
  const source: RecordSource = {
    ...REF,
    records: () => records,
    sorts: () => SORTS,
    filters: () => FILTERS,
    costly: (_kind, filter) => {
      if (filter !== 'empty' && filter !== 'broken') return undefined;
      asked.push(filter);
      return { facts: new Map([['ghost', [ON]]]), note: 'As found by the test reasoner.' };
    },
    candidates: () => CANDIDATES,
  };
  return { service: createRecordService(() => source), asked };
}
const ask = async (query: Partial<EntityQuery> = {}, records?: EntityRecord[]) => service(records).service.query({ ...REF, kind: 'class', ...query });
const labels = async (query: Partial<EntityQuery> = {}) => (await ask(query)).rows.map((r) => r.label || '(unnamed)');

describe('searching', () => {
  it('finds a text anywhere in the name, another label, the full IRI or the prefixed one, whatever the case', async () => {
    expect(await labels({ search: 'ERS' })).toEqual(['person', 'Organisation']);
    expect(await labels({ search: 'human' })).toEqual(['person']);
    expect(await labels({ search: 'example.org/onto#Char' })).toEqual(['Charity']);
    expect(await labels({ search: 'ex:gho' })).toEqual(['Ghost']);
    expect(await labels({ search: '   ' })).toHaveLength(RECORDS.length);
    expect(await labels({ search: 'zzz' })).toEqual([]);
    // A plain word is not looked for in the full IRI, which has "http", "example" and "org" in it for every entity.
    expect(await labels({ search: 'org' })).toEqual(['Organisation']);
    expect(await labels({ search: 'http' })).toEqual([]);
    expect(await labels({ search: 'example.org' })).toHaveLength(RECORDS.length - 1);
  });

  it('wants every word of it, each wherever it is', async () => {
    expect(await labels({ search: 'legal person' })).toEqual(['Organisation']);
    expect(await labels({ search: 'person legal' })).toEqual(['Organisation']);
    // One word in the name, the other in the IRI.
    expect(await labels({ search: 'clerk onto#Clerk9' })).toEqual(['Clerk 9']);
    expect(wordsOf('  Legal   PERSON legal ')).toEqual(['legal', 'person']);
    expect(wordsOf(undefined)).toEqual([]);
  });

  it('says where the text was found and which words were looked for, and how many there are of how many', async () => {
    const page = await ask({ search: 'Natural PERSON' });
    expect(page).toMatchObject({ kind: 'class', revisionId: 'r1', total: RECORDS.length, matched: 1, words: ['natural', 'person'], offset: 0 });
    expect(page.rows[0].matches).toEqual([
      { field: 'name', text: 'person', ranges: [[0, 6]] },
      { field: 'label', property: 'skos:altLabel', text: 'Natural person', ranges: [[0, 7], [8, 14]] },
      { field: 'curie', text: 'ex:person', ranges: [[3, 9]] },
    ]);
    expect((await ask({ search: 'onto#per' })).rows[0].matches).toEqual([{ field: 'iri', text: 'http://example.org/onto#person', ranges: [[19, 27]] }]);
    // Words that overlap or touch in the text are marked as one stretch; every occurrence is marked.
    expect((await ask({ search: 'ani nisa sat' })).rows[0].matches![0]).toEqual({ field: 'name', text: 'Organisation', ranges: [[3, 9]] });
    expect((await ask({ search: 'a' })).rows.find((r) => r.label === 'Charity')!.matches![0].ranges).toEqual([[2, 3]]);
    expect((await ask({ search: 'n' })).rows.find((r) => r.label === 'Organisation')!.matches![0].ranges).toEqual([[4, 5], [11, 12]]);
    // Without a search nothing is said about matches.
    expect((await ask()).rows[0].matches).toBeUndefined();
    expect((await ask()).words).toEqual([]);
  });
});

describe('sorting', () => {
  it('leaves the ontology in its own order unless asked', async () => {
    expect(await labels()).toEqual(['Party', 'person', 'Organisation', 'Clerk 10', 'Clerk 9', 'Charity', '(unnamed)', 'Ghost']);
  });

  it('puts names in order as people read them, either way, with what has no name last both times', async () => {
    expect(await labels({ sort: { by: 'name', dir: 'asc' } })).toEqual(['Charity', 'Clerk 9', 'Clerk 10', 'Ghost', 'Organisation', 'Party', 'person', '(unnamed)']);
    expect(await labels({ sort: { by: 'name', dir: 'desc' } })).toEqual(['person', 'Party', 'Organisation', 'Ghost', 'Clerk 10', 'Clerk 9', 'Charity', '(unnamed)']);
    expect((await labels({ sort: { by: 'iri', dir: 'asc' } })).at(-1)).toBe('(unnamed)');
  });

  it('is stable: what is equal under a sort stays in the order it had', async () => {
    expect(await labels({ sort: { by: 'superclasses', dir: 'desc' } })).toEqual(['Clerk 9', 'person', 'Organisation', 'Clerk 10', 'Charity', 'Party', '(unnamed)', 'Ghost']);
    expect(await labels({ sort: { by: 'superclasses', dir: 'asc' } })).toEqual(['Party', '(unnamed)', 'Ghost', 'person', 'Organisation', 'Clerk 10', 'Charity', 'Clerk 9']);
    expect(await labels({ sort: { by: 'subclasses', dir: 'desc' } })).toEqual(['Party', 'person', 'Organisation', 'Clerk 10', 'Clerk 9', 'Charity', '(unnamed)', 'Ghost']);
  });

  it('does not change the records it was given', async () => {
    const before = RECORDS.map((r) => r.key);
    await ask({ sort: { by: 'name', dir: 'desc' }, search: 'c' });
    expect(RECORDS.map((r) => r.key)).toEqual(before);
  });
});

describe('filtering', () => {
  it('takes a flag, one option, any of several and all of several', async () => {
    expect(await labels({ filters: { multiple: [ON] } })).toEqual(['Clerk 9']);
    expect(await labels({ filters: { position: ['root'] } })).toEqual(['Party', '(unnamed)', 'Ghost']);
    // All of the options chosen: a root that is a leaf too stands alone.
    expect(await labels({ filters: { position: ['root', 'leaf'] } })).toEqual(['(unnamed)', 'Ghost']);
    // Any of the options chosen.
    expect(await labels({ filters: { tag: ['legal', 'staff'] } })).toEqual(['Organisation', 'Clerk 9', 'Charity']);
    expect(await labels({ filters: { tag: ['legal'] } })).toEqual(['Organisation', 'Clerk 9']);
  });

  it('combines filters with each other, with a search and with a sort', async () => {
    expect(await labels({ filters: { tag: ['legal', 'staff'], position: ['leaf'] } })).toEqual(['Clerk 9', 'Charity']);
    expect(await labels({ filters: { tag: ['legal', 'staff'], position: ['leaf'] }, search: 'cler' })).toEqual(['Clerk 9']);
    expect(await labels({ filters: { position: ['leaf'] }, search: 'c', sort: { by: 'name', dir: 'desc' } })).toEqual(['Clerk 10', 'Clerk 9', 'Charity']);
    const page = await ask({ filters: { position: ['leaf'] }, search: 'c' });
    expect([page.matched, page.total]).toEqual([3, RECORDS.length]);
  });

  it('counts a filter with nothing chosen as off', async () => {
    expect(await labels({ filters: { tag: [], position: [] } })).toHaveLength(RECORDS.length);
  });

  it('asks for what costs a reasoner only when the filter is on, and passes on what the reasoner has to say', async () => {
    const { service: s, asked } = service();
    expect((await s.query({ ...REF, kind: 'class', filters: { multiple: [ON] } })).notes).toEqual([]);
    expect(asked).toEqual([]);
    const page = await s.query({ ...REF, kind: 'class', filters: { empty: [ON] } });
    expect(page.rows.map((r) => r.label)).toEqual(['Ghost']);
    expect(page.notes).toEqual(['As found by the test reasoner.']);
    expect(asked).toEqual(['empty']);
  });

  it('lets a filter that cannot be answered be, and says so, rather than answering with nothing', async () => {
    const { service: s, asked } = service();
    const page = await s.query({ ...REF, kind: 'class', filters: { broken: [ON], multiple: [ON] } });
    expect(page.rows.map((r) => r.label)).toEqual(['Clerk 9']);
    expect(page.notes).toEqual(['“Inferred” is not applied: the ontology is inconsistent.']);
    expect(asked).toEqual([]);
  });
});

describe('pages', () => {
  const many = Array.from({ length: 2500 }, (_, i) => record('Class ' + i));

  it('answers a page at a time, of the size asked for within limits', async () => {
    const first = await ask({}, many);
    expect([first.rows.length, first.offset, first.matched, first.total]).toEqual([PAGE, 0, 2500, 2500]);
    const second = await ask({ offset: PAGE, limit: 40 }, many);
    expect([second.rows.length, second.offset, second.rows[0].label]).toEqual([40, PAGE, 'Class ' + PAGE]);
    expect((await ask({ limit: 100000 }, many)).rows).toHaveLength(MAX_PAGE);
    expect((await ask({ limit: -3 }, many)).rows).toHaveLength(PAGE);
    // Past the end there is nothing, and that is an answer.
    expect(await ask({ offset: 99999 }, many)).toMatchObject({ rows: [], offset: 2500, matched: 2500 });
  });

  it('pages through what a search, a filter and a sort leave', async () => {
    const page = await ask({ search: 'class 24', sort: { by: 'name', dir: 'desc' }, offset: 1, limit: 3 }, many);
    // Two words, each wherever it is: every class whose number has a 24 in it.
    expect(page.matched).toBe(many.filter((r) => r.label.includes('24')).length);
    expect(page.rows.map((r) => r.label)).toEqual(['Class 2498', 'Class 2497', 'Class 2496']);
  });

  it('is quick on a long list', async () => {
    const long = Array.from({ length: 50000 }, (_, i) => record('Class ' + i, { supers: i % 3, alt: ['Alternative ' + (i % 97)] }));
    const s = createRecordService(() => ({ ...REF, records: () => long, sorts: () => SORTS, filters: () => FILTERS }));
    await s.query({ ...REF, kind: 'class', search: 'warm up' });
    const t = performance.now();
    const page = await s.query({ ...REF, kind: 'class', search: 'alternative 5', filters: { position: ['leaf'] }, sort: { by: 'name', dir: 'desc' } });
    expect(performance.now() - t).toBeLessThan(400);
    expect(page.matched).toBeGreaterThan(5000);
  });
});

describe('what there is to ask for', () => {
  it('describes the sorts and the filters of a kind', async () => {
    const d = await service().service.describe({ ...REF, kind: 'class' });
    expect(d).toEqual({ kind: 'class', revisionId: 'r1', total: RECORDS.length, sorts: SORTS, filters: FILTERS });
  });

  it('offers the entities of a filter by what is typed: the best match first, then the ones most entities have', async () => {
    const { service: s } = service();
    const options = async (search?: string, limit?: number) => (await s.options({ ...REF, kind: 'class', filter: 'member', search, limit })).options.map((o) => o.label);
    expect(await options()).toEqual(['Personnel', 'Person', 'Superperson', 'Party']);
    expect(await options('person')).toEqual(['Person', 'Personnel', 'Superperson']);
    expect(await options('ex:pa')).toEqual(['Party']);
    expect(await options('onto#super')).toEqual(['Superperson']);
    // A plain word is not looked for in the full IRI.
    expect(await options('example')).toEqual([]);
    expect(await options('per', 1)).toEqual(['Personnel']);
    const page = await s.options({ ...REF, kind: 'class', filter: 'member', search: 'per', limit: 1 });
    expect(page).toEqual({ options: [{ value: 'personnel', label: 'Personnel', count: 9 }], total: 3 });
  });
});

describe('questions that are not answered', () => {
  const refused = async (run: () => Promise<unknown>) => run().then(() => 'answered', (e) => (e instanceof EntityQueryError ? e.code : 'other'));

  it('refuses a revision that is not the one it has, a sort or a filter the kind does not have, and a question given up', async () => {
    const { service: s } = service();
    expect(await refused(() => s.query({ ontologyId: 'onto', revisionId: 'r0', kind: 'class' }))).toBe('stale-revision');
    expect(await refused(() => s.describe({ ontologyId: 'other', revisionId: 'r1', kind: 'class' }))).toBe('stale-revision');
    expect(await refused(() => s.query({ ...REF, kind: 'class', sort: { by: 'colour', dir: 'asc' } }))).toBe('invalid');
    expect(await refused(() => s.query({ ...REF, kind: 'class', filters: { colour: ['red'] } }))).toBe('invalid');
    expect(await refused(() => s.query({ ...REF, kind: 'class', filters: { tag: 'legal' as unknown as string[] } }))).toBe('invalid');
    expect(await refused(() => s.options({ ...REF, kind: 'class', filter: 'tag' }))).toBe('invalid');
    const gone = new AbortController();
    gone.abort();
    expect(await refused(() => s.query({ ...REF, kind: 'class' }, { signal: gone.signal }))).toBe('aborted');
  });
});

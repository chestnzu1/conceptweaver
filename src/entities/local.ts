import { standardAnnotation } from '../model/annotations';
import { rangeLabel } from '../model/datatypes';
import { propDatatype, propDatatypes } from '../model/domains';
import { expressionOf, FAST_CREDIT, restrictionKey } from '../model/inferred';
import { configOf, supports } from '../model/modelTypes';
import { compactIri } from '../model/prefixes';
import { assertedSuperclasses, CHARACTERISTICS, dataDomain, objectProperties, propLinks, relChoice, restrictionsOf } from '../model/props';
import { reason } from '../model/reasoner';
import type { ReasoningResult } from '../model/reasoning';
import { stable } from '../model/stable';
import type { ExtraField, Model, Term } from '../model/types';
import { resolveModel } from '../model/vocab';
import { ontologyRef } from '../structure/local';
import { ON, type EntityFilterSpec, type ListKind, type EntityQueryService, type EntitySortSpec, type FilterOption, type SearchText } from './contracts';
import { createRecordService, type Candidate, type EntityRecord } from './service';

/**
 * The model in the editor as the entity queries see it: a record for each class, property,
 * individual and relationship, with what it is searched by, what it is sorted by and what it has
 * for each filter. This is the one place where those are read off the app's own model; the
 * searching, sorting and filtering themselves (service.ts) know nothing of it.
 *
 * Nothing here changes the model. The records of a revision are made once, when first asked
 * for, and what needs a reasoner only when a filter that rests on one is switched on.
 */

/** The annotations that are names of an entity, which a search for it should find it by. */
const NAMES = new Set(['rdfs:label', 'skos:prefLabel', 'skos:altLabel', 'skos:hiddenLabel', 'skos:notation', 'dcterms:title']);

const count = (records: EntityRecord[], filter: string, value: string) => records.reduce((n, r) => n + (r.facts[filter]?.includes(value) ? 1 : 0), 0);
const flag = (on: boolean): string[] => (on ? [ON] : []);
const withOrWithout = (has: boolean): string[] => [has ? 'with' : 'without'];
const yes = (records: EntityRecord[], filter: string): FilterOption[] => [{ value: ON, label: 'Yes', count: count(records, filter, ON) }];
const setOrNot = (records: EntityRecord[], filter: string): FilterOption[] => [
  { value: 'with', label: 'Set', count: count(records, filter, 'with') },
  { value: 'without', label: 'Not set', count: count(records, filter, 'without') },
];

/** What an entity is searched by: its name, its other names, its IRI in full and with a prefix, and its definition. */
function textsOf(model: Model, e: { name: string; description: string; iri?: string; synonyms?: string; fields?: ExtraField[] }): SearchText[] {
  const texts: SearchText[] = [{ field: 'name', text: e.name }];
  for (const s of (e.synonyms ?? '').split(',')) if (s.trim()) texts.push({ field: 'label', property: 'skos:altLabel', text: s.trim() });
  for (const f of e.fields ?? []) {
    const property = standardAnnotation(f.key);
    if (property && NAMES.has(property) && !f.iri && f.value.trim()) texts.push({ field: 'label', property, text: f.value });
  }
  if (e.iri) {
    texts.push({ field: 'iri', text: e.iri });
    const curie = compactIri(model, e.iri);
    if (curie) texts.push({ field: 'curie', text: curie });
  }
  if (e.description.trim()) texts.push({ field: 'description', text: e.description });
  return texts;
}

const candidate = (model: Model, t: Pick<Term, 'id' | 'name' | 'iri'>, n?: number): Candidate => ({
  value: t.id,
  label: t.name || 'Unnamed',
  ...(n !== undefined ? { count: n } : {}),
  text: `${t.name}\n${t.iri ? (compactIri(model, t.iri) ?? '') : ''}`.toLowerCase(),
  ...(t.iri ? { iri: t.iri.toLowerCase() } : {}),
});

interface Index {
  records(kind: ListKind): EntityRecord[];
  sorts(kind: ListKind): EntitySortSpec[];
  filters(kind: ListKind, dl: ReasoningResult | undefined): EntityFilterSpec[];
  costly(kind: ListKind, filter: string, dl: ReasoningResult | undefined): { facts: Map<string, string[]>; note?: string } | undefined;
  candidates(kind: ListKind, filter: string): Candidate[];
}

const NAME: EntitySortSpec = { id: 'name', label: 'Name' };
const IRI: EntitySortSpec = { id: 'iri', label: 'IRI' };

function build(model: Model): Index {
  const config = configOf(model);
  const oneKind = config.termTypes.length < 2;
  const words = config.hierarchy;
  const reasoned = supports(model, 'reasoning');
  const restricted = supports(model, 'restrictions');
  const name = new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed']));
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  // Where there is one kind of term, every term is of it.
  const of = (type: Term['type']) => model.terms.filter((t) => oneKind || t.type === type);
  let degree: Map<string, number> | undefined;
  const degreeOf = (id: string) => {
    if (!degree) {
      degree = new Map();
      for (const r of model.relations) {
        degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
        if (r.to !== r.from) degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
      }
    }
    return degree.get(id) ?? 0;
  };

  const made: Partial<Record<ListKind, EntityRecord[]>> = {};
  const makers: Record<ListKind, () => EntityRecord[]> = {
    class: () => {
      const classes = of('concept');
      const ids = new Set(classes.map((t) => t.id));
      const parents = new Map(classes.map((t) => [t.id, assertedSuperclasses(model, t.id).filter((p) => ids.has(p) && p !== t.id)]));
      const children = new Map<string, number>();
      for (const supers of parents.values()) for (const p of supers) children.set(p, (children.get(p) ?? 0) + 1);
      return classes.map((t) => {
        const supers = parents.get(t.id)!.length;
        const subs = children.get(t.id) ?? 0;
        // What the table lists as asserted: the restrictions by a property, and the class axioms with an expression.
        const restrictions = restricted ? restrictionsOf(model, t.id).length + (t.classAxioms?.length ?? 0) : 0;
        return {
          key: t.id,
          ...(t.iri ? { iri: t.iri } : {}),
          label: t.name || 'Unnamed',
          texts: textsOf(model, t),
          sort: { name: t.name, iri: t.iri, superclasses: supers, subclasses: subs, restrictions, relations: degreeOf(t.id) },
          facts: { position: [...(supers ? [] : ['root']), ...(subs ? [] : ['leaf'])], multipleInheritance: flag(supers > 1), assertedRestrictions: flag(restrictions > 0) },
        };
      });
    },
    objectProperty: () =>
      objectProperties(model).map((p) => ({
        key: p.id,
        ...(p.iri ? { iri: p.iri } : {}),
        label: p.name,
        texts: textsOf(model, p),
        sort: { name: p.name, iri: p.iri, relations: p.rels.length },
        facts: { domain: withOrWithout((p.domainAuto ? p.usedFrom : p.domains).length > 0), range: withOrWithout((p.rangeAuto ? p.usedTo : p.ranges).length > 0), characteristics: p.chars, inverse: flag(propLinks(model, p.id, 'inverses').length > 0) },
      })),
    dataProperty: () =>
      (oneKind ? [] : of('property')).map((t) => ({
        key: t.id,
        ...(t.iri ? { iri: t.iri } : {}),
        label: t.name || 'Unnamed',
        texts: textsOf(model, t),
        sort: { name: t.name, iri: t.iri, range: rangeLabel(model, propDatatype(t)), relations: degreeOf(t.id) },
        facts: { domain: withOrWithout(dataDomain(model, t).auto ? dataDomain(model, t).attached.length > 0 : dataDomain(model, t).axioms.length > 0), range: withOrWithout(!!t.ranges?.length), functional: flag(!!t.functional), datatype: propDatatypes(t) },
      })),
    individual: () => {
      const classes = new Set(model.terms.filter((t) => t.type === 'concept').map((t) => t.id));
      return (oneKind ? [] : of('instance')).map((t) => {
        const types = assertedSuperclasses(model, t.id).filter((c) => classes.has(c));
        return {
          key: t.id,
          ...(t.iri ? { iri: t.iri } : {}),
          label: t.name || 'Unnamed',
          texts: textsOf(model, t),
          sort: { name: t.name, iri: t.iri, type: types.map((c) => name.get(c)).join(', '), relations: degreeOf(t.id) },
          facts: { assertedType: types },
        };
      });
    },
    relationship: () => {
      // With the RDFS/OWL layer on, a relation mapped to a standard property is one of that property.
      const standard = new Map(resolveModel(model).relations.map((r) => [r.id, r.predicate]));
      return model.relations.map((r) => {
        const predicate = r.kind === 'association' ? standard.get(r.id) : undefined;
        const choice = predicate ? 'standard' : relChoice(model, r);
        const kind = predicate ? `Standard property (${predicate})` : (config.relationKinds.find((k) => k.id === choice)?.label ?? (choice === 'plain' ? 'Relationship (plain)' : choice));
        const [from, to] = [name.get(r.from) ?? '', name.get(r.to) ?? ''];
        return {
          key: r.id,
          label: r.label || kind,
          texts: [
            { field: 'name', text: r.label },
            { field: 'from', text: from },
            { field: 'to', text: to },
            { field: 'kind', text: kind },
          ],
          sort: { from, label: r.label, to, kind },
          facts: { kind: [choice], from: [r.from], to: [r.to] },
        };
      });
    },
  };
  const records = (kind: ListKind) => (made[kind] ??= makers[kind]());

  const sorts: Record<ListKind, () => EntitySortSpec[]> = {
    class: () => [
      NAME,
      IRI,
      { id: 'superclasses', label: `Asserted ${words.parent === 'superclass' ? 'superclasses' : words.parent + 's'}`, numeric: true },
      { id: 'subclasses', label: words.child === 'subclass' ? 'Subclasses' : words.child[0].toUpperCase() + words.child.slice(1) + 's', numeric: true },
      ...(restricted ? [{ id: 'restrictions', label: 'Asserted restrictions', numeric: true }] : []),
      { id: 'relations', label: 'Relationships', numeric: true },
    ],
    objectProperty: () => [NAME, IRI, { id: 'relations', label: 'Relationships that use it', numeric: true }],
    dataProperty: () => [NAME, IRI, { id: 'range', label: 'Datatype' }, { id: 'relations', label: 'Relationships', numeric: true }],
    individual: () => [NAME, IRI, { id: 'type', label: 'Type (asserted classes)' }, { id: 'relations', label: 'Relationships', numeric: true }],
    relationship: () => [
      { id: 'from', label: 'From' },
      { id: 'label', label: 'Property / label' },
      { id: 'to', label: 'To' },
      { id: 'kind', label: 'Kind' },
    ],
  };

  // What the app's own reasoner says, asked for only by what rests on it.
  const reasoning = () => reason(model);
  /** Who answers a question put to a reasoner, and how far that answer goes. */
  const credit = (dl: ReasoningResult | undefined) =>
    dl ? `${dl.engine.name}${dl.engine.version ? ' ' + dl.engine.version : ''} (OWL 2 DL)${dl.status === 'complete' ? '' : ', which did not finish over all of the ontology'}` : `${FAST_CREDIT}, which does not find everything an OWL 2 DL reasoner would`;
  /** Why nothing that rests on a reasoner can be answered, when that is so. */
  const noReasoning = (dl: ReasoningResult | undefined): string | undefined =>
    !reasoning().consistent || dl?.consistency === 'inconsistent' ? 'the reasoner finds the ontology inconsistent, and from a contradiction anything follows. See the Validation tab.' : undefined;

  const filters: Record<ListKind, (dl: ReasoningResult | undefined) => EntityFilterSpec[]> = {
    class: (dl) => {
      const all = records('class');
      const term = config.termType.concept.label.toLowerCase();
      const unavailable = reasoned ? noReasoning(dl) : undefined;
      return [
        {
          id: 'position',
          label: 'Hierarchy',
          about: `Root: a ${term} with no asserted ${words.parent}. Leaf: one with no ${words.child}. Both together: one that stands alone.`,
          type: 'all',
          options: [
            { value: 'root', label: 'Root', count: count(all, 'position', 'root') },
            { value: 'leaf', label: 'Leaf', count: count(all, 'position', 'leaf') },
          ],
        },
        { id: 'multipleInheritance', label: 'Multiple inheritance', about: `More than one asserted ${words.parent}.`, type: 'flag', options: yes(all, 'multipleInheritance') },
        ...(restricted ? [{ id: 'assertedRestrictions', label: 'Asserted restrictions', about: 'A restriction by a property, or a class expression, is stated on the class itself.', type: 'flag' as const, options: yes(all, 'assertedRestrictions') }] : []),
        ...(reasoned && restricted
          ? [{ id: 'inferredRestrictions', label: 'Inferred restrictions', about: 'A restriction is inherited from a superclass or an equivalent class the reasoner entails.', type: 'flag' as const, options: [{ value: ON, label: 'Yes' }], ...(unavailable ? { unavailable } : {}) }]
          : []),
        ...(reasoned ? [{ id: 'unsatisfiable', label: 'Unsatisfiable', about: 'The reasoner finds that the class can never have an instance.', type: 'flag' as const, options: [{ value: ON, label: 'Yes' }], ...(unavailable ? { unavailable } : {}) }] : []),
      ];
    },
    objectProperty: () => {
      const all = records('objectProperty');
      return [
        { id: 'domain', label: 'Domain', about: 'Whether the property has a domain, set by hand or following where it is used.', type: 'one', options: setOrNot(all, 'domain') },
        { id: 'range', label: 'Range', about: 'Whether the property has a range, set by hand or following where it is used.', type: 'one', options: setOrNot(all, 'range') },
        { id: 'characteristics', label: 'Characteristics', about: 'Properties that have every characteristic chosen.', type: 'all', options: CHARACTERISTICS.map((c) => ({ value: c.id, label: c.label, count: count(all, 'characteristics', c.id) })) },
        { id: 'inverse', label: 'Has an inverse', about: 'Another property is stated to be its inverse (owl:inverseOf), on either of the two.', type: 'flag', options: yes(all, 'inverse') },
      ];
    },
    dataProperty: () => {
      const all = records('dataProperty');
      const ranges = new Map<string, number>();
      for (const r of all) for (const range of r.facts.datatype) ranges.set(range, (ranges.get(range) ?? 0) + 1);
      return [
        { id: 'domain', label: 'Domain', about: 'Whether the property has a domain, set by hand or following the classes it is attached to.', type: 'one', options: setOrNot(all, 'domain') },
        { id: 'range', label: 'Range', about: 'Whether the property has a datatype as its range.', type: 'one', options: setOrNot(all, 'range') },
        { id: 'functional', label: 'Functional', about: 'Each thing has at most one value (owl:FunctionalProperty).', type: 'flag', options: yes(all, 'functional') },
        {
          id: 'datatype',
          label: 'Datatype',
          about: 'Properties whose range is any of the datatypes chosen.',
          type: 'any',
          options: [...ranges].map(([value, n]) => ({ value, label: rangeLabel(model, value), count: n })).sort((a, b) => a.label.localeCompare(b.label)),
        },
      ];
    },
    individual: (dl) => {
      const unavailable = reasoned ? noReasoning(dl) : undefined;
      return [
        { id: 'assertedType', label: 'Asserted class', about: 'Individuals stated to be an instance of any of the classes chosen (rdf:type).', type: 'any', options: [], entities: true },
        ...(reasoned
          ? [{ id: 'inferredType', label: 'Inferred class', about: 'Individuals the reasoner entails to be an instance of any of the classes chosen: stated, or following from the hierarchy, a domain or a range.', type: 'any' as const, options: [], entities: true, ...(unavailable ? { unavailable } : {}) }]
          : []),
      ];
    },
    relationship: () => {
      const all = records('relationship');
      const kinds = new Map<string, { label: string; n: number }>();
      for (const r of all) {
        const [value] = r.facts.kind;
        // Every standard property is one kind here, whichever it is.
        const label = value === 'standard' ? 'Standard property' : String(r.sort.kind);
        kinds.set(value, { label, n: (kinds.get(value)?.n ?? 0) + 1 });
      }
      return [
        { id: 'kind', label: 'Kind', about: 'Relationships of any of the kinds chosen.', type: 'any', options: [...kinds].map(([value, k]) => ({ value, label: k.label, count: k.n })) },
        { id: 'from', label: 'From', about: 'Relationships that start at any of the entities chosen.', type: 'any', options: [], entities: true },
        { id: 'to', label: 'To', about: 'Relationships that end at any of the entities chosen.', type: 'any', options: [], entities: true },
      ];
    },
  };

  // What costs a reasoner: kept for the reasoner's answer it was worked out from.
  const costlyMade = new Map<string, { dl: ReasoningResult | undefined; answer: { facts: Map<string, string[]>; note?: string } }>();
  const costlyMakers: Record<string, (dl: ReasoningResult | undefined) => { facts: Map<string, string[]>; note?: string }> = {
    'class|unsatisfiable': (dl) => {
      const found = new Set([...reasoning().unsatisfiable, ...(dl?.unsatisfiableClasses ?? [])]);
      return { facts: new Map([...found].map((id) => [id, [ON]])), note: `Unsatisfiable classes are as found by ${credit(dl)}.` };
    },
    'class|inferredRestrictions': () => {
      // As the table's column has it: what a class inherits from the classes the app's own reasoner entails it to be a kind of.
      const r = reasoning();
      const facts = new Map<string, string[]>();
      const own = new Map<string, { keys: string[]; texts: string[] }>();
      const stated = (id: string) => own.get(id) ?? own.set(id, { keys: restrictionsOf(model, id).map(restrictionKey), texts: (byId.get(id)?.classAxioms ?? []).map(expressionOf).filter((x): x is string => x !== undefined) }).get(id)!;
      for (const t of model.terms) {
        if (t.type !== 'concept') continue;
        const mine = stated(t.id);
        const inherits = r.superclasses(t.id).some((link) => {
          const theirs = stated(link.id);
          return theirs.keys.some((k) => !mine.keys.includes(k)) || theirs.texts.some((x) => !mine.texts.includes(x));
        });
        if (inherits) facts.set(t.id, [ON]);
      }
      return { facts, note: `Inferred restrictions are those inherited through what ${FAST_CREDIT} entails${r.truncated ? ', which stopped early: there may be more' : ''}.` };
    },
    'individual|inferredType': (dl) => {
      const r = reasoning();
      const facts = new Map<string, string[]>();
      for (const t of model.terms) if (t.type === 'instance') facts.set(t.id, [...new Set([...assertedSuperclasses(model, t.id), ...r.types(t.id).map((l) => l.id)])]);
      for (const x of dl?.types ?? []) {
        const have = facts.get(x.individual);
        if (have && !have.includes(x.class)) have.push(x.class);
      }
      return { facts, note: `Inferred class memberships are as entailed by ${credit(dl)}.` };
    },
  };

  const candidates: Record<string, () => Candidate[]> = {
    'individual|assertedType': () => {
      const n = new Map<string, number>();
      for (const r of records('individual')) for (const c of r.facts.assertedType) n.set(c, (n.get(c) ?? 0) + 1);
      return [...n].map(([id, k]) => candidate(model, byId.get(id)!, k));
    },
    // Any class can have instances that only follow: how many is not known until it is asked for.
    'individual|inferredType': () => model.terms.filter((t) => t.type === 'concept').map((t) => candidate(model, t)),
    'relationship|from': () => ends('from'),
    'relationship|to': () => ends('to'),
  };
  const ends = (end: 'from' | 'to') => {
    const n = new Map<string, number>();
    for (const r of model.relations) n.set(r[end], (n.get(r[end]) ?? 0) + 1);
    return [...n].filter(([id]) => byId.has(id)).map(([id, k]) => candidate(model, byId.get(id)!, k));
  };
  const candidatesMade = new Map<string, Candidate[]>();

  return {
    records,
    sorts: (kind) => sorts[kind](),
    filters: (kind, dl) => filters[kind](dl),
    costly: (kind, filter, dl) => {
      const key = `${kind}|${filter}`;
      const maker = costlyMakers[key];
      if (!maker) return undefined;
      const hit = costlyMade.get(key);
      if (hit && hit.dl === dl) return hit.answer;
      const answer = maker(dl);
      costlyMade.set(key, { dl, answer });
      return answer;
    },
    candidates: (kind, filter) => {
      const key = `${kind}|${filter}`;
      return candidatesMade.get(key) ?? candidatesMade.set(key, candidates[key]?.() ?? []).get(key)!;
    },
  };
}

const indexes = new WeakMap<Model, Index>();
/** The records of a model, made once for each revision of it: moving terms about on the canvas makes no new one. */
const indexOf = (model: Model): Index => {
  const m = stable(model);
  return indexes.get(m) ?? indexes.set(m, build(m)).get(m)!;
};

/**
 * The entity query service over the model in the editor: `current` gives that model when it is
 * asked, and the OWL 2 DL reasoner's answer about it where there is one, which what is inferred
 * then takes in beside the app's own reasoner.
 */
export function createLocalEntityService(current: () => { model: Model; docId: string | null; dl?: ReasoningResult }): EntityQueryService {
  return createRecordService(() => {
    const { model, docId, dl } = current();
    const index = indexOf(model);
    return {
      ...ontologyRef(model, docId),
      records: index.records,
      sorts: index.sorts,
      filters: (kind) => index.filters(kind, dl),
      costly: (kind, filter) => index.costly(kind, filter, dl),
      candidates: index.candidates,
    };
  });
}

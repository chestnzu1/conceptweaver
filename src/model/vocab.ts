import type { Model, Relation, TermType } from './types';

/** A predefined RDFS / OWL property that a relation can stand for. */
export interface StdProp {
  id: string;
  vocab: 'owl' | 'skos';
  /** Term types it is meant to connect; empty means anything. */
  from: TermType[];
  to: TermType[];
  /** Builds the hierarchy, like an "is a" relation. */
  hierarchical?: boolean;
  symmetric?: boolean;
  about: string;
  /** Everyday labels that usually mean this property. */
  aliases: RegExp;
}

export const STD_PROPS: StdProp[] = [
  {
    vocab: 'owl',
    id: 'rdfs:subClassOf',
    from: ['concept'],
    to: ['concept'],
    hierarchical: true,
    about: 'Everything in the first class is also in the second.',
    aliases: /^(is[- ]an?|sub[- ]?class of|(is )?(an? )?(kind|type|sort) of|speciali[sz]es)$/i,
  },
  {
    vocab: 'owl',
    id: 'rdfs:subPropertyOf',
    from: ['property'],
    to: ['property'],
    hierarchical: true,
    about: 'Whatever is related by the first property is also related by the second.',
    aliases: /^sub[- ]?property of$/i,
  },
  {
    vocab: 'owl',
    id: 'rdf:type',
    from: ['instance'],
    to: ['concept'],
    hierarchical: true,
    about: 'The individual is a member of the class.',
    aliases: /^((is )?(an? )?instance of|has type|is of type|type)$/i,
  },
  {
    vocab: 'owl',
    id: 'owl:equivalentClass',
    from: ['concept'],
    to: ['concept'],
    symmetric: true,
    about: 'Both classes have exactly the same members.',
    aliases: /^((is )?equivalent( to| class)?|same class as|equals)$/i,
  },
  {
    vocab: 'owl',
    id: 'owl:disjointWith',
    from: ['concept'],
    to: ['concept'],
    symmetric: true,
    about: 'Nothing can belong to both classes.',
    aliases: /^((is )?disjoint( with| from)?|excludes|mutually exclusive with)$/i,
  },
  {
    vocab: 'owl',
    id: 'owl:complementOf',
    from: ['concept'],
    to: ['concept'],
    symmetric: true,
    about: 'The first class is everything that is not in the second.',
    aliases: /^(is )?(the )?complement of$/i,
  },
  {
    vocab: 'owl',
    id: 'owl:equivalentProperty',
    from: ['property'],
    to: ['property'],
    symmetric: true,
    about: 'Both properties relate exactly the same things.',
    aliases: /^equivalent property$/i,
  },
  {
    vocab: 'owl',
    id: 'rdfs:domain',
    from: ['property'],
    to: ['concept'],
    about: 'Anything that has the property belongs to the class.',
    aliases: /^((has )?domain|applies to)$/i,
  },
  {
    vocab: 'owl',
    id: 'rdfs:range',
    from: ['property'],
    to: ['concept'],
    about: 'Every value of the property belongs to the class.',
    aliases: /^(has )?range$/i,
  },
  {
    vocab: 'owl',
    id: 'owl:sameAs',
    from: ['instance'],
    to: ['instance'],
    symmetric: true,
    about: 'Two names for one and the same individual.',
    aliases: /^((is )?(the )?same as|identical to)$/i,
  },
  {
    vocab: 'owl',
    id: 'owl:differentFrom',
    from: ['instance'],
    to: ['instance'],
    symmetric: true,
    about: 'The two individuals are definitely not the same.',
    aliases: /^((is )?different from|distinct from)$/i,
  },
  {
    vocab: 'owl',
    id: 'rdfs:seeAlso',
    from: [],
    to: [],
    about: 'The second resource gives more information about the first.',
    aliases: /^see also$/i,
  },
  {
    vocab: 'skos',
    id: 'skos:broader',
    from: [],
    to: [],
    hierarchical: true,
    about: 'The second concept is more general than the first.',
    aliases: /^((has )?broader( term)?|bt|is[- ]an?|(is )?(a )?(kind|type|sort|part) of)$/i,
  },
  {
    vocab: 'skos',
    id: 'skos:related',
    from: [],
    to: [],
    symmetric: true,
    about: 'The concepts are associated, without one being more general.',
    aliases: /^((is )?related( to| term)?|rt|see also)$/i,
  },
  {
    vocab: 'skos',
    id: 'skos:exactMatch',
    from: [],
    to: [],
    symmetric: true,
    about: 'Interchangeable with a concept from another scheme.',
    aliases: /^(exact ?match|(is )?(the )?same as|(is )?equivalent( to)?|equals)$/i,
  },
  {
    vocab: 'skos',
    id: 'skos:closeMatch',
    from: [],
    to: [],
    symmetric: true,
    about: 'Similar enough to a concept from another scheme to be used in its place in some applications.',
    aliases: /^(close ?match|(is )?(similar|close) to)$/i,
  },
  {
    vocab: 'skos',
    id: 'skos:broadMatch',
    from: [],
    to: [],
    about: 'A concept from another scheme that is more general.',
    aliases: /^broad(er)? ?match$/i,
  },
  {
    vocab: 'skos',
    id: 'skos:narrowMatch',
    from: [],
    to: [],
    about: 'A concept from another scheme that is more specific.',
    aliases: /^narrow(er)? ?match$/i,
  },
  {
    vocab: 'skos',
    id: 'skos:relatedMatch',
    from: [],
    to: [],
    symmetric: true,
    about: 'An associated concept from another scheme.',
    aliases: /^related ?match$/i,
  },
];

const BY_ID = new Map(STD_PROPS.map((p) => [p.id.toLowerCase(), p]));

export const stdProp = (id: string | undefined): StdProp | undefined => (id ? BY_ID.get(id.toLowerCase()) : undefined);

/** Key under which a relation label is stored in the model's label → property mapping. */
export const labelKey = (label: string) => label.trim().toLowerCase();

/** The standard properties in force for a model: SKOS ones for a concept scheme, RDFS/OWL ones when switched on. */
export function activeProps(m: Model): StdProp[] {
  if (m.mode === 'skos') return STD_PROPS.filter((p) => p.vocab === 'skos');
  return m.vocab.enabled ? STD_PROPS.filter((p) => p.vocab === 'owl') : [];
}

export const suggestFor = (m: Model, label: string): StdProp | undefined => activeProps(m).find((p) => p.aliases.test(label.trim()));

const cache = new WeakMap<Model, Model>();

/**
 * The model as it should be read: with the RDFS/OWL vocabulary on, each relation carries the
 * standard property it stands for (set on the relation itself, or through the label mapping),
 * and hierarchical properties count as "is a". With the vocabulary off, properties are ignored.
 */
export function resolveModel(m: Model): Model {
  const hit = cache.get(m);
  if (hit) return hit;
  let changed = false;
  const active = new Set(activeProps(m).map((p) => p.id));
  const relations = m.relations.map((r): Relation => {
    // A property from the vocabulary that isn't in force (OWL in a SKOS model, or the reverse) is ignored.
    let predicate = r.predicate && active.has(r.predicate) ? r.predicate : undefined;
    if (!predicate && r.kind === 'association') {
      const mapped = m.vocab.map[labelKey(r.label)];
      if (mapped && active.has(mapped)) predicate = mapped;
    }
    const kind = predicate ? (stdProp(predicate)?.hierarchical ? 'generalization' : 'association') : r.kind;
    if (predicate === r.predicate && kind === r.kind) return r;
    changed = true;
    const { predicate: _own, ...rest } = r;
    return predicate ? { ...rest, kind, predicate } : { ...rest, kind };
  });
  const out = changed ? { ...m, relations } : m;
  cache.set(m, out);
  cache.set(out, out);
  return out;
}

/** What a relation exports as when no standard property is chosen for it directly. */
export function automaticMeaning(m: Model, r: Relation): string {
  const mapped = r.kind === 'association' ? m.vocab.map[labelKey(r.label)] : undefined;
  if (mapped && activeProps(m).some((p) => p.id === mapped)) return `${mapped}, from the mapping of “${r.label.trim() || 'no label'}”`;
  if (m.mode === 'skos') {
    if (r.kind === 'generalization') return 'skos:broader';
    return r.label.trim() ? 'a relation of your own (a kind of skos:related)' : 'skos:related';
  }
  if (r.kind === 'generalization') {
    const a = m.terms.find((t) => t.id === r.from)?.type;
    const b = m.terms.find((t) => t.id === r.to)?.type;
    return a === 'instance' && b === 'concept' ? 'rdf:type' : a === 'property' && b === 'property' ? 'rdfs:subPropertyOf' : 'rdfs:subClassOf';
  }
  if (r.kind === 'property') return 'rdfs:domain (property → owner)';
  return `the object property “${r.label.trim() || 'related to'}”`;
}

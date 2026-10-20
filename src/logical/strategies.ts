import { STRATEGY_IDS, type ElementKind, type ElementType, type StrategyId } from './contracts';

/**
 * What a semantic mapping does, as a catalogue (roadmap LM-4; SYSTEM_ARCHITECTURE.md §13.7): one
 * entry per correspondence the transformation writes, with the kind of LDM element it makes and
 * the kinds of ontology source it reads. The labels are the words the transformation has always
 * recorded, so an old free-text strategy reads back as its id through `strategyForText`; an id is
 * never guessed where the words match none.
 *
 * Pure data and functions over it: the migration in ./rules.ts and the traceability services read
 * this, and nothing here reads the ontology, the store or a view.
 */

/** The kind of ontology source a strategy reads, as `sourceNow` names it. */
export type StrategySourceKind = 'class' | 'datatype' | 'data property' | 'object property';

export interface StrategyEntry {
  id: StrategyId;
  /** The words a mapping records: byte-identical to what the transformation writes. */
  label: string;
  /**
   * For a strategy whose words end in the element they are about (a restriction on a named
   * relationship): the part every such text begins with.
   */
  textPrefix?: string;
  /** The kinds of source the strategy reads; every source must be one of them. */
  sourceKinds: StrategySourceKind[];
  /** How many sources it reads; one unless it says otherwise. */
  sources?: { min?: number; max?: number };
  /** The kind of LDM element it makes. */
  target: ElementKind;
  /** Where it makes a kind with more than one element type (an entity, a reference entity), which one. */
  makes?: ElementType;
  /** What it does, for a reader choosing between strategies. */
  description: string;
}

const ONE = { min: 1, max: 1 } as const;
const MANY = { min: 2 } as const;
const ANY = { min: 1 } as const;

export const STRATEGIES: readonly StrategyEntry[] = [
  {
    id: 'OWL_CLASS_TO_LDM_ENTITY',
    label: 'class → entity',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'entity',
    description: 'One class becomes one entity, with an identity of its own.',
  },
  {
    id: 'OWL_CLASS_TO_LDM_REFERENCE_ENTITY',
    label: 'class → reference entity',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'entity',
    makes: 'reference',
    description: 'One class becomes an entity whose rows are the codes other entities point at, rather than a list held in a domain.',
  },
  {
    id: 'OWL_CLASSES_TO_LDM_ENTITY',
    label: 'two classes → one entity',
    sourceKinds: ['class'],
    sources: MANY,
    target: 'entity',
    description: 'Several classes become one entity, with a discriminator saying which kind each row is.',
  },
  {
    id: 'OWL_ENUMERATION_TO_LDM_DOMAIN',
    label: 'enumerated class → domain',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'domain',
    description: 'The members of a class defined by owl:oneOf become the values of a domain.',
  },
  {
    id: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY',
    label: 'enumerated class → reference entity',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'entity',
    makes: 'reference',
    description: 'The members of a class defined by owl:oneOf become rows of a reference entity, each with a code.',
  },
  {
    id: 'OWL_ENUMERATED_DATATYPE_TO_LDM_DOMAIN',
    label: 'enumerated datatype → domain',
    sourceKinds: ['datatype'],
    sources: ONE,
    target: 'domain',
    description: 'The literals of an enumerated datatype become the values of a domain.',
  },
  {
    id: 'OWL_HIERARCHY_ROLLUP_TO_LDM_ENTITY',
    label: 'subclass hierarchy rolled up into one entity',
    sourceKinds: ['class'],
    sources: ANY,
    target: 'entity',
    description: 'A class and its subclasses become one entity, with a discriminator saying which kind each row is.',
  },
  {
    id: 'OWL_SUBCLASS_TO_LDM_SPECIALIZATION',
    label: 'subclass hierarchy → specialization',
    sourceKinds: ['class'],
    sources: ANY,
    target: 'generalization',
    description: 'A superclass and its subclasses become entities joined by a generalization.',
  },
  {
    id: 'OWL_SUBCLASS_TO_LDM_ROLLDOWN',
    label: 'inherited attribute rolled down to the subtype',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'attribute',
    description: 'An attribute the subtype would inherit is copied into it instead.',
  },
  {
    id: 'OWL_DATA_PROPERTY_TO_LDM_ATTRIBUTE',
    label: 'data property → attribute',
    sourceKinds: ['data property'],
    sources: ONE,
    target: 'attribute',
    description: 'A datatype property becomes an attribute of the entity made from its domain.',
  },
  {
    id: 'OWL_OBJECT_PROPERTY_TO_LDM_RELATIONSHIP',
    label: 'object property → relationship',
    sourceKinds: ['object property'],
    sources: ONE,
    target: 'relationship',
    description: 'An object property becomes a relationship between the entities at its ends.',
  },
  {
    id: 'OWL_OBJECT_PROPERTY_TO_LDM_INVERSE_PAIR',
    label: 'inverse property pair → one relationship with two roles',
    sourceKinds: ['object property'],
    sources: ANY,
    target: 'relationship',
    description: 'A property and its inverse become one relationship, each direction a role.',
  },
  {
    id: 'OWL_OBJECT_PROPERTY_TO_LDM_ASSOCIATION',
    label: 'object property → associative entity (many at both ends)',
    sourceKinds: ['object property'],
    sources: ONE,
    target: 'entity',
    description: 'A many-to-many object property becomes an associative entity with identifying relationships to both ends.',
  },
  {
    id: 'OWL_OBJECT_PROPERTY_TO_LDM_DOMAIN_ATTRIBUTE',
    label: 'object property to an enumerated class → attribute typed by its domain',
    sourceKinds: ['object property'],
    sources: ONE,
    target: 'attribute',
    description: 'A reference to a member of an enumerated class becomes an attribute typed by that enumeration’s domain.',
  },
  {
    id: 'OWL_RESTRICTION_TO_LDM_MANDATORY_ATTRIBUTE',
    label: 'restriction → candidate mandatory attribute',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'attribute',
    description: 'A restriction that requires a value makes the attribute mandatory, as a candidate.',
  },
  {
    id: 'OWL_RESTRICTION_TO_LDM_RULE',
    label: 'restriction → candidate rule',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'rule',
    description: 'A restriction an attribute cannot express becomes a business rule, as a candidate.',
  },
  {
    id: 'OWL_RESTRICTION_TO_LDM_MANDATORY_END',
    label: 'restriction → candidate mandatory end',
    textPrefix: 'restriction → candidate mandatory on ',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'relationship',
    description: 'A restriction that requires a value at the other end makes that end mandatory, as a candidate.',
  },
  {
    id: 'OWL_RESTRICTION_TO_LDM_CARDINALITY_END',
    label: 'restriction → candidate cardinality end',
    textPrefix: 'restriction → candidate cardinality on ',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'relationship',
    description: 'A restriction on how many values may relate makes the other end’s cardinality, as a candidate.',
  },
  {
    id: 'OWL_HAS_KEY_TO_LDM_KEY',
    label: 'owl:hasKey → candidate key',
    sourceKinds: ['class'],
    sources: ONE,
    target: 'key',
    description: 'An owl:hasKey statement becomes a candidate key on the entity made from the class.',
  },
];

const byId = new Map<string, StrategyEntry>(STRATEGIES.map((entry) => [entry.id, entry]));

/** Whether a value is one of the catalogue's ids. */
export const isStrategyId = (v: unknown): v is StrategyId => typeof v === 'string' && (STRATEGY_IDS as readonly string[]).includes(v);

/** The catalogue entry for an id, where there is one. */
export function strategyById(id: string | undefined): StrategyEntry | undefined {
  return id === undefined ? undefined : byId.get(id);
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The strategy a recorded text states, where the catalogue has it: the dynamic labels (a
 * restriction on a named relationship) by their prefix, then the fixed labels exactly. A text the
 * catalogue does not know has no id — it is never mapped to the nearest strategy.
 */
export function strategyForText(text: string): StrategyEntry | undefined {
  const wanted = collapse(text);
  if (!wanted) return undefined;
  const dynamic = STRATEGIES.find((entry) => entry.textPrefix && wanted.startsWith(collapse(entry.textPrefix)));
  if (dynamic) return dynamic;
  return STRATEGIES.find((entry) => collapse(entry.label) === wanted);
}

/** The kind of element a strategy makes, where the id is known. */
export function expectedKindOf(id: string | undefined): ElementKind | undefined {
  return strategyById(id)?.target;
}

/**
 * The element type a strategy makes, where that is one this workspace edits: a reference entity
 * only where its catalogue entry says so; every other entity strategy makes an ordinary entity,
 * and a domain strategy a domain. Other kinds (a relationship, a rule) have no element type here.
 */
export function expectedElementTypeOf(id: string | undefined): ElementType | undefined {
  const entry = strategyById(id);
  if (!entry) return undefined;
  if (entry.makes) return entry.makes;
  if (entry.target === 'entity') return 'entity';
  if (entry.target === 'domain') return 'domain';
  return undefined;
}

/**
 * The strategy that does for another element type exactly what this one did (a plain entity and a
 * reference entity from the same class, an enumeration that was a domain and one that is a
 * reference entity), where the catalogue has one. Nothing is guessed: undefined means no strategy
 * is semantically the same, and the mapping is left for review.
 */
const COUNTERPARTS: Partial<Record<StrategyId, Partial<Record<ElementType, StrategyId>>>> = {
  OWL_CLASS_TO_LDM_ENTITY: { reference: 'OWL_CLASS_TO_LDM_REFERENCE_ENTITY' },
  OWL_CLASS_TO_LDM_REFERENCE_ENTITY: { entity: 'OWL_CLASS_TO_LDM_ENTITY' },
  OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY: { domain: 'OWL_ENUMERATION_TO_LDM_DOMAIN' },
  OWL_ENUMERATION_TO_LDM_DOMAIN: { reference: 'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY' },
};

/** The strategy a mapping follows after its element changes type, or undefined when none does the same for it. */
export function strategyForElementType(id: StrategyId, to: ElementType): StrategyId | undefined {
  if (expectedElementTypeOf(id) === to) return id;
  return COUNTERPARTS[id]?.[to];
}

/** The words a mapping records for a strategy, naming the element it is about where its text does. */
export function strategyText(entry: StrategyEntry, about?: string): string {
  return entry.textPrefix ? `${entry.textPrefix}${about ?? 'a relationship'}` : entry.label;
}

/** What a strategy would be chosen in: the sources as the ontology has them, and the element to map to. */
export interface StrategyApplicability {
  /** The kind of each source, in the order the mapping records them. */
  sourceKinds: StrategySourceKind[];
  targetKind: ElementKind;
}

const SOURCE_NAME: Record<StrategySourceKind, [string, string]> = {
  class: ['a class', 'classes'],
  datatype: ['a datatype', 'datatypes'],
  'data property': ['a data property', 'data properties'],
  'object property': ['an object property', 'object properties'],
};

const TARGET_NAME: Partial<Record<ElementKind, [string, string]>> = {
  entity: ['an entity', 'an entity'],
  attribute: ['an attribute', 'an attribute'],
  key: ['a key', 'a key'],
  relationship: ['a relationship', 'a relationship'],
  generalization: ['a generalization', 'a generalization'],
  rule: ['a business rule', 'a business rule'],
  domain: ['a domain', 'a domain'],
  mapping: ['a mapping', 'a mapping'],
  diagram: ['a diagram', 'a diagram'],
};

const sourceList = (kinds: StrategySourceKind[]): string => [...new Set(kinds)].map((k) => (kinds.length === 1 ? SOURCE_NAME[k][0] : SOURCE_NAME[k][1])).join(' and ');

/**
 * Why a strategy cannot be chosen for these sources and this element, in words, or undefined when
 * it can.
 */
export function reasonsNotApplicable(entry: StrategyEntry, what: StrategyApplicability): string | undefined {
  const target = TARGET_NAME[what.targetKind] ?? ['an element', 'an element'];
  const made = TARGET_NAME[entry.target] ?? ['an element', 'an element'];
  if (entry.target !== what.targetKind) return `It makes ${made[0]}, not ${target[0]}.`;
  const unexpected = [...new Set(what.sourceKinds.filter((k) => !entry.sourceKinds.includes(k)))];
  if (unexpected.length) return `It reads ${entry.sourceKinds.map((k) => SOURCE_NAME[k][1]).join(' and ')}; these sources are ${sourceList(unexpected)}.`;
  const count = what.sourceKinds.length;
  const min = entry.sources?.min ?? 1;
  const max = entry.sources?.max;
  if (!count) return 'The mapping has no source yet.';
  if (count < min) return min === 1 ? 'It needs a source.' : `It needs at least ${min} sources.`;
  if (max !== undefined && count > max) return max === 1 ? 'It reads one source.' : `It reads at most ${max} sources.`;
  return undefined;
}

/** Whether a strategy can be chosen for these sources and this element. */
export const isApplicable = (entry: StrategyEntry, what: StrategyApplicability): boolean => reasonsNotApplicable(entry, what) === undefined;

/**
 * The kinds an LDM element of each kind can be converted into by changing a mapping's strategy
 * (roadmap LM-4). Only these are safe as one change set; a conversion the planner cannot make
 * exactly is refused, never approximated.
 */
export const CONVERTIBLE_TARGETS: Partial<Record<ElementKind, readonly ElementKind[]>> = {
  domain: ['entity'],
  entity: ['domain'],
  relationship: ['entity'],
};

/** What an element of this kind may be converted into. */
export const convertibleFrom = (kind: ElementKind): readonly ElementKind[] => CONVERTIBLE_TARGETS[kind] ?? [];

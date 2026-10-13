import { INSTANCE_OF, type ModelMode, type TermType } from './types';

/**
 * What kind of model is being made decides what the app offers: which views, which kinds of
 * entity and of relationship, what the hierarchy means, which checks there are to run. All of
 * that is said here, once for each type of model, and read from here by the navigation, the
 * editors and the store alike. A further type of model is a further entry in MODEL_TYPES.
 */

/** The main functions of the app, as they appear in the navigation. */
export type View = 'graph' | 'table' | 'structure' | 'checks' | 'align' | 'rdf' | 'sparql' | 'vocab';
export const VIEW_LABEL: Record<View, string> = { graph: 'Graph', table: 'Entities', structure: 'Structure', checks: 'Validation', align: 'Align', rdf: 'RDF', sparql: 'SPARQL', vocab: 'Vocabulary' };

/** The sections of the Entities view. */
export type EntityTab = 'concept' | 'object' | 'property' | 'instance' | 'relations' | 'governance';

/** The columns the table of classes or concepts can have. */
export type EntityColumn = 'name' | 'iri' | 'suffix' | 'type' | 'hierarchy' | 'restrictions' | 'inferred' | 'description' | 'synonyms' | 'relations';

/** What a relationship can be made (see relChoice in props.ts for how one is told from another). */
export type RelKindId = 'plain' | 'object' | 'generalization' | 'instanceOf' | 'property';

/** The parts of the side panel's editor for a term, beyond its name, IRI and type. */
export type EditorSection = 'hierarchy' | 'axioms' | 'restrictions' | 'inferred' | 'annotations' | 'relations' | 'colour';

/** Things the app does with a model beyond letting it be drawn and listed. */
export type Feature =
  /** The reasoner: inferred types, inferred superclasses and restrictions, consistency. */
  | 'reasoning'
  /** OWL restrictions on a class by a property. */
  | 'restrictions'
  /** Declared object properties, with domain, range and characteristics. */
  | 'objectProperties'
  /** The checks of the Validation view: consistency, SHACL shapes, quality rules. */
  | 'validation'
  /** Relationships that stand for a property of a standard vocabulary (owl:equivalentClass and the like). */
  | 'standardProperties'
  /** Other ontologies: imports, reuse, mappings. */
  | 'alignment'
  /**
   * What a relationship is follows from what it joins and what it is called: two classes joined
   * by "is a" are a class and its superclass, by any other name a use of that object property;
   * a class and a data property, "has data property"; an individual and a class, a membership.
   * There are no relationships that are "just a line", and none that OWL has no meaning for.
   */
  | 'typedRelationships';

export interface ModelTypeConfig {
  id: ModelMode;
  label: string;
  /** What it is for, in a sentence, where a type is chosen. */
  about: string;
  /** The main functions on offer, in the order of the navigation. */
  views: View[];
  entityTabs: EntityTab[];
  /** What the table of classes or concepts shows of each. */
  entityColumns: EntityColumn[];
  /** The kinds of term that can be made. The first is what a new term is. */
  termTypes: TermType[];
  /** What each kind of term is called, and the RDF type it is written with. */
  termType: Record<TermType, { label: string; plural: string; rdf: string }>;
  editorSections: EditorSection[];
  /** The kinds a relationship can be given, each with what it is called here. */
  relationKinds: { id: RelKindId; label: string }[];
  /** What the hierarchy is built from, and what its ends are called. */
  hierarchy: { predicate: string; relation: string; parent: string; child: string; root: string; top: string };
  /** The properties the name and the definition of an entity are written with. */
  rdf: { label: string; definition: string };
  features: Feature[];
}

const OWL: ModelTypeConfig = {
  id: 'ontology',
  label: 'OWL ontology',
  about: 'Advanced ontology modelling with classes, properties, restrictions and reasoning.',
  views: ['graph', 'table', 'structure', 'checks', 'align', 'rdf', 'sparql', 'vocab'],
  entityTabs: ['concept', 'object', 'property', 'instance', 'relations', 'governance'],
  entityColumns: ['name', 'iri', 'hierarchy', 'restrictions', 'inferred', 'description', 'synonyms', 'relations'],
  termTypes: ['concept', 'property', 'instance'],
  termType: {
    concept: { label: 'Class', plural: 'Classes', rdf: 'owl:Class' },
    property: { label: 'Data property', plural: 'Properties', rdf: 'owl:DatatypeProperty' },
    instance: { label: 'Individual', plural: 'Individuals', rdf: 'owl:NamedIndividual' },
  },
  editorSections: ['hierarchy', 'axioms', 'restrictions', 'inferred', 'annotations', 'relations', 'colour'],
  // No plain relationship: in OWL every line between two entities says something OWL has a meaning for.
  relationKinds: [
    { id: 'object', label: 'Object property' },
    { id: 'generalization', label: 'Is a (generalization)' },
    { id: 'instanceOf', label: INSTANCE_OF },
    { id: 'property', label: 'Has data property' },
  ],
  hierarchy: { predicate: 'rdfs:subClassOf', relation: 'is a', parent: 'superclass', child: 'subclass', root: 'owl:Thing', top: 'top-level term' },
  rdf: { label: 'rdfs:label', definition: 'skos:definition' },
  features: ['reasoning', 'restrictions', 'objectProperties', 'validation', 'standardProperties', 'alignment', 'typedRelationships'],
};

const concept = { label: 'Concept', plural: 'Concepts', rdf: 'skos:Concept' };

const SKOS: ModelTypeConfig = {
  id: 'skos',
  label: 'SKOS-like vocabulary',
  about: 'Concept and taxonomy modelling with semantic relationships and governance metadata.',
  views: ['graph', 'table', 'structure'],
  entityTabs: ['concept', 'relations', 'governance'],
  // A concept is managed here by what identifies it. What is said about it is under Governance & Metadata.
  entityColumns: ['name', 'iri', 'suffix', 'type'],
  termTypes: ['concept'],
  // Everything in a vocabulary is a concept, whatever kind a term had in a model it came from.
  termType: { concept, property: concept, instance: concept },
  editorSections: [],
  relationKinds: [
    { id: 'plain', label: 'Relationship (plain)' },
    { id: 'generalization', label: 'Is a (broader)' },
  ],
  hierarchy: { predicate: 'skos:broader', relation: 'is a', parent: 'broader concept', child: 'narrower concept', root: 'Concept scheme', top: 'top concept' },
  rdf: { label: 'skos:prefLabel', definition: 'skos:definition' },
  features: [],
};

/** Every type of model the app can make, by the value a model stores as its `mode`. */
export const MODEL_TYPES: Record<ModelMode, ModelTypeConfig> = { ontology: OWL, skos: SKOS };
export const MODEL_TYPE_LIST: ModelTypeConfig[] = [OWL, SKOS];

type Typed = { mode: ModelMode };
export const configOf = (m: Typed): ModelTypeConfig => MODEL_TYPES[m.mode] ?? OWL;
export const supports = (m: Typed, feature: Feature): boolean => configOf(m).features.includes(feature);
export const allowsView = (m: Typed, view: View): boolean => configOf(m).views.includes(view);
/** The view to show: the one asked for where the type of model has it, and the graph otherwise. */
export const viewFor = (m: Typed, view: View): View => (allowsView(m, view) ? view : 'graph');
export const allowsKind = (m: Typed, kind: RelKindId): boolean => configOf(m).relationKinds.some((k) => k.id === kind);
/** The kind a term of this type of model is, when one of a kind it does not have is asked for. */
export const termTypeFor = (m: Typed, type: TermType | undefined): TermType => (type && configOf(m).termTypes.includes(type) ? type : configOf(m).termTypes[0]);

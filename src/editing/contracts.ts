/**
 * What an edit of an ontology is, and the service that makes edits.
 *
 * An edit is a change set: axioms added to and removed from one revision of an ontology, with a
 * line saying what was done. It is applied whole or not at all, and makes a new revision. This is
 * the one shape an edit has wherever it is made or applied: the editor applies its own edits as
 * change sets (local.ts), undo applies one backwards, and a backend that holds ontologies as OWL
 * API objects applies the same change set as `OWLOntologyChange`s. So that this stays possible:
 *
 *   - Entities are named by IRI and by nothing else: no id of the editor's own model is in here.
 *   - An axiom has the structure OWL 2 gives it, by OWL's structural names. What has no typed
 *     form here yet is carried as the RDF statement it is (`Unmapped`), so that nothing is lost
 *     while the typed list grows.
 *   - A change set names the revision it was made against, and is refused when the ontology has
 *     moved on from it (`stale-revision`).
 *   - Everything is plain data: no maps, sets, functions or class instances, so that a change set
 *     can travel as JSON.
 *
 * The layout of a diagram (where terms sit, how they are drawn) is not an axiom and is not in here.
 */

export type Iri = string;

/** One revision of one ontology. A revision is what the ontology says; moving terms about on a canvas does not make a new one. */
export interface OntologyRef {
  ontologyId: string;
  revisionId: string;
}

// ---------------------------------------------------------------- expressions

export interface Literal {
  value: string;
  lang?: string;
  /** The datatype's full IRI; none for plain text (xsd:string). */
  datatype?: Iri;
}

/** Part of an expression with no structure here, as the canonical Turtle it was read from (full IRIs). */
export interface Unparsed {
  type: 'Unparsed';
  turtle: string;
}

export interface ObjectProperty {
  type: 'ObjectProperty';
  iri: Iri;
}
export type ObjectPropertyExpression = ObjectProperty | { type: 'ObjectInverseOf'; property: ObjectProperty };
export interface DataProperty {
  type: 'DataProperty';
  iri: Iri;
}
export interface NamedIndividual {
  type: 'NamedIndividual';
  iri: Iri;
}

export type ClassExpression =
  | { type: 'Class'; iri: Iri }
  | { type: 'ObjectIntersectionOf' | 'ObjectUnionOf'; operands: ClassExpression[] }
  | { type: 'ObjectComplementOf'; operand: ClassExpression }
  | { type: 'ObjectOneOf'; individuals: NamedIndividual[] }
  | { type: 'ObjectSomeValuesFrom' | 'ObjectAllValuesFrom'; property: ObjectPropertyExpression; filler: ClassExpression }
  | { type: 'ObjectHasValue'; property: ObjectPropertyExpression; individual: NamedIndividual }
  | { type: 'ObjectHasSelf'; property: ObjectPropertyExpression }
  | { type: 'ObjectMinCardinality' | 'ObjectMaxCardinality' | 'ObjectExactCardinality'; n: number; property: ObjectPropertyExpression; filler?: ClassExpression }
  | { type: 'DataSomeValuesFrom' | 'DataAllValuesFrom'; property: DataProperty; filler: DataRange }
  | { type: 'DataHasValue'; property: DataProperty; value: Literal }
  | { type: 'DataMinCardinality' | 'DataMaxCardinality' | 'DataExactCardinality'; n: number; property: DataProperty; filler?: DataRange }
  | Unparsed;

export type DataRange =
  | { type: 'Datatype'; iri: Iri }
  | { type: 'DataIntersectionOf' | 'DataUnionOf'; operands: DataRange[] }
  | { type: 'DataComplementOf'; operand: DataRange }
  | { type: 'DataOneOf'; literals: Literal[] }
  | { type: 'DatatypeRestriction'; datatype: Iri; facets: { facet: Iri; value: Literal }[] }
  | Unparsed;

// ---------------------------------------------------------------- axioms

export type EntityType = 'Class' | 'ObjectProperty' | 'DataProperty' | 'AnnotationProperty' | 'NamedIndividual' | 'Datatype';

/** What an annotation says: a literal, or an IRI. */
export type AnnotationValue = Literal | { iri: Iri };

export const OBJECT_PROPERTY_CHARACTERISTICS = ['FunctionalObjectProperty', 'InverseFunctionalObjectProperty', 'ReflexiveObjectProperty', 'IrreflexiveObjectProperty', 'SymmetricObjectProperty', 'AsymmetricObjectProperty', 'TransitiveObjectProperty'] as const;
export type ObjectPropertyCharacteristic = (typeof OBJECT_PROPERTY_CHARACTERISTICS)[number];

/**
 * One axiom, by OWL 2's structural names, with full IRIs. An axiom that OWL states between two
 * things at a time in RDF (owl:disjointWith, owl:sameAs) is the pair it was stated for. Three
 * members are not axioms in OWL but changes to the ontology all the same: its IRI (`Ontology`),
 * its own annotations and its imports.
 */
export type Axiom =
  | { type: 'Declaration'; entity: EntityType; iri: Iri }
  | { type: 'SubClassOf'; sub: ClassExpression; sup: ClassExpression }
  | { type: 'EquivalentClasses' | 'DisjointClasses'; classes: ClassExpression[] }
  | { type: 'ClassAssertion'; class: ClassExpression; individual: Iri }
  | { type: 'ObjectPropertyAssertion'; property: Iri; source: Iri; target: Iri }
  | { type: 'DataPropertyAssertion'; property: Iri; source: Iri; value: Literal }
  | { type: 'SameIndividual' | 'DifferentIndividuals'; individuals: Iri[] }
  | { type: 'SubObjectPropertyOf' | 'SubDataPropertyOf' | 'SubAnnotationPropertyOf'; sub: Iri; sup: Iri }
  /** A property chain: `sup` holds wherever the chain of properties does (owl:propertyChainAxiom). */
  | { type: 'SubPropertyChainOf'; chain: ObjectPropertyExpression[]; sup: Iri }
  /** The properties that together identify a member of a class (owl:hasKey), in the order stated. */
  | { type: 'HasKey'; class: Iri; properties: (ObjectProperty | DataProperty)[] }
  /** A class is the disjoint union of its members (owl:disjointUnionOf). */
  | { type: 'DisjointUnion'; class: Iri; classes: ClassExpression[] }
  | { type: 'NegativeObjectPropertyAssertion'; property: Iri; source: Iri; target: Iri }
  | { type: 'NegativeDataPropertyAssertion'; property: Iri; source: Iri; value: Literal }
  | { type: 'EquivalentObjectProperties' | 'DisjointObjectProperties' | 'EquivalentDataProperties' | 'DisjointDataProperties'; properties: Iri[] }
  | { type: 'InverseObjectProperties'; first: Iri; second: Iri }
  | { type: 'ObjectPropertyDomain' | 'DataPropertyDomain'; property: Iri; domain: ClassExpression }
  | { type: 'ObjectPropertyRange'; property: Iri; range: ClassExpression }
  | { type: 'DataPropertyRange'; property: Iri; range: DataRange }
  | { type: ObjectPropertyCharacteristic | 'FunctionalDataProperty'; property: Iri }
  | { type: 'DatatypeDefinition'; datatype: Iri; range: DataRange }
  | { type: 'AnnotationAssertion'; property: Iri; subject: Iri; value: AnnotationValue }
  | { type: 'Ontology'; iri: Iri }
  | { type: 'OntologyAnnotation'; ontology: Iri; property: Iri; value: AnnotationValue }
  | { type: 'Import'; ontology: Iri; iri: Iri }
  /** An RDF statement with no typed form here yet, as canonical Turtle: full IRIs, blank nodes written in place. */
  | { type: 'Unmapped'; turtle: string };

// ---------------------------------------------------------------- change sets

export interface AxiomChange {
  op: 'add' | 'remove';
  axiom: Axiom;
}

export interface ChangeSet {
  ontologyId: string;
  /** The revision the change set was made against: it is applied to that revision or not at all. */
  baseRevision: string;
  /** In order. An axiom is not both added and removed by one change set. */
  changes: AxiomChange[];
  /** For the history: what was done, in words. */
  summary: string;
}

/**
 * Why a change set is refused, or one change of it.
 * invalid: it makes no sense against the revision (it removes what is not stated, or adds what
 * is). refused: an editing rule says no (a class cannot be its own superclass). unsupported: the
 * service cannot hold the result as it is.
 */
export interface Refusal {
  code: 'invalid' | 'refused' | 'unsupported';
  message: string;
}

/** Whether a change set would be applied, and anything worth knowing about it. */
export interface Verdict {
  ok: boolean;
  refusals: Refusal[];
  /** Said of a change set that is applied all the same: that it makes a hierarchy circular. */
  notes: string[];
}

/** The revision a change set made. */
export interface Applied extends OntologyRef {
  notes: string[];
}

/** What is stated about one entity: the axioms it is the subject of, and those that name it among others. */
export interface EntityAxioms extends OntologyRef {
  iri: Iri;
  axioms: Axiom[];
}

export interface CallOptions {
  /** Gives the question up: the answer is no longer wanted. */
  signal?: AbortSignal;
}

/** Edits of an ontology: applying change sets, and what they would be applied to. */
export interface OntologyEditService {
  /** Applies a change set whole, or refuses it with the reasons and changes nothing. */
  apply(changeSet: ChangeSet, options?: CallOptions): Promise<Applied>;
  /** Whether a change set would be applied, and why not. Changes nothing. */
  validate(changeSet: ChangeSet, options?: CallOptions): Promise<Verdict>;
  /** The axioms about one entity in a revision. */
  entity(query: OntologyRef & { iri: Iri }, options?: CallOptions): Promise<EntityAxioms>;
}

/**
 * stale-revision: the ontology has moved on from the revision named. not-found: there is no such
 * ontology here. refused: the change set was not applied, for the reasons given. unsupported: the
 * service cannot hold the result as it is. aborted: it was given up.
 */
export type EditErrorCode = 'stale-revision' | 'not-found' | 'refused' | 'unsupported' | 'aborted';

/** Why a change set was not applied, or a question not answered. Over a wire it is its code, its message and its refusals. */
export class EditError extends Error {
  constructor(
    readonly code: EditErrorCode,
    message: string,
    readonly refusals: Refusal[] = [],
  ) {
    super(message);
    this.name = 'EditError';
  }
}

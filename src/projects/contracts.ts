import type { Axiom } from '../editing/contracts';
import type { Model } from '../model/types';

/**
 * Projects and their versions (roadmap task 2.3, FR-M10-1 to FR-M10-3): the models kept in My
 * Models, and the named versions of each, which are only ever added to. A version is what the
 * project was when it was saved: the ontology, its shape sets, the references to its data graphs
 * and its drawing. What changed between two versions, or between one and the model as it is now,
 * is worked out over what each states, axiom by axiom (DATA_ARCHITECTURE.md §6), and told entity
 * by entity: reordering a file or moving a term on the canvas is not a change to the ontology.
 *
 * As the other services (src/reasoning, src/validation): plain data only, and refusals are typed.
 * The local service keeps it all in this browser's IndexedDB (library.ts); a server keeps the
 * same as revisions (DATA_ARCHITECTURE.md §5, `ontology_revision`, `change_entry`).
 */

/** A version of a project, without the model itself. */
export interface VersionInfo {
  id: string;
  project: string;
  /** 1, 2, 3, … for the project: "version 3". */
  seq: number;
  name: string;
  summary: string;
  created: number;
  /** A fingerprint of what the ontology, the shapes, the data graphs' references and the logical models state. */
  hash: string;
  entities: number;
}

/** One axiom added or removed, in words as the editor writes it, and as the axiom it is. */
export interface AxiomLine {
  op: 'add' | 'remove';
  text: string;
  axiom: Axiom;
}

export type EntityKind = 'class' | 'object property' | 'data property' | 'annotation property' | 'individual' | 'datatype' | 'ontology' | 'other';

/** What changed of one entity: it was added (declared), removed, or what is said of it changed. */
export interface EntityDifference {
  /** Its IRI; empty for the ontology itself and for statements about no entity. */
  iri: string;
  name: string;
  kind: EntityKind;
  status: 'added' | 'removed' | 'changed';
  changes: AxiomLine[];
  /** It was given another name: the old and the new one. Its label lines are not in `changes`. */
  renamed?: { from: string; to: string };
  /** It is under another superclass: the old one and the new one, by name. Those `SubClassOf` lines are not in `changes`. */
  moved?: { from: string; to: string };
}

export interface ShapeSetDifference {
  id: string;
  name: string;
  status: 'added' | 'removed' | 'changed';
  /** Its statements added and removed, as Turtle with prefixed names. */
  changes: { op: 'add' | 'remove'; text: string }[];
  /** Renamed, or given another purpose or namespace. */
  renamed?: string;
}

export interface DataGraphDifference {
  id: string;
  name: string;
  status: 'added' | 'removed' | 'replaced' | 'changed';
}

/** One element of a logical data model added, removed or changed, in words. */
export interface LogicalElementDifference {
  op: 'add' | 'remove' | 'update';
  /** entity, attribute, key, relationship, generalization, rule, domain, mapping; model for its name, description and purpose. */
  kind: string;
  /** What it is called, with the entity it belongs to for an attribute or a key. */
  name: string;
  /** For a change: each field that changed, before and after, in words. */
  fields?: { field: string; before: string; after: string }[];
}

/** What differs in one logical data model, element by element (roadmap LM-1, FR-M17-14). */
export interface LogicalModelDifference {
  id: string;
  name: string;
  status: 'added' | 'removed' | 'changed';
  changes: LogicalElementDifference[];
}

/** What differs between two states of a project. */
export interface Difference {
  entities: EntityDifference[];
  shapeSets: ShapeSetDifference[];
  dataGraphs: DataGraphDifference[];
  /** The logical data models, each apart from the ontology. */
  logicalModels: LogicalModelDifference[];
  /** Settings of the model that are no part of the ontology, in words: "the quality rules", "the mappings". */
  settings: string[];
  /** Where terms sit or how the graph is drawn: never a change to the ontology. */
  drawing: boolean;
  axioms: { added: number; removed: number };
}

/**
 * A state of a project to compare: one of its versions, the model in the editor now, or a model
 * saved in My Models. Two saved models are compared the same way two versions are, so that an
 * ontology can be compared with one it was aligned to or copied from.
 */
export type StateRef = { version: string } | { model: string } | 'current';

export interface ProjectService {
  /** The versions of a project, newest first. */
  versions(project: string): Promise<VersionInfo[]>;
  /** Saves the model as it is now as a new version of the project. */
  saveVersion(project: string, name: string, summary: string): Promise<VersionInfo>;
  /** The model a version holds, brought up to the current model format. */
  version(project: string, id: string): Promise<Model>;
  /** What differs from one state of the project to another. */
  diff(project: string, from: StateRef, to: StateRef): Promise<Difference>;
  /**
   * Restores a version: the project becomes what it was then, and that is saved as a new version,
   * so that nothing is ever taken out of the history (FR-M10-3). Resolves to the new version.
   */
  restore(project: string, id: string): Promise<VersionInfo>;
}

export type ProjectErrorCode = 'not-found' | 'invalid';

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

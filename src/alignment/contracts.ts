import type { Mapping, MappingIssue } from '../model/alignment';
import type { Closure, Collision, CopyResult, Entity as ModelEntity, ExternalSummary, ExtEntity } from '../model/external';
import type { Suggestion } from '../model/matcher';
import type { ExternalRef, Model } from '../model/types';

/**
 * Other ontologies as a service (roadmap task 2.9; FR-M8-1 to FR-M8-5; SYSTEM_ARCHITECTURE.md
 * §13): an ontology read from a file, a URL or another model; what the browser keeps of the
 * ontologies a model imports and of those they import in turn; entities reused or copied; and the
 * mappings and look-alikes between the model and an external ontology.
 *
 * As the other services (src/validation, src/projects): plain data only, questions by id, and
 * refusals typed. The local implementation reads the browser's cache (library.ts); a server would
 * keep the same ontologies beside the project. What the ontologies state stays theirs: nothing of
 * an external ontology is written into the model except by an explicit copy.
 */

/** An ontology in the library: the reference the model keeps, never its content. */
export type ExternalOntology = ExternalRef;

/** What one was read as, before it is added to the library. */
export interface OntologyPreview {
  summary: ExternalSummary;
  /** Entities of it whose IRI the model already defines. */
  collisions: Collision[];
}

/** What this browser keeps of the model's external ontologies, by the id of a direct reference and by `iri:<IRI>` for the ones they import. */
export interface OntologyContents {
  loaded: Record<string, Model>;
  /** Ontologies the model depends on, directly or through another, whose content is not here. */
  missing: ExternalRef[];
}

/** What the alignment service is given of the editor: the model as it is, and the content this browser keeps. */
export interface AlignmentHost {
  /** The ontology being edited, as it is now. */
  current(): Model;
  /** The Turtle this browser keeps of an ontology, by a reference's id or its ontology IRI; nothing when it keeps none. */
  cached(id: string, iri: string): Promise<string | undefined>;
}

export interface AlignmentService {
  /** Reads an ontology from Turtle and says what it is and what collides with the model. Never changes anything. */
  read(text: string, source: string, sourceKind: ExternalRef['sourceKind']): OntologyPreview;
  /**
   * Reads what this browser keeps of the ontologies the model names, and follows the ones they
   * import, as far as it goes. A direct reference whose content is not here is named, and so is an
   * import of one. `held` is content already read in this session, which is not read again.
   */
  contents(model: Model, held?: Record<string, Model>): Promise<OntologyContents>;
  /** Adds a previewed ontology to the library, as a dependency or only to browse and reuse. */
  add(preview: OntologyPreview, imports: boolean, now?: number): { model: Model; ref: ExternalRef };
  /** Takes one out of the library; refused while statements of the model still refer to its entities. */
  remove(id: string): Model;
  /** Makes one of its entities usable under its own IRI, as a reference; its definition stays where it is. */
  reuse(ref: ExternalRef, ext: Model, entity: ExtEntity): { model: Model; entity: ModelEntity; added: boolean };
  /** Copies chosen entities in with their definitions; from then on they are the model's own. */
  copy(ref: ExternalRef, ext: Model, chosen: { terms: string[]; props: string[] }): CopyResult;
  /** The model together with what it imports, transitively, as a reasoner reads it. */
  closure(model: Model, loaded: Map<string, Model>): Closure;
  /** The mappings the model states, as axioms of the model. */
  mappings(model: Model): Mapping[];
  /** What is worth a second look about them. */
  issues(model: Model, mappings?: Mapping[]): MappingIssue[];
  /** Look-alikes between the model and one external ontology, with what is already mapped or was turned down left out. */
  suggest(model: Model, external: Model, mapped?: Set<string>): Suggestion[];
}

export type AlignmentErrorCode = 'invalid' | 'in-use';

export class AlignmentError extends Error {
  constructor(
    readonly code: AlignmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AlignmentError';
  }
}

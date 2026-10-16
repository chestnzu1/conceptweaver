import type { DocumentFormat } from '../model/rdfFormats';
import type { Model } from '../model/types';

/**
 * Reading and writing ontologies as documents (roadmap task 2.5, SYSTEM_ARCHITECTURE.md §4.1):
 * which syntax a document is in, a document read into Turtle (which the app builds its model
 * from), and an ontology written in a syntax. The local implementation reads and writes the
 * syntaxes of RDF in the page and has the local OWL service, which has the OWL API, do OWL's own;
 * a server answers the same with the OWL API in process.
 */

/** The syntaxes an ontology is written in, besides the app's own JSON. */
export type Syntax = 'turtle' | 'rdfxml' | 'jsonld' | 'owlxml' | 'functional' | 'manchester';

export const SYNTAXES: { id: Syntax; label: string; extension: string; mediaType: string; service: boolean }[] = [
  { id: 'turtle', label: 'Turtle', extension: 'ttl', mediaType: 'text/turtle', service: false },
  { id: 'rdfxml', label: 'RDF/XML', extension: 'owl', mediaType: 'application/rdf+xml', service: false },
  { id: 'jsonld', label: 'JSON-LD', extension: 'jsonld', mediaType: 'application/ld+json', service: false },
  { id: 'owlxml', label: 'OWL/XML', extension: 'owx', mediaType: 'application/owl+xml', service: true },
  { id: 'functional', label: 'OWL functional syntax', extension: 'ofn', mediaType: 'text/owl-functional', service: true },
  { id: 'manchester', label: 'OWL Manchester syntax', extension: 'omn', mediaType: 'text/owl-manchester', service: true },
];

/** An ontology as a document: its text, and what it is for a file. */
export interface Written {
  text: string;
  syntax: Syntax;
  extension: string;
  mediaType: string;
}

export interface ImportExportService {
  /** Which syntax a document is in, by its start, its name and what a server said it is. */
  detect(text: string, name?: string, contentType?: string): DocumentFormat;
  /** A document in any syntax that is read, as Turtle, and which syntax it was in. */
  read(text: string, name?: string): Promise<{ turtle: string; format: DocumentFormat }>;
  /** An ontology written in a syntax. One that needs the OWL service is refused, with why, where none answers. */
  write(model: Model, syntax: Syntax): Promise<Written>;
}

/**
 * Annotation properties offered for a term's metadata: the ones Protégé lists by default,
 * plus the SKOS documentation notes and the common Dublin Core terms.
 */
export const ANNOTATION_PROPS: { id: string; about: string }[] = [
  { id: 'rdfs:comment', about: 'A general remark about the term.' },
  { id: 'rdfs:seeAlso', about: 'Where to find more about it (often a link).' },
  { id: 'rdfs:isDefinedBy', about: 'The source that defines it.' },
  { id: 'owl:versionInfo', about: 'Version of this term.' },
  { id: 'owl:deprecated', about: 'true when the term should no longer be used.' },
  { id: 'owl:priorVersion', about: 'The version this one replaces.' },
  { id: 'owl:backwardCompatibleWith', about: 'An earlier version it stays compatible with.' },
  { id: 'owl:incompatibleWith', about: 'An earlier version it breaks with.' },
  { id: 'skos:prefLabel', about: 'The preferred name, e.g. in another language.' },
  { id: 'skos:altLabel', about: 'Another name, e.g. a synonym in another language.' },
  { id: 'skos:hiddenLabel', about: 'A name to search by but not to show, e.g. a common misspelling.' },
  { id: 'skos:notation', about: 'A code that identifies the concept, e.g. a classification number.' },
  { id: 'skos:definition', about: 'A definition, e.g. in another language.' },
  { id: 'skos:example', about: 'An example of the term in use.' },
  { id: 'skos:note', about: 'A general note.' },
  { id: 'skos:scopeNote', about: 'What the term does and does not cover.' },
  { id: 'skos:editorialNote', about: 'A note for the people maintaining the model.' },
  { id: 'skos:historyNote', about: 'How the meaning has changed over time.' },
  { id: 'skos:changeNote', about: 'What was changed, and when.' },
  { id: 'skos:exactMatch', about: 'Link to the same concept in another vocabulary.' },
  { id: 'skos:closeMatch', about: 'Link to a similar concept in another vocabulary.' },
  { id: 'skos:broadMatch', about: 'Link to a more general concept in another vocabulary.' },
  { id: 'skos:narrowMatch', about: 'Link to a more specific concept in another vocabulary.' },
  { id: 'skos:relatedMatch', about: 'Link to an associated concept in another vocabulary.' },
  { id: 'dcterms:creator', about: 'Who created it.' },
  { id: 'dcterms:contributor', about: 'Who else worked on it.' },
  { id: 'dcterms:created', about: 'Date it was created.' },
  { id: 'dcterms:modified', about: 'Date it was last changed.' },
  { id: 'dcterms:source', about: 'What it was derived from.' },
];

const KNOWN = new Map(ANNOTATION_PROPS.map((p) => [p.id.toLowerCase(), p.id]));
const CURIE = /^(rdfs|owl|skos|dcterms):[A-Za-z][\w-]*$/;

/**
 * The standard property a field name stands for, if any: one of the listed ones (matched
 * without regard to case) or any other name in the rdfs, owl, skos or dcterms vocabularies.
 */
export function standardAnnotation(key: string): string | undefined {
  const k = key.trim();
  return KNOWN.get(k.toLowerCase()) ?? (CURIE.test(k) ? k : undefined);
}

export const annotationAbout = (key: string) => ANNOTATION_PROPS.find((p) => p.id === standardAnnotation(key))?.about;

import { loadOxigraph, type OxQuad } from './oxigraph';
import { STANDARD } from './prefixes';

/**
 * Reading an ontology in whichever syntax it comes. The app builds its model from Turtle
 * (rdf.ts); everything else is first made Turtle here, so that an ontology opened from a file,
 * added for reuse or fetched from a URL is read in one way, whatever it was written in.
 *
 *   Turtle, N-Triples, N-Quads, TriG   read as they are.
 *   RDF/XML (most .owl files), JSON-LD parsed in the browser by the RDF engine the app already
 *                                      has for SPARQL, fetched when first needed.
 *   OWL/XML, functional syntax,        not RDF: converted by the local OWL service (the one that
 *   Manchester syntax, OBO             runs the OWL 2 DL reasoner), which has the OWL API. Without
 *                                      it they are refused, saying how to start it or what to
 *                                      save the ontology as instead.
 *
 * Nothing is fetched while reading: an import is recorded by its IRI, as it is for Turtle.
 */

export type DocumentFormat = 'model' | 'turtle' | 'rdfxml' | 'jsonld' | 'owlxml' | 'functional' | 'manchester' | 'obo';

export const FORMAT_LABEL: Record<DocumentFormat, string> = {
  model: 'ConceptWeaver JSON',
  turtle: 'Turtle',
  rdfxml: 'RDF/XML',
  jsonld: 'JSON-LD',
  owlxml: 'OWL/XML',
  functional: 'OWL functional syntax',
  manchester: 'OWL Manchester syntax',
  obo: 'OBO format',
};

/** What a file dialog offers: the model's own format, and every syntax of RDF and OWL that is read. */
export const ONTOLOGY_FILES = '.owl,.rdf,.xml,.ttl,.turtle,.nt,.nq,.n3,.trig,.jsonld,.owx,.ofn,.omn,.obo,text/turtle,application/rdf+xml,application/ld+json';
export const MODEL_FILES = '.json,application/json,' + ONTOLOGY_FILES;
/**
 * What a server is asked for, in order of preference. It is kept under 128 bytes: a longer
 * Accept is no longer one of the headers a browser sends to another site unasked, and the
 * question it then puts first (a preflight) is one most servers of ontologies do not answer.
 */
export const ACCEPT = 'text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, application/n-triples;q=0.8, */*;q=0.1';

const OWL = 'http://www.w3.org/2002/07/owl#';
/** The syntaxes that are OWL's own and no serialisation of RDF: the browser cannot read them itself. */
const NEEDS_SERVICE: DocumentFormat[] = ['owlxml', 'functional', 'manchester', 'obo'];

const BY_EXTENSION: Record<string, DocumentFormat> = { owx: 'owlxml', ofn: 'functional', omn: 'manchester', obo: 'obo', jsonld: 'jsonld', ttl: 'turtle', turtle: 'turtle', nt: 'turtle', nq: 'turtle', n3: 'turtle', trig: 'turtle' };
const BY_TYPE: [RegExp, DocumentFormat][] = [
  [/rdf\+xml/, 'rdfxml'],
  [/owl\+xml/, 'owlxml'],
  [/ld\+json/, 'jsonld'],
  [/owl-functional/, 'functional'],
  [/owl-manchester/, 'manchester'],
  [/turtle|n-triples|n-quads|trig|n3/, 'turtle'],
];

// ---------------------------------------------------------------- from bytes to text

/**
 * The text of a document, read in the encoding it says it is in. Nearly every ontology is UTF-8,
 * but an XML file may declare another (ISO-8859-1, in older ones) or begin with the mark of
 * UTF-16; read as UTF-8, every letter outside ASCII in its labels would come out wrong.
 */
export function decodeDocument(bytes: Uint8Array, charset = ''): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  // The declaration is in ASCII whatever the encoding it names.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 300));
  const declared = /^(?:\xEF\xBB\xBF)?\s*<\?xml[^>]*?\sencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] ?? charset;
  try {
    return new TextDecoder(declared || 'utf-8').decode(bytes);
  } catch {
    // An encoding nobody has heard of: UTF-8 is the likeliest.
    return new TextDecoder().decode(bytes);
  }
}

/** The text of a file that was opened or dropped. */
export const fileText = async (file: Blob): Promise<string> => decodeDocument(new Uint8Array(await file.arrayBuffer()));

// ---------------------------------------------------------------- telling the syntaxes apart

/** The start of an XML document after its declaration, comments and document type: where its root element begins. */
function xmlBody(text: string): { body: string; doctype: string } {
  let at = 0;
  let doctype = '';
  for (;;) {
    while (/\s/.test(text[at] ?? '')) at++;
    // Where what starts here ends: the last character of its closing mark, or -1 where it is never closed.
    const closes = (mark: string, from = at) => {
      const found = text.indexOf(mark, from);
      return found < 0 ? -1 : found + mark.length - 1;
    };
    let end: number;
    if (text.startsWith('<?', at)) end = closes('?>');
    else if (text.startsWith('<!--', at)) end = closes('-->');
    else if (text.startsWith('<!DOCTYPE', at)) {
      // With an internal subset the declaration ends after its closing bracket.
      const open = text.indexOf('[', at);
      const close = closes('>');
      const inner = open >= 0 && open < close ? text.indexOf(']', open) : -1;
      end = open >= 0 && open < close ? (inner < 0 ? -1 : closes('>', inner)) : close;
      if (end >= 0) doctype = text.slice(at, end + 1);
    } else break;
    // A declaration or a comment that is never closed: there is no root to find.
    if (end < 0) return { body: '', doctype };
    at = end + 1;
  }
  return { body: text.slice(at), doctype };
}

/** The opening tag of an element at the start of a text: its name and its attributes, with the entities of the document resolved. */
function openingTag(body: string, doctype: string): { name: string; attributes: Map<string, string> } | undefined {
  const name = /^<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(body)?.[1];
  if (!name) return undefined;
  // To the end of the tag, which is the first > outside a quoted value.
  let end = name.length + 1;
  for (let quote = ''; end < body.length; end++) {
    const c = body[end];
    if (quote) quote = c === quote ? '' : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') break;
  }
  const entities = new Map<string, string>([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
  ]);
  for (const m of doctype.matchAll(/<!ENTITY\s+([\w.-]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g)) entities.set(m[1], m[2] ?? m[3] ?? '');
  const resolve = (v: string) => v.replace(/&([\w.-]+);/g, (whole, n: string) => entities.get(n) ?? whole);
  const attributes = new Map<string, string>();
  for (const m of body.slice(name.length + 1, end).matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes.set(m[1], resolve(m[2] ?? m[3] ?? ''));
  return { name, attributes };
}

/** Whether an XML document ends where its root element does: with that element's closing tag, or as one empty element, comments aside. */
function endsClosed(text: string, root: string): boolean {
  let rest = text.trimEnd();
  for (;;) {
    const open = rest.endsWith('-->') ? rest.lastIndexOf('<!--') : rest.endsWith('?>') && !rest.startsWith('<?xml', rest.lastIndexOf('<?')) ? rest.lastIndexOf('<?') : -1;
    if (open < 0) break;
    rest = rest.slice(0, open).trimEnd();
  }
  if (new RegExp(`</${root.replace(/[.]/g, '\\.')}\\s*>$`).test(rest)) return true;
  // A root with nothing in it is closed where it opens.
  return rest.endsWith('/>') && rest.lastIndexOf('<' + root) === rest.search(new RegExp(`<${root.replace(/[.]/g, '\\.')}[\\s/>]`)) && !/<\/|>\s*</.test(rest.slice(rest.lastIndexOf('<' + root)));
}

/**
 * Which syntax a document is in, by what it starts with; what it is called and what a server
 * said it is only settle what its content leaves open. Whatever is none of the others is taken
 * for Turtle, whose reader then says what is wrong with it.
 */
export function detectFormat(text: string, fileName = '', contentType = ''): DocumentFormat {
  const head = text.replace(/^﻿/, '').trimStart();
  const hinted = BY_EXTENSION[/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? ''] ?? BY_TYPE.find(([type]) => type.test(contentType.toLowerCase()))?.[1];
  if (head.startsWith('{') || head.startsWith('[')) {
    // The app's own files are JSON too; JSON-LD is known by its keywords.
    return hinted === 'jsonld' || /"@(context|graph|id|type)"\s*:/.test(head.slice(0, 20_000)) ? 'jsonld' : 'model';
  }
  // A Turtle file can begin with an IRI in angle brackets; an XML one begins with a declaration, a comment, or an element that declares a namespace.
  const xml = head.startsWith('<?xml') || head.startsWith('<!DOCTYPE') || head.startsWith('<!--') || /^<[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?\s[^>]*\bxmlns\b/.test(head);
  if (xml && hinted !== 'turtle') {
    const { body, doctype } = xmlBody(head);
    const root = openingTag(body, doctype);
    const local = root?.name.split(':').pop();
    const prefix = root?.name.includes(':') ? root.name.split(':')[0] : '';
    const namespace = root?.attributes.get(prefix ? 'xmlns:' + prefix : 'xmlns');
    // OWL/XML has an Ontology element of OWL's namespace at its root, with the ontology's IRI as an attribute and axioms as children.
    if (local === 'Ontology' && namespace === OWL && (root!.attributes.has('ontologyIRI') || /<(Declaration|Prefix|SubClassOf|ClassAssertion|Import|AnnotationAssertion)[\s>]/.test(body.slice(0, 50_000)))) return 'owlxml';
    return hinted === 'owlxml' ? 'owlxml' : 'rdfxml';
  }
  const start = head.replace(/^(\s*#[^\n]*\n)+/, '').trimStart();
  if (/^(Prefix|Ontology)\s*\(/.test(start)) return 'functional';
  if (/^(Prefix|Namespace|Ontology|Import):/.test(start)) return 'manchester';
  if (/^format-version\s*:/.test(start)) return 'obo';
  return hinted && hinted !== 'jsonld' && hinted !== 'rdfxml' ? hinted : 'turtle';
}

// ---------------------------------------------------------------- making Turtle of it

export interface DocumentSource {
  /** What it is called: the name of the file, or the address it was fetched from. */
  name?: string;
  /** What the server said it is. */
  contentType?: string;
  /** Where it was fetched from: what its relative IRIs are relative to, unless it says otherwise. */
  url?: string;
  /** Where the local OWL service is, for the syntaxes that are not RDF. */
  serviceUrl?: string;
  fetch?: typeof fetch;
}

export const DEFAULT_SERVICE_URL = 'http://localhost:5190';

const PREFIX_NAME = /^[A-Za-z][\w-]*$/;
const usable = (iri: string) => /^[a-z][a-z0-9+.-]*:[^\s<>"{}|^`\\]*$/i.test(iri);

/** The prefixes of a document as the head of a Turtle file, so that they are kept as its author's abbreviations. */
function prefixLines(prefixes: Iterable<[string, string]>): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [prefix, iri] of prefixes) {
    if (seen.has(prefix) || !usable(iri) || (prefix && !PREFIX_NAME.test(prefix)) || prefix === 'xml' || prefix === 'xmlns') continue;
    // A standard vocabulary as the default namespace (OWL itself, in some RDF/XML) is not the ontology's namespace.
    if (!prefix && STANDARD.some((p) => p.iri === iri)) continue;
    seen.add(prefix);
    lines.push(`@prefix ${prefix}: <${iri}> .`);
  }
  return lines.length ? lines.join('\n') + '\n\n' : '';
}

/** A name for an ontology that gives none, to resolve its relative IRIs against. */
const fallbackBase = (source: DocumentSource) => source.url ?? `http://example.org/${(source.name ?? 'ontology').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'ontology'}`;

/**
 * RDF/XML with its attribute values as an XML parser gives them (XML 1.0, 3.3.3): a line break or
 * a tab written in an attribute value is a space there. A literal given as an attribute
 * (rdfs:comment="…") is read so by every other RDF/XML reader, the OWL API among them; the
 * engine here leaves the line breaks in. A character reference (&#10;) is left as it is, as it
 * should be. Comments, CDATA sections, processing instructions and the document type are not
 * touched.
 */
export function attributesNormalized(xml: string): string {
  let out = '';
  let i = 0;
  const skip = (open: string, close: string) => {
    if (!xml.startsWith(open, i)) return false;
    const end = xml.indexOf(close, i + open.length);
    const to = end < 0 ? xml.length : end + close.length;
    out += xml.slice(i, to);
    i = to;
    return true;
  };
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      out += xml.slice(i);
      break;
    }
    out += xml.slice(i, lt);
    i = lt;
    if (skip('<!--', '-->') || skip('<![CDATA[', ']]>') || skip('<?', '?>')) continue;
    if (xml.startsWith('<!', i)) {
      // A document type declaration, with its internal subset if it has one.
      const bracket = xml.indexOf('[', i);
      const close = xml.indexOf('>', i);
      if (bracket >= 0 && bracket < close) skip('<!', ']>');
      else skip('<!', '>');
      continue;
    }
    // A tag: whitespace in a quoted value is a space, a line break written as CR LF one space.
    let quote = '';
    for (; i < xml.length; i++) {
      const c = xml[i];
      if (quote) {
        if (c === quote) quote = '';
        else if (c === '\r' && xml[i + 1] === '\n') continue;
        else if (c === '\n' || c === '\r' || c === '\t') {
          out += ' ';
          continue;
        }
      } else if (c === '"' || c === "'") quote = c;
      out += c;
      if (!quote && c === '>') {
        i++;
        break;
      }
    }
  }
  return out;
}

async function rdfToTurtle(text: string, format: 'rdfxml' | 'jsonld', source: DocumentSource): Promise<string> {
  const prefixes: [string, string][] = [];
  let base = fallbackBase(source);
  if (format === 'rdfxml') {
    const { body, doctype } = xmlBody(text.replace(/^﻿/, ''));
    const root = openingTag(body, doctype);
    for (const [name, value] of root?.attributes ?? []) {
      if (name === 'xmlns') prefixes.push(['', value]);
      else if (name.startsWith('xmlns:')) prefixes.push([name.slice(6), value]);
    }
    // The parser reads as far as the file goes and is content with that: a file cut short (a download that broke off)
    // would be opened as a smaller ontology and nobody told. So the end of the file has to be the end of its root element.
    if (root && !endsClosed(text, root.name)) throw new Error(`It is not well-formed RDF/XML: the file ends before its root element <${root.name}> is closed, so the end of it is missing.`);
    // The default namespace is how the file abbreviates its own entities; where there is none, its base with a # is.
    const stated = root?.attributes.get('xml:base');
    if (stated && !prefixes.some(([p]) => !p) && usable(stated)) prefixes.push(['', /[#/]$/.test(stated) ? stated : stated + '#']);
  } else {
    let context: unknown;
    try {
      const json = JSON.parse(text) as { '@context'?: unknown } | { '@context'?: unknown }[];
      context = Array.isArray(json) ? json.map((x) => x?.['@context']) : json['@context'];
    } catch (e) {
      throw new Error(`It is not well-formed JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const part of (Array.isArray(context) ? context.flat() : [context]) as unknown[]) {
      if (typeof part === 'string') throw new Error(`It takes its context from ${part}, which is not fetched. Put the context into the file, or save the ontology as Turtle or RDF/XML.`);
      if (!part || typeof part !== 'object') continue;
      for (const [key, value] of Object.entries(part as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        if (key === '@vocab') prefixes.push(['', value]);
        else if (key === '@base') base = value;
        else if (!key.startsWith('@') && /[#/:]$/.test(value)) prefixes.push([key, value]);
      }
    }
  }
  const ox = await loadOxigraph();
  let quads: OxQuad[];
  // By now the document is text, whatever it was encoded in; its declaration is made to say so, for an engine that reads UTF-8 only.
  const document = format === 'rdfxml' ? attributesNormalized(text.replace(/^(\uFEFF?\s*<\?xml[^>]*?\sencoding\s*=\s*)(["'])[^"']*\2/i, '$1$2UTF-8$2')) : text;
  try {
    // Parsed and no more: a store would put the statements in an order of its own and rewrite numbers (9.50 as 9.5).
    quads = ox.parse(document, { format: format === 'rdfxml' ? 'application/rdf+xml' : 'application/ld+json', base_iri: base });
  } catch (e) {
    throw new Error(`It is not well-formed ${FORMAT_LABEL[format]}: ${(e instanceof Error ? e.message : String(e)).replace(/^(syntax |parsing )?error:?\s*/i, '')}`);
  }
  // Each statement on a line of its own is N-Triples, which is Turtle; a named graph of JSON-LD is read as part of the one ontology.
  const lines: string[] = [];
  for (const q of quads) lines.push(`${q.subject.toString()} ${q.predicate.toString()} ${q.object.toString()} .`);
  return prefixLines(prefixes) + lines.join('\n') + '\n';
}

/** Why the local OWL service is needed, and what to do without it. */
const serviceHint = (format: DocumentFormat, base: string) =>
  `It is in ${FORMAT_LABEL[format]}, which is not RDF: the app reads it through its local OWL service, and none answers at ${base}. Start it with “pnpm reasoner” and open the file again, or save the ontology as RDF/XML or Turtle (in Protégé: File → Save as…) and open that.`;

/** Has the local OWL service, which has the OWL API, turn a document of any OWL syntax into Turtle. It reads the document and nothing else: no import is fetched. */
export async function convertWithService(text: string, format: DocumentFormat, source: DocumentSource = {}): Promise<string> {
  const base = (source.serviceUrl ?? DEFAULT_SERVICE_URL).replace(/\/+$/, '');
  let response: Response;
  try {
    // Sent as text so that the browser does not first have to ask whether it may: the service reads JSON either way.
    response = await (source.fetch ?? fetch)(base + '/convert', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ document: text, name: source.name ?? '' }) });
  } catch {
    throw new Error(serviceHint(format, base));
  }
  let answer: { turtle?: unknown; errors?: unknown } | undefined;
  try {
    answer = (await response.json()) as typeof answer;
  } catch {
    answer = undefined;
  }
  if (response.status === 404) throw new Error(`The OWL service at ${base} is an older one that cannot convert files. Stop it and start it again with “pnpm reasoner”.`);
  if (!answer || typeof answer !== 'object') throw new Error(`What answered at ${base} is not the OWL service (HTTP ${response.status}).`);
  if (typeof answer.turtle !== 'string' || !response.ok) throw new Error(Array.isArray(answer.errors) && answer.errors.length ? String(answer.errors[0]) : `The OWL service could not read it as ${FORMAT_LABEL[format]}.`);
  return answer.turtle;
}

/**
 * A document as Turtle, whatever syntax of RDF or OWL it is in, and which syntax that was. The
 * app's own JSON is not an RDF document and is refused here; whoever opens a model reads it
 * before asking (see readModelFile in files.ts).
 */
export async function asTurtle(text: string, source: DocumentSource = {}): Promise<{ turtle: string; format: DocumentFormat }> {
  const format = detectFormat(text, source.name, source.contentType);
  if (format === 'model') throw new Error('It is a ConceptWeaver model (JSON), not an ontology in RDF. Open it with File → Open a file.');
  if (format === 'turtle') return { turtle: text, format };
  if (format === 'rdfxml' || format === 'jsonld') return { turtle: await rdfToTurtle(text, format, source), format };
  if (NEEDS_SERVICE.includes(format)) return { turtle: await convertWithService(text, format, source), format };
  return { turtle: text, format };
}

/**
 * Fetches an ontology from an address, asking for the syntaxes that are read. A browser does not
 * say why a request failed, so the usual reasons are given.
 */
export async function fetchDocument(url: string, ask: typeof fetch = fetch): Promise<{ text: string; contentType: string }> {
  const address = url.trim();
  if (!/^https?:\/\//i.test(address)) throw new Error('An address starts with http:// or https://.');
  let response: Response;
  try {
    response = await ask(address, { headers: { Accept: ACCEPT } });
  } catch {
    throw new Error(`${address} could not be fetched from the browser. The server may not allow requests from other sites (CORS), or it may be unreachable. Download the ontology and open it as a file instead.`);
  }
  if (!response.ok) throw new Error(`The server answered ${response.status} ${response.statusText}.`.replace(/ \.$/, '.'));
  const contentType = response.headers.get('content-type') ?? '';
  return { text: decodeDocument(new Uint8Array(await response.arrayBuffer()), /charset=([\w.:-]+)/i.exec(contentType)?.[1]), contentType };
}

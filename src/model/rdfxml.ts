import { Parser } from 'n3';

/**
 * RDF/XML (roadmap task 2.5, FR-M11-2), written in the page: what Protégé saves by default and
 * what many tools expect. It is written from the Turtle the app writes, statement for statement
 * and in its order, with every literal exactly as it is there (an engine's store would rewrite
 * "9.50" as 9.5), with the Turtle's prefixes as XML namespaces. Each subject is an
 * rdf:Description, a blank node one by rdf:nodeID: plain, and read alike by every RDF/XML reader.
 */

interface Term {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const LANG_STRING = RDF + 'langString';
/** A name XML allows after a namespace prefix. */
const NCNAME = /^[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00b7\u203f\u2040]*$/u;

const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const attribute = (s: string) => text(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

/** The Turtle the app writes, as RDF/XML. A property whose IRI ends in nothing XML can name is refused, with why. */
export function rdfXmlOf(turtle: string): string {
  const prefixes: [string, string][] = [];
  const quads = new Parser().parse(turtle, null, (p: string, ns: { value: string }) => prefixes.push([p, ns.value])) as unknown as { subject: Term; predicate: Term; object: Term }[];

  // The namespaces: the Turtle's own, then one for each property no prefix of it can name.
  const spaces = new Map<string, string>([['rdf', RDF]]);
  for (const [p, ns] of prefixes) if (p !== 'rdf' && ![...spaces.values()].includes(ns)) spaces.set(p, ns);
  let made = 0;
  const qname = (iri: string): string => {
    let best: [string, string] | undefined;
    for (const [p, ns] of spaces) if (iri.startsWith(ns) && NCNAME.test(iri.slice(ns.length)) && (!best || ns.length > best[1].length)) best = [p, ns];
    if (!best) {
      // Cut where the longest end of the IRI that XML can name begins.
      let cut = -1;
      for (let i = iri.length - 1; i > 0; i--) if (NCNAME.test(iri.slice(i))) cut = i;
      if (cut < 0) throw new Error(`The property <${iri}> cannot be written as RDF/XML: its IRI does not end in a name XML allows. Export as Turtle instead.`);
      let p = `ns${++made}`;
      while (spaces.has(p)) p = `ns${++made}`;
      spaces.set(p, iri.slice(0, cut));
      best = [p, iri.slice(0, cut)];
    }
    return best[0] ? `${best[0]}:${iri.slice(best[1].length)}` : iri.slice(best[1].length);
  };
  const node = (t: Term) => (t.termType === 'BlankNode' ? `rdf:nodeID="${attribute(nodeId(t.value))}"` : `rdf:about="${attribute(t.value)}"`);

  const subjects = new Map<string, { subject: Term; lines: string[] }>();
  for (const q of quads) {
    const key = (q.subject.termType === 'BlankNode' ? '_:' : '') + q.subject.value;
    const at = subjects.get(key) ?? subjects.set(key, { subject: q.subject, lines: [] }).get(key)!;
    const name = qname(q.predicate.value);
    const o = q.object;
    if (o.termType === 'NamedNode') at.lines.push(`<${name} rdf:resource="${attribute(o.value)}"/>`);
    else if (o.termType === 'BlankNode') at.lines.push(`<${name} rdf:nodeID="${attribute(nodeId(o.value))}"/>`);
    else {
      const dt = o.datatype?.value;
      const typed = o.language ? ` xml:lang="${attribute(o.language)}"` : dt && dt !== XSD_STRING && dt !== LANG_STRING ? ` rdf:datatype="${attribute(dt)}"` : '';
      at.lines.push(`<${name}${typed}>${text(o.value)}</${name}>`);
    }
  }
  const head = [...spaces].map(([p, ns]) => `${p ? `xmlns:${p}` : 'xmlns'}="${attribute(ns)}"`).join('\n         ');
  const body = [...subjects.values()].map((s) => `  <rdf:Description ${node(s.subject)}>\n${s.lines.map((l) => `    ${l}`).join('\n')}\n  </rdf:Description>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rdf:RDF ${head}>\n${body}\n</rdf:RDF>\n`;
}

/** A blank node's label as a name XML allows. */
const nodeId = (label: string) => (NCNAME.test(label) ? label : 'b' + label.replace(/[^\p{L}\p{N}_.-]/gu, '_'));

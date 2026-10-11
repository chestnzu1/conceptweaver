import { Parser, Writer } from 'n3';
import { baseIriOf, localName } from './iri';
import { allPrefixes, compactIri, isAbsoluteIri } from './prefixes';
import { NODE_KINDS, uid, type Model, type PropertyShape, type ShaclSeverity, type ShapeDef, type Shapes, type ShapeValue } from './types';

/**
 * The model's SHACL shapes: writing them as Turtle, and reading shapes from Turtle.
 *
 * Shapes are their own graph. They never go into the ontology's export, and nothing here turns
 * an OWL restriction into a shape or the other way round: a restriction says what follows about
 * a class's members, a shape says what data must contain to be accepted.
 */

export const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** What of SHACL Core the shape editor has fields for. Anything else is kept as Turtle and still validated. */
export const EDITOR_FEATURES = {
  targets: ['sh:targetClass', 'sh:targetNode', 'sh:targetSubjectsOf', 'sh:targetObjectsOf'],
  paths: ['a property', 'sh:inversePath of a property'],
  constraints: ['sh:minCount', 'sh:maxCount', 'sh:datatype', 'sh:class', 'sh:nodeKind', 'sh:pattern', 'sh:flags', 'sh:in', 'sh:hasValue', 'sh:minInclusive', 'sh:maxInclusive', 'sh:minExclusive', 'sh:maxExclusive', 'sh:minLength', 'sh:maxLength', 'sh:uniqueLang', 'sh:languageIn', 'sh:node', 'sh:closed'],
  other: ['sh:severity', 'sh:message', 'sh:name', 'sh:deactivated'],
};

// ---------------------------------------------------------------- new shapes

/** A new, empty node shape with an IRI of its own in the model's namespace. */
export function newShape(model: Model, name = 'New shape', targetClass?: string): ShapeDef {
  const base = baseIriOf(model);
  const taken = new Set([...model.shapes.nodes.map((s) => s.iri), ...model.terms.map((t) => t.iri), ...model.props.map((p) => p.iri)].filter(Boolean).map((x) => x!.toLowerCase()));
  const local = localName(name, false).replace(/Shape$/i, '') + 'Shape';
  let iri = base + local;
  for (let i = 2; taken.has(iri.toLowerCase()); i++) iri = `${base}${local}_${i}`;
  return { id: uid(), iri, name, targetClass: targetClass ? [targetClass] : [], targetNode: [], targetSubjectsOf: [], targetObjectsOf: [], properties: [] };
}

export const newPropertyShape = (path = ''): PropertyShape => ({ id: uid(), path });

// ---------------------------------------------------------------- to Turtle

const dtIri = (dt: string) => (dt.startsWith('xsd:') ? XSD + dt.slice(4) : dt.startsWith('rdf:') ? RDF + dt.slice(4) : dt);
/** A datatype the way the editor holds it: prefixed for the XML Schema ones, otherwise in full. */
export const dtShort = (iri: string) => (iri.startsWith(XSD) ? 'xsd:' + iri.slice(XSD.length) : iri === RDF + 'langString' ? 'rdf:langString' : iri);

/** The shapes graph as Turtle: the shapes of the editor, then whatever is kept as text. */
export function shapesToTurtle(model: Model, shapes: Shapes = model.shapes): string {
  const used = new Map<string, string>([['sh', SH]]);
  const iri = (x: string) => {
    if (x.startsWith(XSD)) {
      used.set('xsd', XSD);
      return 'xsd:' + x.slice(XSD.length);
    }
    const curie = compactIri(model, x);
    if (!curie) return `<${x}>`;
    const prefix = curie.slice(0, curie.indexOf(':'));
    used.set(prefix, allPrefixes(model).find((p) => p.prefix === prefix)!.iri);
    return curie;
  };
  const lit = (v: ShapeValue): string => {
    if (v.iri) return iri(v.v);
    if (v.lang) return `${JSON.stringify(v.v)}@${v.lang}`;
    if (v.dt && v.dt !== 'xsd:string') return `${JSON.stringify(v.v)}^^${iri(dtIri(v.dt))}`;
    return JSON.stringify(v.v);
  };
  const blocks: string[] = [];
  for (const s of shapes.nodes) {
    const lines: string[] = ['a sh:NodeShape'];
    if (s.name.trim()) {
      used.set('rdfs', RDFS);
      lines.push(`rdfs:label ${JSON.stringify(s.name.trim())}`);
    }
    for (const [pred, list] of [['sh:targetClass', s.targetClass], ['sh:targetNode', s.targetNode], ['sh:targetSubjectsOf', s.targetSubjectsOf], ['sh:targetObjectsOf', s.targetObjectsOf]] as const) {
      if (list.length) lines.push(`${pred} ${list.map(iri).join(' , ')}`);
    }
    if (s.severity) lines.push(`sh:severity sh:${s.severity}`);
    if (s.message) lines.push(`sh:message ${JSON.stringify(s.message)}`);
    if (s.closed) lines.push('sh:closed true', 'sh:ignoredProperties ( rdf:type )') && used.set('rdf', RDF);
    if (s.deactivated) lines.push('sh:deactivated true');
    for (const p of s.properties) {
      // A property shape without a path is not yet a constraint; it is left out rather than written wrongly.
      if (!p.path.trim()) continue;
      const c: string[] = [`sh:path ${p.inverse ? `[ sh:inversePath ${iri(p.path)} ]` : iri(p.path)}`];
      if (p.name) c.push(`sh:name ${JSON.stringify(p.name)}`);
      if (p.datatype) c.push(`sh:datatype ${iri(dtIri(p.datatype))}`);
      if (p.class) c.push(`sh:class ${iri(p.class)}`);
      if (p.nodeKind) c.push(`sh:nodeKind sh:${p.nodeKind}`);
      if (p.node) c.push(`sh:node ${iri(p.node)}`);
      if (p.minCount !== undefined) c.push(`sh:minCount ${p.minCount}`);
      if (p.maxCount !== undefined) c.push(`sh:maxCount ${p.maxCount}`);
      for (const k of ['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'] as const) if (p[k]) c.push(`sh:${k} ${lit(p[k]!)}`);
      if (p.minLength !== undefined) c.push(`sh:minLength ${p.minLength}`);
      if (p.maxLength !== undefined) c.push(`sh:maxLength ${p.maxLength}`);
      if (p.pattern) c.push(`sh:pattern ${JSON.stringify(p.pattern)}`);
      if (p.pattern && p.flags) c.push(`sh:flags ${JSON.stringify(p.flags)}`);
      if (p.in?.length) c.push(`sh:in ( ${p.in.map(lit).join(' ')} )`);
      if (p.hasValue) c.push(`sh:hasValue ${lit(p.hasValue)}`);
      if (p.languageIn?.length) c.push(`sh:languageIn ( ${p.languageIn.map((l) => JSON.stringify(l)).join(' ')} )`);
      if (p.uniqueLang) c.push('sh:uniqueLang true');
      if (p.severity) c.push(`sh:severity sh:${p.severity}`);
      if (p.message) c.push(`sh:message ${JSON.stringify(p.message)}`);
      lines.push(`sh:property [\n        ${c.join(' ;\n        ')}\n    ]`);
    }
    blocks.push(`${iri(s.iri)} ${lines.join(' ;\n    ')} .`);
  }
  const head = [...used].sort((a, b) => a[0].localeCompare(b[0])).map(([p, ns]) => `@prefix ${p}: <${ns}> .`);
  const own = blocks.length ? head.join('\n') + '\n\n' + blocks.join('\n\n') + '\n' : '';
  return [own, shapes.extra.trim()].filter(Boolean).join('\n\n# ---- shapes kept as written\n\n') + (shapes.extra.trim() ? '\n' : '');
}

// ---------------------------------------------------------------- from Turtle

interface T {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}
interface Q {
  subject: T;
  predicate: T;
  object: T;
}

/** What is wrong with Turtle as text, or undefined when it parses. */
export function turtleProblem(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    new Parser().parse(text);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : 'Not valid Turtle.';
  }
}

export interface ShapeImport {
  shapes: Shapes;
  /** Node shapes the editor took over, and those kept as Turtle because they use something it has no field for. */
  editable: number;
  kept: number;
  /** Why each kept shape was kept, for telling the user. */
  reasons: string[];
}

/**
 * Reads SHACL shapes from Turtle and adds them to the shapes there already are. A shape that
 * uses only what the editor has fields for becomes editable; any other is kept as Turtle, word
 * for word, and is validated all the same. A shape with the IRI of one already there replaces it.
 */
export function importShapes(model: Model, text: string, into: Shapes = model.shapes): ShapeImport {
  const prefixes: Record<string, string> = { sh: SH };
  const quads = new Parser().parse(text, null, (p: string, ns: { value: string }) => {
    if (p) prefixes[p] = ns.value;
  }) as unknown as Q[];
  const key = (t: T) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value);
  const bySubject = new Map<string, Q[]>();
  for (const q of quads) (bySubject.get(key(q.subject)) ?? bySubject.set(key(q.subject), []).get(key(q.subject))!).push(q);
  const consumed = new Set<string>();

  class Unsupported extends Error {}
  const sh = (local: string) => SH + local;
  const named = (t: T, what: string) => {
    if (t.termType !== 'NamedNode') throw new Unsupported(`${what} that is not a plain IRI`);
    return t.value;
  };
  const int = (t: T, what: string) => {
    if (t.termType !== 'Literal' || !/^\d+$/.test(t.value)) throw new Unsupported(`${what} that is not a whole number`);
    return Number(t.value);
  };
  const bool = (t: T) => t.termType === 'Literal' && (t.value === 'true' || t.value === '1');
  const value = (t: T): ShapeValue => {
    if (t.termType === 'NamedNode') return { v: t.value, iri: true };
    if (t.termType !== 'Literal') throw new Unsupported('a blank node as a value');
    const dt = t.datatype ? dtShort(t.datatype.value) : undefined;
    return { v: t.value, ...(t.language ? { lang: t.language } : dt && dt !== 'xsd:string' && dt !== 'rdf:langString' ? { dt } : {}) };
  };
  const list = (head: T, seen: string[]): T[] => {
    const out: T[] = [];
    for (let node = head, guard = 0; node.value !== RDF + 'nil'; guard++) {
      const qs = bySubject.get(key(node)) ?? [];
      const first = qs.find((q) => q.predicate.value === RDF + 'first');
      const rest = qs.find((q) => q.predicate.value === RDF + 'rest');
      if (!first || !rest || qs.length !== 2 || guard > 10000) throw new Unsupported('a malformed list');
      seen.push(key(node));
      out.push(first.object);
      node = rest.object;
    }
    return out;
  };
  const severity = (t: T): ShaclSeverity => {
    const local = t.value.startsWith(SH) ? t.value.slice(SH.length) : '';
    if (local !== 'Violation' && local !== 'Warning' && local !== 'Info') throw new Unsupported('a severity of its own');
    return local;
  };

  const property = (node: T, seen: string[]): PropertyShape => {
    if (node.termType !== 'BlankNode') throw new Unsupported('a property shape with an IRI of its own');
    seen.push(key(node));
    const p: PropertyShape = { id: uid(), path: '' };
    const once = new Set<string>();
    for (const q of bySubject.get(key(node)) ?? []) {
      const pred = q.predicate.value;
      const o = q.object;
      if (pred === RDF + 'type' && o.value === sh('PropertyShape')) continue;
      if (!pred.startsWith(SH)) throw new Unsupported(`<${pred}> on a property shape`);
      const local = pred.slice(SH.length);
      // Each field holds one value; SHACL allows some constraints to be repeated.
      if (once.has(local)) throw new Unsupported(`sh:${local} more than once on one property`);
      once.add(local);
      switch (local) {
        case 'path':
          if (o.termType === 'NamedNode') p.path = o.value;
          else {
            const inner = bySubject.get(key(o)) ?? [];
            if (o.termType !== 'BlankNode' || inner.length !== 1 || inner[0].predicate.value !== sh('inversePath') || inner[0].object.termType !== 'NamedNode') throw new Unsupported('a property path other than a property or its inverse');
            seen.push(key(o));
            p.path = inner[0].object.value;
            p.inverse = true;
          }
          break;
        case 'name':
          p.name = o.value;
          break;
        case 'message':
          p.message = o.value;
          break;
        case 'severity':
          p.severity = severity(o);
          break;
        case 'minCount':
        case 'maxCount':
        case 'minLength':
        case 'maxLength':
          p[local] = int(o, `sh:${local}`);
          break;
        case 'datatype':
          p.datatype = dtShort(named(o, 'sh:datatype'));
          break;
        case 'class':
          p.class = named(o, 'sh:class');
          break;
        case 'node':
          p.node = named(o, 'sh:node');
          break;
        case 'nodeKind': {
          const kind = o.value.slice(SH.length) as PropertyShape['nodeKind'];
          if (!o.value.startsWith(SH) || !(NODE_KINDS as readonly string[]).includes(kind!)) throw new Unsupported('an unknown sh:nodeKind');
          p.nodeKind = kind;
          break;
        }
        case 'pattern':
          p.pattern = o.value;
          break;
        case 'flags':
          p.flags = o.value;
          break;
        case 'in':
          p.in = list(o, seen).map(value);
          break;
        case 'languageIn':
          p.languageIn = list(o, seen).map((x) => x.value);
          break;
        case 'hasValue':
        case 'minInclusive':
        case 'maxInclusive':
        case 'minExclusive':
        case 'maxExclusive':
          p[local] = value(o);
          break;
        case 'uniqueLang':
          if (bool(o)) p.uniqueLang = true;
          break;
        default:
          throw new Unsupported(`sh:${local}`);
      }
    }
    if (!p.path) throw new Unsupported('a property shape without sh:path');
    return p;
  };

  const nodeShape = (subject: string, seen: string[]): ShapeDef => {
    const s: ShapeDef = { id: uid(), iri: subject, name: '', targetClass: [], targetNode: [], targetSubjectsOf: [], targetObjectsOf: [], properties: [] };
    let ignored: T[] | undefined;
    for (const q of bySubject.get(subject) ?? []) {
      const pred = q.predicate.value;
      const o = q.object;
      if (pred === RDF + 'type') {
        if (o.value === sh('NodeShape')) continue;
        // A shape that is also a class targets that class's instances: an implicit target the editor does not show.
        throw new Unsupported('a shape that is also a class (an implicit class target)');
      }
      if (pred === RDFS + 'label' || pred === sh('name')) {
        s.name ||= o.value;
        continue;
      }
      if (!pred.startsWith(SH)) throw new Unsupported(`<${pred}> on a node shape`);
      const local = pred.slice(SH.length);
      if (local === 'targetClass' || local === 'targetNode' || local === 'targetSubjectsOf' || local === 'targetObjectsOf') s[local].push(named(o, `sh:${local}`));
      else if (local === 'property') s.properties.push(property(o, seen));
      else if (local === 'severity') s.severity = severity(o);
      else if (local === 'message') s.message = o.value;
      else if (local === 'closed') s.closed = bool(o) || undefined;
      else if (local === 'deactivated') s.deactivated = bool(o) || undefined;
      else if (local === 'ignoredProperties') ignored = list(o, seen);
      else throw new Unsupported(`sh:${local} on a node shape`);
    }
    // The editor's "closed" always lets rdf:type through, and only that.
    if (ignored && !(s.closed && ignored.length === 1 && ignored[0].value === RDF + 'type')) throw new Unsupported('sh:ignoredProperties other than rdf:type');
    if (s.closed && !ignored) throw new Unsupported('sh:closed without ignoring rdf:type');
    if (!s.name) s.name = decodeURIComponent(subject.slice(Math.max(subject.lastIndexOf('#'), subject.lastIndexOf('/')) + 1)) || 'Shape';
    return s;
  };

  const isShape = (qs: Q[]) => qs.some((q) => (q.predicate.value === RDF + 'type' && q.object.value === sh('NodeShape')) || ['targetClass', 'targetNode', 'targetSubjectsOf', 'targetObjectsOf', 'property'].some((l) => q.predicate.value === sh(l)));
  // A shape other shapes point at by blank node belongs to them, not to the list of shapes.
  const nodes = [...into.nodes];
  const reasons: string[] = [];
  let editable = 0;
  let kept = 0;
  for (const [subject, qs] of bySubject) {
    if (subject.startsWith('_:') || !isShape(qs) || !isAbsoluteIri(subject)) continue;
    const seen = [subject];
    try {
      const shape = nodeShape(subject, seen);
      seen.forEach((k) => consumed.add(k));
      const at = nodes.findIndex((n) => n.iri === shape.iri);
      if (at >= 0) nodes[at] = { ...shape, id: nodes[at].id };
      else nodes.push(shape);
      editable++;
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      kept++;
      reasons.push(`${compactIri(model, subject) ?? subject}: uses ${e.message}`);
    }
  }
  // Everything that did not become an editable shape is kept, together with what was kept before.
  const rest = quads.filter((q) => !consumed.has(key(q.subject)));
  let extra = into.extra;
  if (rest.length) {
    const before: Record<string, string> = {};
    const old = into.extra.trim() ? (new Parser().parse(into.extra, null, (p: string, ns: { value: string }) => p && (before[p] = ns.value)) as unknown as Q[]) : [];
    // A shape imported again replaces its earlier text rather than being stated twice.
    const again = new Set(rest.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value));
    const writer = new Writer({ prefixes: { ...before, ...prefixes } });
    writer.addQuads([...old.filter((q) => !(q.subject.termType === 'NamedNode' && again.has(q.subject.value))), ...rest] as never);
    writer.end((_err: unknown, result: string) => (extra = result.trim() + '\n'));
  }
  // Having become editable, a shape no longer needs its old text.
  if (editable && extra.trim()) {
    const now = new Set(nodes.map((n) => n.iri));
    const before: Record<string, string> = {};
    const all = new Parser().parse(extra, null, (p: string, ns: { value: string }) => p && (before[p] = ns.value)) as unknown as Q[];
    if (all.some((q) => q.subject.termType === 'NamedNode' && now.has(q.subject.value) && consumed.has(q.subject.value))) {
      const writer = new Writer({ prefixes: before });
      writer.addQuads(all.filter((q) => !(q.subject.termType === 'NamedNode' && consumed.has(q.subject.value))) as never);
      writer.end((_err: unknown, result: string) => (extra = result.trim() ? result.trim() + '\n' : ''));
    }
  }
  return { shapes: { nodes, extra }, editable, kept, reasons };
}

/** How many triples, and how many shapes kept as text, are in the Turtle part. */
export function extraSummary(extra: string): { triples: number; shapes: number } {
  if (!extra.trim()) return { triples: 0, shapes: 0 };
  try {
    const quads = new Parser().parse(extra) as unknown as Q[];
    const shapes = new Set(quads.filter((q) => q.subject.termType === 'NamedNode' && ((q.predicate.value === RDF + 'type' && (q.object.value === SH + 'NodeShape' || q.object.value === SH + 'PropertyShape')) || q.predicate.value.startsWith(SH + 'target'))).map((q) => q.subject.value));
    return { triples: quads.length, shapes: shapes.size };
  } catch {
    return { triples: 0, shapes: 0 };
  }
}

/** Every IRI the editable shapes point at as a class, a node or a property. */
export function shapeReferences(shapes: Shapes): { iri: string; shape: ShapeDef; as: string }[] {
  const out: { iri: string; shape: ShapeDef; as: string }[] = [];
  for (const s of shapes.nodes) {
    for (const c of s.targetClass) out.push({ iri: c, shape: s, as: 'target class' });
    for (const c of s.targetNode) out.push({ iri: c, shape: s, as: 'target node' });
    for (const c of [...s.targetSubjectsOf, ...s.targetObjectsOf]) out.push({ iri: c, shape: s, as: 'target property' });
    for (const p of s.properties) {
      if (p.path) out.push({ iri: p.path, shape: s, as: 'property path' });
      if (p.class) out.push({ iri: p.class, shape: s, as: 'class constraint' });
    }
  }
  return out;
}

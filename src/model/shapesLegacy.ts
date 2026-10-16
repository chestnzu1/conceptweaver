import { readShapes, SH, type ShapeSet } from './shacl';
import { isLang, uid } from './types';

/**
 * The shapes of a model of format 4 or before, as that format held them: node shapes with
 * property shapes in fixed fields, and Turtle for what the fields could not say. Read only to be
 * brought into format 5 (shape sets): written as the Turtle format 4 wrote, and read back by the
 * reader of today, so that the shapes say exactly what they said (fixtures/v4 checks it).
 */

interface ShapeValue {
  v: string;
  iri?: boolean;
  dt?: string;
  lang?: string;
}

interface PropertyShape {
  path: string;
  inverse?: boolean;
  name?: string;
  message?: string;
  severity?: string;
  minCount?: number;
  maxCount?: number;
  datatype?: string;
  class?: string;
  nodeKind?: string;
  pattern?: string;
  flags?: string;
  in?: ShapeValue[];
  hasValue?: ShapeValue;
  minInclusive?: ShapeValue;
  maxInclusive?: ShapeValue;
  minExclusive?: ShapeValue;
  maxExclusive?: ShapeValue;
  minLength?: number;
  maxLength?: number;
  uniqueLang?: boolean;
  languageIn?: string[];
  node?: string;
}

interface ShapeDef {
  iri: string;
  name: string;
  targetClass: string[];
  targetNode: string[];
  targetSubjectsOf: string[];
  targetObjectsOf: string[];
  severity?: string;
  message?: string;
  closed?: boolean;
  deactivated?: boolean;
  properties: PropertyShape[];
}

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SEVERITIES = ['Violation', 'Warning', 'Info'];
const NODE_KINDS = ['IRI', 'Literal', 'BlankNode', 'BlankNodeOrIRI', 'BlankNodeOrLiteral', 'IRIOrLiteral'];
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(str).filter(Boolean))] : []);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
function shapeValue(v: unknown): ShapeValue | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.v !== 'string') return undefined;
  return { v: o.v, ...(o.iri === true ? { iri: true } : {}), ...(str(o.dt) ? { dt: str(o.dt) } : {}), ...(isLang(str(o.lang)) ? { lang: str(o.lang).toLowerCase() } : {}) };
}

/** The node shapes of format 4, as well formed as its own reader made them. */
function legacyNodes(raw: Record<string, unknown>): ShapeDef[] {
  const nodes: ShapeDef[] = [];
  for (const n of (Array.isArray(raw.nodes) ? raw.nodes : []) as Record<string, unknown>[]) {
    if (!n || typeof n !== 'object' || !str(n.iri)) continue;
    const properties: PropertyShape[] = [];
    for (const p of (Array.isArray(n.properties) ? n.properties : []) as Record<string, unknown>[]) {
      if (!p || typeof p !== 'object') continue;
      const out: PropertyShape = { path: str(p.path) };
      if (p.inverse === true) out.inverse = true;
      for (const k of ['name', 'message', 'datatype', 'class', 'pattern', 'flags', 'node'] as const) if (str(p[k])) out[k] = str(p[k]);
      if (SEVERITIES.includes(str(p.severity))) out.severity = str(p.severity);
      for (const k of ['minCount', 'maxCount', 'minLength', 'maxLength'] as const) if (count(p[k]) !== undefined) out[k] = count(p[k]);
      if (NODE_KINDS.includes(str(p.nodeKind))) out.nodeKind = str(p.nodeKind);
      for (const k of ['hasValue', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'] as const) if (shapeValue(p[k])) out[k] = shapeValue(p[k]);
      if (Array.isArray(p.in)) out.in = p.in.map(shapeValue).filter((x): x is ShapeValue => !!x);
      if (p.uniqueLang === true) out.uniqueLang = true;
      if (Array.isArray(p.languageIn)) out.languageIn = strs(p.languageIn);
      properties.push(out);
    }
    nodes.push({
      iri: str(n.iri),
      name: str(n.name),
      targetClass: strs(n.targetClass),
      targetNode: strs(n.targetNode),
      targetSubjectsOf: strs(n.targetSubjectsOf),
      targetObjectsOf: strs(n.targetObjectsOf),
      ...(SEVERITIES.includes(str(n.severity)) ? { severity: str(n.severity) } : {}),
      ...(str(n.message) ? { message: str(n.message) } : {}),
      ...(n.closed === true ? { closed: true } : {}),
      ...(n.deactivated === true ? { deactivated: true } : {}),
      properties,
    });
  }
  return nodes;
}

/** The Turtle format 4 wrote for its shapes, with full IRIs. */
function legacyTurtle(nodes: ShapeDef[], extra: string): string {
  const iri = (x: string) => `<${x}>`;
  const dtIri = (dt: string) => (dt.startsWith('xsd:') ? XSD + dt.slice(4) : dt.startsWith('rdf:') ? RDF + dt.slice(4) : dt);
  const lit = (v: ShapeValue): string => {
    if (v.iri) return iri(v.v);
    if (v.lang) return `${JSON.stringify(v.v)}@${v.lang}`;
    if (v.dt && v.dt !== 'xsd:string') return `${JSON.stringify(v.v)}^^${iri(dtIri(v.dt))}`;
    return JSON.stringify(v.v);
  };
  const blocks: string[] = [];
  for (const s of nodes) {
    const lines: string[] = ['a sh:NodeShape'];
    if (s.name.trim()) lines.push(`<http://www.w3.org/2000/01/rdf-schema#label> ${JSON.stringify(s.name.trim())}`);
    for (const [pred, list] of [['sh:targetClass', s.targetClass], ['sh:targetNode', s.targetNode], ['sh:targetSubjectsOf', s.targetSubjectsOf], ['sh:targetObjectsOf', s.targetObjectsOf]] as const) {
      if (list.length) lines.push(`${pred} ${list.map(iri).join(' , ')}`);
    }
    if (s.severity) lines.push(`sh:severity sh:${s.severity}`);
    if (s.message) lines.push(`sh:message ${JSON.stringify(s.message)}`);
    if (s.closed) lines.push(`sh:closed true`, `sh:ignoredProperties ( <${RDF}type> )`);
    if (s.deactivated) lines.push('sh:deactivated true');
    for (const p of s.properties) {
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
      lines.push(`sh:property [ ${c.join(' ; ')} ]`);
    }
    blocks.push(`${iri(s.iri)} ${lines.join(' ;\n    ')} .`);
  }
  return [blocks.length ? `@prefix sh: <${SH}> .\n\n${blocks.join('\n\n')}` : '', extra.trim()].filter(Boolean).join('\n\n') + '\n';
}

/**
 * The shapes of a model file of format 4 or before, as the one shape set they become. None when
 * there were none. Shapes format 4 could not read stay kept as written.
 */
export function shapeSetOfFormat4(raw: unknown): ShapeSet[] {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const nodes = legacyNodes(o);
  const extra = str(o.extra);
  if (!nodes.length && !extra.trim()) return [];
  const text = legacyTurtle(nodes, extra);
  let read: ReturnType<typeof readShapes>;
  try {
    read = readShapes(text);
  } catch {
    // Text that does not read as Turtle was never validated either: it is kept as it was.
    read = { shapes: [], extra, prefixes: {} };
  }
  return [{ id: uid(), name: 'Shapes', description: '', namespace: '', shapes: read.shapes, extra: read.extra, prefixes: read.prefixes }];
}

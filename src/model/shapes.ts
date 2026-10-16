import { Parser } from 'n3';
import { baseIriOf, localName } from './iri';
import { allPrefixes } from './prefixes';
import { isPropertyShape, newShapeSet, pathIris, PARAM, readShapes, SH, shapeSetTurtle, STANDARD_PREFIXES, valuesOf, type Shape, type ShapeSet, type ShaclValue } from './shacl';
import { uid, type Model } from './types';

/**
 * The model's SHACL shape sets, as the rest of the app uses them: a set as Turtle, the shapes
 * graph the validator gets, shapes read into a set, new shapes, and the shapes about an entity.
 * The structure itself is shacl.ts.
 *
 * Shapes are their own graphs. They never go into the ontology's export, and nothing here turns
 * an OWL restriction into a shape or the other way round (ADR-020): a restriction says what
 * follows about a class's members, a shape says what data must contain to be accepted.
 */

export { SH } from './shacl';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

/** The model's prefixes, to write shapes with. */
export const modelPrefixes = (model: Model): Record<string, string> => Object.fromEntries(allPrefixes(model).map((p) => [p.prefix, p.iri]));

/** One shape set as Turtle, with the model's prefixes where the set has none of its own. */
export const setTurtle = (model: Model, set: ShapeSet): string => shapeSetTurtle(set, { prefixes: { ...modelPrefixes(model), ...set.prefixes } });

/**
 * The shapes graph a validation gets: every set (or those given) as Turtle, one after the other,
 * anonymous shapes by their ids so that a result names the very shape it is of.
 */
export function shapesToTurtle(model: Model, sets: ShapeSet[] = model.shapeSets): string {
  return sets
    .map((set) => shapeSetTurtle(set, { prefixes: { ...modelPrefixes(model), ...set.prefixes }, labelled: true }))
    .filter((t) => t.trim())
    .join('\n');
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
  set: ShapeSet;
  /** Shapes read, and of those how many replaced shapes with the same IRI. */
  shapes: number;
  replaced: number;
  /** Statements about no shape, kept as written. */
  kept: number;
}

/**
 * Reads shapes from Turtle into a set: each a structure the editor edits, whatever of SHACL Core
 * it uses; a named shape with the IRI of one already in the set replaces it. What the graph says
 * about no shape is kept as written, after what the set kept before. Throws when it is not Turtle.
 */
export function importIntoSet(set: ShapeSet, text: string, base?: string): ShapeImport {
  const read = readShapes(text, base);
  const byIri = new Map(set.shapes.filter((s) => s.iri).map((s) => [s.iri!, s]));
  let replaced = 0;
  const incoming = read.shapes.map((s) => {
    const was = s.iri ? byIri.get(s.iri) : undefined;
    if (!was) return s;
    replaced++;
    return { ...s, id: was.id };
  });
  // A replaced shape's id is the new one's: what pointed at the new one by id still does.
  const renamed = new Map(read.shapes.map((s, i) => [s.id, incoming[i].id]));
  const fix = (v: ShaclValue): ShaclValue => ('shape' in v ? { shape: renamed.get(v.shape) ?? v.shape } : 'list' in v ? { list: v.list.map(fix) } : v);
  const fixed = incoming.map((s) => ({ ...s, props: s.props.map((x) => ({ p: x.p, v: fix(x.v) })) }));
  const replacedIds = new Set(fixed.map((s) => s.id));
  const kept = read.extra.trim() ? new Parser().parse(read.extra).length : 0;
  return {
    set: {
      ...set,
      shapes: [...set.shapes.filter((s) => !replacedIds.has(s.id)), ...fixed],
      extra: [set.extra.trim(), read.extra.trim()].filter(Boolean).join('\n\n') + (set.extra.trim() || read.extra.trim() ? '\n' : ''),
      prefixes: { ...set.prefixes, ...read.prefixes },
    },
    shapes: read.shapes.length,
    replaced,
    kept,
  };
}

/** A new shape set, its new shapes in the model's namespace. */
export const newSetFor = (name: string): ShapeSet => newShapeSet(name);

/** Where a set's new shapes get their IRIs. */
export const namespaceOf = (model: Model, set: ShapeSet): string => set.namespace || baseIriOf(model);

/**
 * A new node shape in a set, with an IRI of its own in the set's namespace, a label, and, when a
 * class is given, that class as its target.
 */
export function newNodeShape(model: Model, set: ShapeSet, name = 'New shape', targetClass?: string): Shape {
  const ns = namespaceOf(model, set);
  const taken = new Set(
    [...model.shapeSets.flatMap((s) => s.shapes.map((x) => x.iri)), ...model.terms.map((t) => t.iri), ...model.props.map((p) => p.iri)]
      .filter(Boolean)
      .map((x) => x!.toLowerCase()),
  );
  const local = localName(name, false).replace(/Shape$/i, '') + 'Shape';
  let iri = ns + local;
  for (let i = 2; taken.has(iri.toLowerCase()); i++) iri = `${ns}${local}_${i}`;
  return {
    id: uid(),
    iri,
    props: [
      { p: RDF + 'type', v: { iri: SH + 'NodeShape' } },
      ...(name.trim() ? [{ p: RDFS + 'label', v: { lit: name.trim() } }] : []),
      ...(targetClass ? [{ p: SH + 'targetClass', v: { iri: targetClass } }] : []),
    ],
  };
}

/** A new anonymous property shape on a path. */
export const newPropertyShape = (path: string): Shape => ({ id: uid(), props: [{ p: SH + 'path', v: { path: { iri: path } } }] });

/** A new anonymous node shape, to be the value of sh:node, sh:not, or a member of sh:or and the like. */
export const newInlineShape = (): Shape => ({ id: uid(), props: [] });

/** The shape and its set, by id. */
export function findShape(model: Model, id: string): { set: ShapeSet; shape: Shape } | undefined {
  for (const set of model.shapeSets) {
    const shape = set.shapes.find((s) => s.id === id);
    if (shape) return { set, shape };
  }
  return undefined;
}

/** A named shape of any set, by IRI. */
export function shapeByIri(model: Model, iri: string): { set: ShapeSet; shape: Shape } | undefined {
  for (const set of model.shapeSets) {
    const shape = set.shapes.find((s) => s.iri === iri);
    if (shape) return { set, shape };
  }
  return undefined;
}

/** How a shape is called: its label, its name, the local part of its IRI, or what kind it is. */
export function shapeName(shape: Shape): string {
  const label = valuesOf(shape, RDFS + 'label').find((v): v is { lit: string } => 'lit' in v);
  if (label) return label.lit;
  const name = valuesOf(shape, SH + 'name').find((v): v is { lit: string } => 'lit' in v);
  if (name) return name.lit;
  if (shape.iri) return decodeURIComponent(shape.iri.slice(Math.max(shape.iri.lastIndexOf('#'), shape.iri.lastIndexOf('/')) + 1)) || shape.iri;
  return isPropertyShape(shape) ? 'Property shape' : 'Anonymous shape';
}

/** The anonymous shapes a shape holds, and those they hold, by id. */
export function nestedIds(set: ShapeSet, shape: Shape): Set<string> {
  const byId = new Map(set.shapes.map((s) => [s.id, s]));
  const out = new Set<string>();
  const walk = (v: ShaclValue) => {
    if ('shape' in v && !out.has(v.shape)) {
      out.add(v.shape);
      const s = byId.get(v.shape);
      if (s) s.props.forEach((x) => walk(x.v));
    } else if ('list' in v) v.list.forEach(walk);
  };
  shape.props.forEach((x) => walk(x.v));
  return out;
}

/** The shapes a set lists: named ones, and anonymous ones no other shape holds. */
export function topShapes(set: ShapeSet): Shape[] {
  const held = new Set<string>();
  for (const s of set.shapes) for (const id of nestedIds(set, s)) held.add(id);
  return set.shapes.filter((s) => s.iri || !held.has(s.id));
}

/** The top-level shape that holds a shape, itself if none does. */
export function ownerOf(set: ShapeSet, id: string): Shape | undefined {
  return topShapes(set).find((s) => s.id === id || nestedIds(set, s).has(id));
}

/** What a shape targets, as IRIs of classes: its target classes, and itself where it is also a class (an implicit class target). */
export function targetClasses(shape: Shape): string[] {
  const out = valuesOf(shape, SH + 'targetClass').flatMap((v) => ('iri' in v ? [v.iri] : []));
  const isClass = valuesOf(shape, RDF + 'type').some((v) => 'iri' in v && (v.iri === RDFS + 'Class' || v.iri === 'http://www.w3.org/2002/07/owl#Class'));
  return isClass && shape.iri ? [...out, shape.iri] : out;
}

/** The shapes, in every set, that are about an entity: that target it as a class, or constrain it as a property. */
export function shapesAbout(model: Model, iri: string): { set: ShapeSet; shape: Shape; how: string }[] {
  const out: { set: ShapeSet; shape: Shape; how: string }[] = [];
  for (const set of model.shapeSets) {
    for (const shape of set.shapes) {
      const top = shape.iri || !ownerOf(set, shape.id) || ownerOf(set, shape.id)!.id === shape.id ? shape : ownerOf(set, shape.id)!;
      const add = (how: string) => {
        if (!out.some((x) => x.shape.id === top.id && x.how === how)) out.push({ set, shape: top, how });
      };
      if (targetClasses(shape).includes(iri)) add('targets it');
      for (const { p, v } of shape.props) {
        if (p === SH + 'path' && 'path' in v && pathIris(v.path).includes(iri)) add('constrains it');
        else if (PARAM.get(p)?.kind === 'class' && p !== SH + 'targetClass' && 'iri' in v && v.iri === iri) add('requires it as a class');
        else if ((p === SH + 'targetSubjectsOf' || p === SH + 'targetObjectsOf') && 'iri' in v && v.iri === iri) add('targets by it');
      }
    }
  }
  return out;
}

export { shapeReferences } from './shacl';

/**
 * A set without the anonymous shapes given and those they hold, where nothing else holds them:
 * what goes when a value that is an inline shape is taken away.
 */
export function withoutInline(set: ShapeSet, ids: string[]): ShapeSet {
  const drop = new Set<string>();
  const byId = new Map(set.shapes.map((s) => [s.id, s]));
  const walk = (id: string) => {
    const s = byId.get(id);
    if (!s || s.iri || drop.has(id)) return;
    drop.add(id);
    for (const nested of nestedIds(set, s)) walk(nested);
  };
  ids.forEach(walk);
  // A shape that something left still holds stays.
  const held = new Set<string>();
  const count = (v: ShaclValue) => ('shape' in v ? held.add(v.shape) : 'list' in v ? v.list.forEach(count) : undefined);
  for (const s of set.shapes) if (!drop.has(s.id)) s.props.forEach((x) => count(x.v));
  return { ...set, shapes: set.shapes.filter((s) => !drop.has(s.id) || held.has(s.id)) };
}

/** The anonymous shapes a value holds, at its first level. */
export const inlineIn = (v: ShaclValue): string[] => ('shape' in v ? [v.shape] : 'list' in v ? v.list.flatMap(inlineIn) : []);

/** How the shapes form names IRIs, and reads the names typed in it, for one set. */
export interface ShapeNaming {
  /** An IRI as Turtle writes it: a prefixed name where there is a prefix for it, otherwise <IRI>. */
  name(iri: string): string;
  /** An IRI as a person reads it: the name of the entity it is, or as `name` writes it. */
  label(iri: string): string;
  /** The IRI of a prefixed name, or of the name of an entity of the model; nothing for anything else. */
  resolve(text: string): string | undefined;
}

export function shapeNaming(model: Model, set: ShapeSet | undefined): ShapeNaming {
  const prefixes = { ...STANDARD_PREFIXES, ...modelPrefixes(model), ...(set?.prefixes ?? {}) };
  const byNs = Object.entries(prefixes)
    .filter(([, ns]) => ns)
    .sort((a, b) => b[1].length - a[1].length);
  const entities = new Map<string, string>();
  for (const t of model.terms) if (t.iri && t.name) entities.set(t.iri, t.name);
  for (const p of model.props) if (p.iri && p.name) entities.set(p.iri, p.name);
  const byName = new Map<string, string>();
  for (const [iri, n] of entities) if (!byName.has(n)) byName.set(n, iri);
  const name = (iri: string) => {
    for (const [p, ns] of byNs) if (iri.startsWith(ns) && /^(?:[A-Za-z0-9_](?:[\w.-]*[\w-])?)?$/.test(iri.slice(ns.length))) return `${p}:${iri.slice(ns.length)}`;
    return `<${iri}>`;
  };
  return {
    name,
    label: (iri) => entities.get(iri) ?? name(iri),
    resolve: (text) => {
      const t = text.trim();
      if (t.startsWith('<') && t.endsWith('>')) return t.slice(1, -1);
      const at = t.indexOf(':');
      if (at >= 0 && t.slice(0, at) in prefixes && !/\s/.test(t)) return prefixes[t.slice(0, at)] + t.slice(at + 1);
      return byName.get(t);
    },
  };
}

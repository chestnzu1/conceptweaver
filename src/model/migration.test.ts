import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propDatatype, unionClasses } from './domains';
import { expressionOfTurtle, XSD, type ClassAxiom } from './expressions';
import { linkProps } from './identity';
import { classText, namingFor } from './manchester';
import { withIris } from './iri';
import { dataDomain, objectProperties, plainRelationships, relChoice, type PropView } from './props';
import { fromTurtle, toTurtle } from './rdf';
import { MODEL_VERSION, normalizeModel, type Model } from './types';
import { findShape, setTurtle } from './shapes';
import { statementsOf } from './unmapped';
import { shaclFindings } from './validation';

/**
 * Models saved in format 1, before object properties had ids (fixtures/v1, written by the code of
 * that format and not since), opened by the code of today. Beside each is what the code of format
 * 1 made of it: its Turtle, and its reading (what every relationship is, every property with its
 * links and uses, and the labels that were no property). A model saved then has to open as the
 * same model: the same ontology, the same relationships, the same properties, the same picture.
 */
const dir = new URL('./fixtures/v1/', import.meta.url).pathname;
const read = (file: string) => fs.readFileSync(dir + file, 'utf8');
// As the editor opens a model: read, every named entity given its IRI, every relationship joined to its property.
const open = (raw: unknown): Model => linkProps(withIris(normalizeModel(raw)));

/**
 * A domain or range as the classes (by term id) that the code of formats 1 and 2 listed for it:
 * the ones it follows, or the ones stated, which those formats wrote as their union. In any order:
 * a union is the same whatever order its classes are in, and today they are kept in the order
 * they were written (by name). Undefined for one that is not a union of classes of the model.
 */
function listed(m: Model, axioms: ClassAxiom[], auto: boolean, used: string[]): string[] | undefined {
  if (auto) return [...used].sort();
  return unionClasses(axioms)
    ?.map((iri) => m.terms.find((t) => t.iri === iri)?.id)
    .filter((x): x is string => !!x)
    .sort();
}
const sides = (m: Model, p: PropView) => ({ domain: listed(m, p.domains, p.domainAuto, p.usedFrom), range: listed(m, p.ranges, p.rangeAuto, p.usedTo) });

/** What format 1's code wrote down of a model, worked out by today's: links and uses are by id now, and shown by name. */
function reading(m: Model) {
  const props = objectProperties(m);
  const name = (id: string) => props.find((p) => p.id === id)?.name ?? `(${id})`;
  return {
    relations: Object.fromEntries(m.relations.map((r) => [r.id, relChoice(m, r)])),
    props: props.map((p) => ({ name: p.name, iri: p.iri, chars: p.chars, ...sides(m, p), parents: p.parents.map(name), inverses: p.inverses.map(name), equivalents: p.equivalents.map(name), disjoints: p.disjoints.map(name), uses: p.rels.map((r) => r.id).sort() })),
    plain: plainRelationships(m).map((p) => ({ name: p.name, uses: p.rels.map((r) => r.id).sort() })),
  };
}
/** A reading as it was written down, with its lists of classes in any order (see `listed`). */
const unordered = <T extends { props: { domain: string[]; range: string[] }[] }>(r: T): T => ({ ...r, props: r.props.map((p) => ({ ...p, domain: [...p.domain].sort(), range: [...p.range].sort() })) });

describe('a model saved in format 1', () => {
  for (const name of ['sample', 'university', 'edge-cases']) {
    describe(name, () => {
      const raw = JSON.parse(read(`${name}.json`));
      const m = open(raw);

      it('was saved in format 1, and opens in the format of today, every object property with an id of its own', () => {
        expect(raw.version).toBe(1);
        expect(raw.props.every((p: Record<string, unknown>) => p.id === undefined)).toBe(true);
        expect(m.version).toBe(MODEL_VERSION);
        expect(new Set(m.props.map((p) => p.id)).size).toBe(m.props.length);
        expect(m.props.map((p) => p.name)).toEqual(raw.props.map((p: { name: string }) => p.name));
      });

      it('says the same thing: its Turtle is what format 1 wrote', () => {
        expect(toTurtle(m)).toBe(read(`${name}.ttl`));
      });

      it('reads the same: every relationship is what it was, every property has the same links and uses', () => {
        expect(reading(m)).toEqual(unordered(JSON.parse(read(`${name}.reading.json`))));
      });

      it('looks the same: positions, colours, labels, styles and layout are untouched', () => {
        const before = normalizeModel(raw);
        expect(m.terms.map((t) => [t.id, t.name, t.x, t.y, t.color])).toEqual(raw.terms.map((t: Model['terms'][number]) => [t.id, t.name, t.x, t.y, t.color]));
        expect(m.relations.map((r) => [r.id, r.from, r.to, r.label])).toEqual(raw.relations.map((r: Model['relations'][number]) => [r.id, r.from, r.to, r.label]));
        expect(m.style).toEqual(before.style);
        expect(m.layout).toEqual(before.layout);
      });

      it('is saved in the format of today, and opens from that unchanged', () => {
        const saved = JSON.parse(JSON.stringify(m));
        expect(saved.version).toBe(MODEL_VERSION);
        // Every use of a property names it by id, so that a rename cannot detach it.
        const used = new Set(m.relations.filter((r) => relChoice(m, r) === 'object').map((r) => r.id));
        expect(m.relations.filter((r) => used.has(r.id)).every((r) => m.props.some((p) => p.id === r.prop))).toBe(true);
        expect(open(saved)).toEqual(m);
      });
    });
  }
});

/**
 * A model saved in format 2 (fixtures/v2, written by the code of that format and not since), whose
 * domains and ranges were lists of classes that meant their union, and a data property's range one
 * datatype, beside it a range written in place kept as text. Opened today, each is an axiom that
 * says what format 2 wrote: the same Turtle, read the same, and read back the same from that Turtle.
 */
describe('a model saved in format 2', () => {
  const dir2 = new URL('./fixtures/v2/', import.meta.url).pathname;
  const read2 = (file: string) => fs.readFileSync(dir2 + file, 'utf8');
  const raw = JSON.parse(read2('domains.json'));
  const m = open(raw);
  const was = JSON.parse(read2('domains.reading.json')) as {
    props: { name: string; domain: string[]; range: string[]; domainAuto: boolean; rangeAuto: boolean }[];
    dataProps: { name: string; domain: { ids: string[]; auto: boolean }; range: string | null; axioms: string[] }[];
  };
  const term = (name: string) => m.terms.find((t) => t.name === name)!;
  const prop = (name: string) => m.props.find((p) => p.name === name)!;

  it('was saved in format 2, with lists of classes, and opens in the format of today with axioms', () => {
    expect(raw.version).toBe(2);
    expect(raw.props.some((p: Record<string, unknown>) => Array.isArray(p.domain) && p.domain.length > 1)).toBe(true);
    expect(m.version).toBe(MODEL_VERSION);
    expect(m.props.every((p) => !('domain' in p) && !('range' in p))).toBe(true);
    expect(m.terms.every((t) => !('domain' in t) && !('range' in t))).toBe(true);
  });

  it('says the same thing: its Turtle is what format 2 wrote', () => {
    expect(toTurtle(m)).toBe(read2('domains.ttl'));
  });

  it('keeps what each list meant: one class is that class, several are their union in one axiom, none is none', () => {
    const expressions = (axioms: ClassAxiom[] | undefined) => axioms?.map((a) => a.expression);
    const cls = (name: string) => ({ type: 'Class', iri: term(name).iri });
    expect(expressions(prop('member of').domains)).toEqual([cls('Person')]);
    expect(expressions(prop('took part in').domains)).toEqual([{ type: 'ObjectUnionOf', operands: [cls('Organisation'), cls('Person')] }]);
    expect(prop('located in').domains).toEqual([]);
    expect(prop('knows').domains).toBeUndefined();
    expect(expressions(term('size').domains)).toEqual([{ type: 'ObjectUnionOf', operands: [cls('Organisation'), cls('Person')] }]);
    expect(term('colour').domains).toEqual([]);
    expect(term('note').domains).toBeUndefined();
  });

  it('reads the same: every domain and range follows the same uses or lists the same classes, every datatype is the same', () => {
    const props = objectProperties(m);
    expect(props.map((p) => ({ name: p.name, ...sides(m, p), domainAuto: p.domainAuto, rangeAuto: p.rangeAuto }))).toEqual(unordered(was).props);
    const data = m.terms.filter((t) => t.type === 'property');
    expect(
      data.map((t) => {
        const d = dataDomain(m, t);
        return { name: t.name, domain: { ids: listed(m, d.axioms, d.auto, d.attached), auto: d.auto }, range: propDatatype(t) ?? null };
      }),
    ).toEqual(was.dataProps.map(({ axioms: _, ...p }) => ({ ...p, domain: { ...p.domain, ids: [...p.domain.ids].sort() } })));
  });

  it('makes a range kept as text the axiom it states, in the order it was written, and keeps nothing as text', () => {
    const code = term('code');
    const kept = was.dataProps.find((p) => p.name === 'code')!.axioms;
    expect(kept).toHaveLength(1);
    expect('axioms' in code).toBe(false);
    expect(code.ranges!.map((a) => a.range)).toEqual([expressionOfTurtle(kept[0].slice('rdfs:range '.length), 'data'), { type: 'Datatype', iri: XSD + 'string' }]);
    expect(code.ranges![0].range).toMatchObject({ type: 'DatatypeRestriction', datatype: XSD + 'string' });
  });

  it('is read back from its Turtle as the same statements, and saved and opened again unchanged', () => {
    const statements = (ttl: string) => statementsOf(ttl).map((s) => s.text).sort();
    const ttl = read2('domains.ttl');
    expect(statements(toTurtle(fromTurtle(ttl)))).toEqual(statements(ttl));
    const saved = JSON.parse(JSON.stringify(m));
    expect(saved.version).toBe(MODEL_VERSION);
    expect(open(saved)).toEqual(m);
  });
});

/**
 * A model saved in format 3 (fixtures/v3, written by the code of that format and not since), whose
 * superclasses and definitions that were expressions were kept as Turtle text with the class.
 * Opened today each is an axiom of the kind it was stated as, with a structured expression, and
 * the ontology says what it said: the same statements, read the same way.
 */
describe('a model saved in format 3', () => {
  const dir3 = new URL('./fixtures/v3/', import.meta.url).pathname;
  const read3 = (file: string) => fs.readFileSync(dir3 + file, 'utf8');
  const raw = JSON.parse(read3('expressions.json'));
  const m = open(raw);
  const was = JSON.parse(read3('expressions.reading.json')) as { classes: { name: string; iri: string; axioms: string[] }[]; unmapped: string | null };
  const naming = namingFor(m);
  const said = (name: string) => (m.terms.find((t) => t.name === name)!.classAxioms ?? []).map((a) => `${a.kind}: ${classText(a.expression, naming)}`);
  const statements = (ttl: string) => statementsOf(ttl).map((s) => s.text).sort();

  it('was saved in format 3, with expressions as text, and opens in the format of today with none', () => {
    expect(raw.version).toBe(3);
    expect(raw.terms.filter((t: Record<string, unknown>) => Array.isArray(t.axioms)).length).toBe(was.classes.length);
    expect(m.version).toBe(MODEL_VERSION);
    expect(m.terms.every((t) => !('axioms' in t))).toBe(true);
  });

  it('makes each text the axiom it states, of its kind, in the order written', () => {
    expect(said('Vegetarian pizza')).toEqual(["EquivalentClasses: Pizza and not ('has topping' some 'Meat topping')"]);
    expect(said('Adult person')).toEqual(["SubClassOf: Person and ('has age' some xsd:integer[>= 18])"]);
    expect(said('Agent')).toEqual(['SubClassOf: Person or Organisation']);
    expect(said('Italian thing')).toEqual(["SubClassOf: 'made in' value Italy"]);
    expect(said('Parent')).toEqual(["SubClassOf: 'has child' min 1"]);
    expect(said('Grandparent')).toEqual(["EquivalentClasses: 'has child' some ('has child' some Person)"]);
    expect(said('Member')).toEqual(["SubClassOf: inverse 'has member' some Organisation"]);
    expect(said('Traffic colour')).toEqual(['SubClassOf: {red, amber, green}']);
    expect(said('Narcissist')).toEqual(['SubClassOf: loves Self']);
    expect(said('Twin')).toEqual(["SubClassOf: 'has sibling' exactly 1 (Person and not Organisation)", "SubClassOf: 'has child' only (Person or Place)"]);
    // Every text became the axiom the reader of today makes of it: nothing is left as text, and nothing is Unparsed.
    for (const c of was.classes) {
      const term = m.terms.find((t) => t.iri === c.iri)!;
      expect(term.classAxioms!.map((a) => a.expression)).toEqual(c.axioms.map((text) => expressionOfTurtle(text.slice(text.indexOf(' ') + 1), 'class')));
      expect(term.classAxioms!.every((a) => a.expression.type !== 'Unparsed')).toBe(true);
    }
  });

  it('says the same thing: the same statements as the Turtle format 3 wrote, and the same read back', () => {
    expect(statements(toTurtle(m))).toEqual(statements(read3('expressions.ttl')));
    const again = fromTurtle(toTurtle(m));
    const bodies = (model: Model) => model.terms.filter((t) => t.classAxioms).map((t) => [t.iri, t.classAxioms!.map((a) => [a.kind, a.expression])]);
    expect(bodies(again).filter(([iri]) => iri !== 'http://example.org/expressions#Hermit')).toEqual(bodies(m));
    // What format 3 could not hold (an owl:disjointWith with an expression) it kept as a statement; it is kept so.
    expect(m.unmapped).toBe(was.unmapped);
  });

  it('is saved in the format of today, and opens from that unchanged', () => {
    const saved = JSON.parse(JSON.stringify(m));
    expect(saved.version).toBe(MODEL_VERSION);
    expect(open(saved)).toEqual(m);
  });
});

/**
 * A model saved in format 4 (fixtures/v4, written by the code of that format and not since), whose
 * shapes were one graph of node shapes in fixed fields, with Turtle for what the fields could not
 * say. Opened today they are one shape set, every shape a structure, saying the same, and a
 * validation finds the same as format 4 found.
 */
describe('a model saved in format 4', () => {
  const dir4 = new URL('./fixtures/v4/', import.meta.url).pathname;
  const read4 = (file: string) => fs.readFileSync(dir4 + file, 'utf8');
  const raw = JSON.parse(read4('shapes.json'));
  const m = open(raw);
  const was = JSON.parse(read4('shapes.findings.json')) as { findings: Record<string, unknown>[]; editable: number; kept: number };
  const statements = (ttl: string) => statementsOf(ttl).map((s) => s.text).sort();

  it('was saved in format 4, with its shapes in fields and one kept as Turtle, and opens with them as one set', () => {
    expect(raw.version).toBe(4);
    expect(raw.shapes.nodes).toHaveLength(was.editable);
    expect(raw.shapes.extra).toContain('ContactShape');
    expect(m.version).toBe(MODEL_VERSION);
    expect(m.shapeSets).toHaveLength(1);
    expect(m.shapeSets[0].name).toBe('Shapes');
    // The shape format 4 kept as text (it used sh:or) is a structure now, like the others; nothing is kept as text.
    expect(m.shapeSets[0].shapes.filter((s) => s.iri).map((s) => s.iri!.split('#')[1]).sort()).toEqual(['ContactShape', 'OrganisationShape', 'PersonShape']);
    expect(m.shapeSets[0].extra).toBe('');
  });

  it('says what format 4 said: the same statements as its shapes graph', () => {
    expect(statements(setTurtle(m, m.shapeSets[0]))).toEqual(statements(read4('shapes.shapes.ttl')));
  });

  it('validates to the same findings', async () => {
    const { findings } = await shaclFindings(m);
    const said = findings.map((f) => ({ severity: f.severity, rule: f.rule, message: f.message, shape: findShape(m, f.shapeId!)?.shape.iri ?? null, ...f.shacl }));
    expect(said).toEqual(was.findings);
  });

  it('is saved in the format of today, and opens from that unchanged', () => {
    const saved = JSON.parse(JSON.stringify(m));
    expect(saved.version).toBe(MODEL_VERSION);
    expect(saved.shapes).toBeUndefined();
    expect(open(saved)).toEqual(m);
  });
});

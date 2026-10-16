import { Parser } from 'n3';
import { axiomFunctionalSyntax, functionalSyntax, graphOf, namedClasses, OWL, RDF, RDFS, readClass, readDataRange, XSD, type ClassAxiomKind, type ClassExpression, type DataRange, type Graph, type Literal, type ObjectPropertyExpression, type RdfTerm } from './expressions';
import { classText, dataText, literalText, namingFor } from './manchester';
import { toTurtle } from './rdf';
import { CW_SHAPES, pathToSparql, SH, type ShaclPath, type ShaclTerm, type ShaclValue, type Shape, type ShapeProp, type ShapeSet } from './shacl';
import { newNodeShape, topShapes } from './shapes';
import { uid, type Model } from './types';

/**
 * Shapes proposed from the ontology (roadmap stage SH-3, ADR-020). An axiom and a shape answer
 * different questions: the axiom says what holds of the world, under the open world and without
 * taking different names for different things, and licenses conclusions; a shape says what the
 * data of a graph must state. So nothing here becomes a shape by itself. Each proposal says what
 * its axiom means in OWL, what the shape would check, and where the two differ; the user accepts
 * them, one by one or by kind, into a shape set they choose. An accepted shape keeps the axiom it
 * came from (FROM_AXIOM, in OWL functional syntax), which travels with it in Turtle, and is stale
 * once the ontology no longer states that axiom.
 *
 * The axioms are read from the ontology as it is written (toTurtle), so a restriction drawn on the
 * canvas and one typed as a class axiom are proposed alike.
 */

/** What an accepted shape says it came from: the axiom, in OWL functional syntax with full IRIs. */
export const FROM_AXIOM = CW_SHAPES + 'fromAxiom';

export type ProposalGroup = 'Restrictions' | 'Domains and ranges' | 'Characteristics' | 'Enumerations';
export const PROPOSAL_GROUPS: ProposalGroup[] = ['Restrictions', 'Domains and ranges', 'Characteristics', 'Enumerations'];

/** Whom a proposed shape is for: the instances of a class, or what uses a property, or what is a value of one. */
export interface ProposalTarget {
  /** sh:targetClass, sh:targetSubjectsOf or sh:targetObjectsOf, by its local name. */
  kind: 'targetClass' | 'targetSubjectsOf' | 'targetObjectsOf';
  iri: string;
}

export interface Proposal {
  /** The axiom and the part of it: unique among the proposals of a model. */
  id: string;
  group: ProposalGroup;
  /** The axiom, in OWL functional syntax with full IRIs: what an accepted shape says it came from. */
  origin: string;
  /** The axiom as the editor writes it, in Manchester syntax. */
  axiom: string;
  /** The classes it is about, by IRI, for proposing for a class or a few. */
  classes: string[];
  target: ProposalTarget;
  /** A property shape on this path, or, without one, constraints of the node shape itself. */
  path?: ShaclPath;
  constraints: ShapeProp[];
  /** The shapes the constraints point at (a qualified value shape). */
  inline: Shape[];
  /** What the axiom means in OWL, what the shape would check, and where the two differ. */
  owl: string;
  shacl: string;
  differ: string;
}

/** An axiom that could be read but gives no shape, and why. */
export interface NotProposed {
  origin: string;
  axiom: string;
  classes: string[];
  why: string;
}

export interface Proposals {
  proposals: Proposal[];
  notProposed: NotProposed[];
  /** Every axiom an accepted shape could have come from: one that is not here is stale. */
  origins: Set<string>;
}

/** What a filler requires of each value: constraints, the shapes they point at, and the same in words. */
interface Filler {
  props: ShapeProp[];
  inline: Shape[];
  words: string;
}

const term = (iri: string): RdfTerm => ({ termType: 'NamedNode', value: iri });
const int = (n: number): ShaclValue => ({ lit: String(n), dt: XSD + 'integer' });
const sh = (local: string, v: ShaclValue): ShapeProp => ({ p: SH + local, v });
const literal = (l: Literal): ShaclTerm => ({ lit: l.value, ...(l.lang ? { lang: l.lang } : l.datatype ? { dt: l.datatype } : {}) });
const pathOfProperty = (p: ObjectPropertyExpression | { type: 'DataProperty'; iri: string }): ShaclPath => (p.type === 'ObjectInverseOf' ? { inverse: { iri: p.property.iri } } : { iri: p.iri });
const FACETS: Record<string, string> = Object.fromEntries(['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive', 'minLength', 'maxLength', 'pattern'].map((f) => [XSD + f, f]));

/** Every proposal the ontology gives, and what it states that gives none. Worked out once for each model. */
export function proposeShapes(model: Model): Proposals {
  const kept = cache.get(model);
  if (kept) return kept;
  const found = propose(model);
  cache.set(model, found);
  return found;
}
const cache = new WeakMap<Model, Proposals>();

function propose(model: Model): Proposals {
  const out: Proposals = { proposals: [], notProposed: [], origins: new Set() };
  if (model.mode === 'skos') return out;
  let quads: { subject: RdfTerm; predicate: RdfTerm; object: RdfTerm }[];
  try {
    quads = new Parser().parse(toTurtle(model)) as never;
  } catch {
    return out;
  }
  const declared = new Map<string, 'object' | 'data'>();
  for (const q of quads) if (q.predicate.value === RDF + 'type' && (q.object.value === OWL + 'ObjectProperty' || q.object.value === OWL + 'DatatypeProperty')) declared.set(q.subject.value, q.object.value === OWL + 'ObjectProperty' ? 'object' : 'data');
  const g: Graph = graphOf(quads as never, (p) => declared.get(p));
  const naming = namingFor(model);
  const n = { cls: (iri: string) => naming.name(iri, 'class'), obj: (iri: string) => naming.name(iri, 'object'), data: (iri: string) => naming.name(iri, 'data') };
  const propName = (p: ObjectPropertyExpression | { type: 'DataProperty'; iri: string }) => (p.type === 'ObjectInverseOf' ? `inverse ${n.obj(p.property.iri)}` : p.type === 'DataProperty' ? n.data(p.iri) : n.obj(p.iri));
  const fs = (e: ClassExpression | DataRange) => {
    try {
      return functionalSyntax(e);
    } catch {
      return undefined;
    }
  };
  const add = (p: Omit<Proposal, 'id'>, part: string) => {
    out.origins.add(p.origin);
    out.proposals.push({ ...p, id: `${p.origin}#${part}` });
  };
  const not = (x: NotProposed) => {
    out.origins.add(x.origin);
    out.notProposed.push(x);
  };

  /** A class as a noun with its article: "a Film", "an Actor". */
  const a = (name: string) => `${/^'?[aeiouAEIOU]/.test(name) ? 'an' : 'a'} ${name}`;
  /**
   * What a filler requires of each value, with the shapes that says it needs: a named class, every
   * one of several, or one of several (sh:or); or why it cannot be said in a shape here.
   */
  const classFiller = (f: ClassExpression | undefined): Filler | string => {
    if (!f || (f.type === 'Class' && f.iri === OWL + 'Thing')) return { props: [], inline: [], words: '' };
    if (f.type === 'Class') return { props: [sh('class', { iri: f.iri })], inline: [], words: a(n.cls(f.iri)) };
    const named = (f.type === 'ObjectIntersectionOf' || f.type === 'ObjectUnionOf') && f.operands.every((x) => x.type === 'Class') ? (f.operands as { iri: string }[]).map((x) => x.iri) : undefined;
    if (named && f.type === 'ObjectIntersectionOf') return { props: named.map((iri) => sh('class', { iri })), inline: [], words: named.map((iri) => a(n.cls(iri))).join(' and ') };
    if (named) {
      const inline = named.map((iri): Shape => ({ id: uid(), props: [sh('class', { iri })] }));
      const words = named.map((iri) => a(n.cls(iri)));
      return { props: [sh('or', { list: inline.map((x) => ({ shape: x.id })) })], inline, words: `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}` };
    }
    return 'Its filler is a class expression other than a named class, or several of them joined by “and” or “or”: it would need a shape of its own, which is for you to write.';
  };
  const dataFiller = (r: DataRange | undefined): ShapeProp[] | string => {
    if (!r || (r.type === 'Datatype' && r.iri === RDFS + 'Literal')) return [];
    if (r.type === 'Datatype') {
      // A datatype defined by its values (an enumerated datatype) is checked by them.
      const defined = g.objects(term(r.iri), OWL + 'equivalentClass').map((x) => readDataRange(g, x)).find((x) => x.type === 'DataOneOf');
      return defined?.type === 'DataOneOf' ? [sh('in', { list: defined.literals.map(literal) })] : [sh('datatype', { iri: r.iri })];
    }
    if (r.type === 'DataOneOf') return [sh('in', { list: r.literals.map(literal) })];
    if (r.type === 'DatatypeRestriction') {
      const out: ShapeProp[] = [sh('datatype', { iri: r.datatype })];
      for (const f of r.facets) {
        if (f.facet === XSD + 'length') out.push(sh('minLength', literal(f.value)), sh('maxLength', literal(f.value)));
        else if (FACETS[f.facet]) out.push(sh(FACETS[f.facet], literal(f.value)));
        else return `Its facet ${f.facet} has no SHACL Core constraint.`;
      }
      return out;
    }
    return 'Its data range is an expression that SHACL Core has no single constraint for.';
  };

  const asFiller = (props: ShapeProp[] | string, r: DataRange | undefined): Filler | string => (typeof props === 'string' ? props : { props, inline: [], words: props.length && r ? `of ${dataText(r, naming)}` : '' });

  // ------------------------------------------------------------ restrictions: what a class's members have
  const restriction = (cls: string, e: ClassExpression, kind: ClassAxiomKind, origin: string, axiom: string, part: number) => {
    const C = n.cls(cls);
    const defined = kind === 'EquivalentClasses';
    const asDefinition = defined ? ` As a definition it also works the other way: whatever meets it is ${a(C)}.` : '';
    const notClassified = defined ? ` SHACL does not classify: it checks only what the data says is ${a(C)}.` : '';
    const skip = (why: string) => not({ origin, axiom, classes: [cls], why });
    const base = { group: 'Restrictions' as const, origin, axiom, classes: [cls], target: { kind: 'targetClass' as const, iri: cls } };
    switch (e.type) {
      case 'ObjectSomeValuesFrom':
      case 'DataSomeValuesFrom':
      case 'ObjectMinCardinality':
      case 'DataMinCardinality':
      case 'ObjectMaxCardinality':
      case 'DataMaxCardinality':
      case 'ObjectExactCardinality':
      case 'DataExactCardinality': {
        const data = e.type.startsWith('Data');
        const filler = data ? asFiller(dataFiller(e.filler as DataRange | undefined), e.filler as DataRange | undefined) : classFiller(e.filler as ClassExpression | undefined);
        if (typeof filler === 'string') return skip(filler);
        const some = e.type.endsWith('SomeValuesFrom');
        const count = some ? 1 : (e as { n: number }).n;
        const min = some || e.type.includes('Min') || e.type.includes('Exact');
        const max = e.type.includes('Max') || e.type.includes('Exact');
        const P = propName(e.property);
        const F = filler.words;
        const plural = count !== 1;
        const that = F ? ` that ${plural ? 'are each' : 'is'} ${F}` : '';
        // Values of any kind are counted as they are; values of a kind, through a shape for that kind.
        const inline = filler.props.length ? [{ id: uid(), props: filler.props }, ...filler.inline] : [];
        const constraints = filler.props.length
          ? [sh('qualifiedValueShape', { shape: inline[0].id }), ...(min ? [sh('qualifiedMinCount', int(count))] : []), ...(max ? [sh('qualifiedMaxCount', int(count))] : [])]
          : [...(min ? [sh('minCount', int(count))] : []), ...(max ? [sh('maxCount', int(count))] : [])];
        const how = min && max ? `exactly ${count}` : min ? `at least ${some ? 'one' : count}` : `at most ${count}`;
        const values = `${how} value${plural ? 's' : ''} of ${P}${that}`;
        add(
          {
            ...base,
            path: pathOfProperty(e.property),
            constraints,
            inline,
            owl: `Every ${C} has ${values}.${min ? ' Where the data names too few, OWL concludes the others exist, unnamed: nothing is wrong.' : ''}${max ? ' Where the data names more, OWL concludes that some of the names are of the same individual; only names known to be different make it a contradiction.' : ''}${asDefinition}`,
            shacl: `Every ${C} in the data has ${values}.`,
            differ: `SHACL counts the values the data states, each name as one value${min ? ', and reports the ones missing' : ''}${max ? ', and reports too many at once' : ''}; OWL ${min && max ? 'concludes values that are missing, and may take two names for one individual' : min ? 'concludes the values that are missing' : 'first takes the names for fewer individuals'}.${F && !data ? ` A value counts as ${F} in SHACL only where the data states its type.` : ''}${notClassified}`,
          },
          String(part),
        );
        return;
      }
      case 'ObjectAllValuesFrom':
      case 'DataAllValuesFrom': {
        const data = e.type === 'DataAllValuesFrom';
        const filler = data ? asFiller(dataFiller(e.filler as DataRange), e.filler as DataRange) : classFiller(e.filler as ClassExpression);
        if (typeof filler === 'string') return skip(filler);
        if (!filler.props.length) return skip('It allows values of any kind: there is nothing for a shape to check.');
        const P = propName(e.property);
        const F = filler.words;
        add(
          {
            ...base,
            path: pathOfProperty(e.property),
            constraints: filler.props,
            inline: filler.inline,
            owl: data ? `Every value of ${P} of ${a(C)} is ${F}; one that is not makes the ontology inconsistent.${asDefinition}` : `Every value of ${P} of ${a(C)} is ${F}: OWL concludes that it is, whatever the data says of it.${asDefinition}`,
            shacl: data ? `Every value of ${P} of ${a(C)} in the data is ${F}.` : `Every value of ${P} of ${a(C)} in the data is stated to be ${F}.`,
            differ: data ? `Close: both reject a value of another datatype. SHACL takes a literal as written, OWL by its value: an xsd:int is an xsd:integer to OWL, not to SHACL.${notClassified}` : `OWL concludes the type of a value; SHACL requires the data to state it. ${a(C).replace(/^a/, 'A')} without any value of ${P} meets both.${notClassified}`,
          },
          String(part),
        );
        return;
      }
      case 'ObjectHasValue':
      case 'DataHasValue': {
        const P = propName(e.property);
        const value: ShaclValue = e.type === 'ObjectHasValue' ? { iri: e.individual.iri } : literal(e.value);
        const A = e.type === 'ObjectHasValue' ? naming.name(e.individual.iri, 'individual') : literalText(e.value, naming);
        add(
          {
            ...base,
            path: pathOfProperty(e.property),
            constraints: [sh('hasValue', value)],
            inline: [],
            owl: `Every ${C} has ${A} as a value of ${P}: OWL concludes it, stated or not.${asDefinition}`,
            shacl: `Every ${C} in the data states ${A} as a value of ${P}.`,
            differ: `OWL concludes the value; SHACL requires the data to state it.${notClassified}`,
          },
          String(part),
        );
        return;
      }
      case 'ObjectHasSelf':
        return skip('SHACL Core cannot compare a value with the node it is of.');
      default:
        return undefined;
    }
  };

  /** A class's axioms with an expression: its restrictions, also inside an intersection, and its enumeration. */
  for (const q of quads) {
    const kind: ClassAxiomKind | undefined = q.predicate.value === RDFS + 'subClassOf' ? 'SubClassOf' : q.predicate.value === OWL + 'equivalentClass' ? 'EquivalentClasses' : undefined;
    if (!kind || q.subject.termType !== 'NamedNode' || q.object.termType !== 'BlankNode') continue;
    // Datatypes defined by their values are equivalent to a data range, not a class: they are read where they are used.
    if (g.objects(q.subject, RDF + 'type').some((t) => t.value === RDFS + 'Datatype')) continue;
    const cls = q.subject.value;
    const e = readClass(g, q.object);
    if (e.type === 'Unparsed') continue;
    const syntax = fs(e);
    if (!syntax) continue;
    const origin = axiomFunctionalSyntax(cls, { kind, expression: e });
    const axiom = `${n.cls(cls)} ${kind === 'SubClassOf' ? 'SubClassOf' : 'EquivalentTo'} ${classText(e, naming)}`;
    if (e.type === 'ObjectOneOf' && kind === 'EquivalentClasses') {
      const C = n.cls(cls);
      const list = e.individuals.map((i) => naming.name(i.iri, 'individual'));
      add(
        {
          group: 'Enumerations',
          origin,
          axiom,
          classes: [cls],
          target: { kind: 'targetClass', iri: cls },
          constraints: [sh('in', { list: e.individuals.map((i) => ({ iri: i.iri })) })],
          inline: [],
          owl: `The ${C}s are ${list.join(', ')}, and nothing else: whatever is a ${C} is one of them, perhaps under another name.`,
          shacl: `Every ${C} in the data is one of ${list.join(', ')}.`,
          differ: `A ${C} under another name is one of them to OWL, and a violation to SHACL, which compares the names as written.`,
        },
        'in',
      );
      continue;
    }
    const parts = e.type === 'ObjectIntersectionOf' ? e.operands : [e];
    parts.forEach((x, i) => restriction(cls, x, kind, origin, axiom, i));
  }

  // ------------------------------------------------------------ domains and ranges, characteristics
  for (const [p, kind] of declared) {
    const P = kind === 'object' ? n.obj(p) : n.data(p);
    const fsKind = kind === 'object' ? 'Object' : 'Data';
    const domains = g.objects(term(p), RDFS + 'domain');
    const domainClasses = domains.flatMap((d) => namedClasses(readClass(g, d)));
    for (const d of domains) {
      const e = readClass(g, d);
      const syntax = fs(e);
      if (!syntax) continue;
      const origin = `${fsKind}PropertyDomain(<${p}> ${syntax})`;
      const axiom = `${P} Domain ${classText(e, naming)}`;
      const filler = classFiller(e);
      if (typeof filler === 'string' || !filler.props.length) {
        not({ origin, axiom, classes: namedClasses(e), why: typeof filler === 'string' ? filler : 'It allows subjects of any kind: there is nothing for a shape to check.' });
        continue;
      }
      const C = filler.words;
      add(
        {
          group: 'Domains and ranges',
          origin,
          axiom,
          classes: namedClasses(e),
          target: { kind: 'targetSubjectsOf', iri: p },
          constraints: filler.props,
          inline: filler.inline,
          owl: `Whatever has a value of ${P} is ${C}: OWL concludes it, so using ${P} never makes the data wrong.`,
          shacl: `Whatever has a value of ${P} in the data is stated to be ${C}.`,
          differ: `In OWL a domain classifies what uses the property; in SHACL it constrains it. A subject of ${P} not typed so is fine in OWL and a violation here.`,
        },
        'domain',
      );
    }
    for (const r of g.objects(term(p), RDFS + 'range')) {
      if (kind === 'object') {
        const e = readClass(g, r);
        const syntax = fs(e);
        if (!syntax) continue;
        const origin = `ObjectPropertyRange(<${p}> ${syntax})`;
        const axiom = `${P} Range ${classText(e, naming)}`;
        const filler = classFiller(e);
        if (typeof filler === 'string' || !filler.props.length) {
          not({ origin, axiom, classes: [...namedClasses(e), ...domainClasses], why: typeof filler === 'string' ? filler : 'It allows values of any kind: there is nothing for a shape to check.' });
          continue;
        }
        const D = filler.words;
        add(
          {
            group: 'Domains and ranges',
            origin,
            axiom,
            classes: [...namedClasses(e), ...domainClasses],
            target: { kind: 'targetSubjectsOf', iri: p },
            path: { iri: p },
            constraints: filler.props,
            inline: filler.inline,
            owl: `Every value of ${P} is ${D}: OWL concludes it.`,
            shacl: `Every value of ${P} in the data is stated to be ${D}.`,
            differ: `In OWL a range classifies the values; in SHACL it constrains them. A value not typed so is fine in OWL and a violation here.`,
          },
          'range',
        );
      } else {
        const e = readDataRange(g, r);
        const syntax = fs(e);
        if (!syntax) continue;
        const origin = `DataPropertyRange(<${p}> ${syntax})`;
        const axiom = `${P} Range ${dataText(e, naming)}`;
        const filler = dataFiller(e);
        if (typeof filler === 'string' || !filler.length) {
          not({ origin, axiom, classes: domainClasses, why: typeof filler === 'string' ? filler : 'It allows values of any kind: there is nothing for a shape to check.' });
          continue;
        }
        const D = dataText(e, naming);
        const listed = filler.some((x) => x.p === SH + 'in');
        add(
          {
            group: 'Domains and ranges',
            origin,
            axiom,
            classes: domainClasses,
            target: { kind: 'targetSubjectsOf', iri: p },
            path: { iri: p },
            constraints: filler,
            inline: [],
            owl: `Every value of ${P} is of ${D}; one that is not makes the ontology inconsistent.`,
            shacl: `Every value of ${P} in the data is of ${D}.`,
            differ: listed ? `Close: both reject a value not on the list. SHACL compares the values as written: "01"^^xsd:integer is not 1 to it, as it is to OWL.` : `Close: both reject a value of another datatype. SHACL takes a literal as written, OWL by its value: an xsd:int is an xsd:integer to OWL, not to SHACL.`,
          },
          'range',
        );
      }
    }
    const types = g.objects(term(p), RDF + 'type').map((t) => t.value);
    if (types.includes(OWL + 'FunctionalProperty')) {
      add(
        {
          group: 'Characteristics',
          origin: `Functional${fsKind}Property(<${p}>)`,
          axiom: `${P} Characteristics: Functional`,
          classes: domainClasses,
          target: { kind: 'targetSubjectsOf', iri: p },
          path: { iri: p },
          constraints: [sh('maxCount', int(1))],
          inline: [],
          owl: kind === 'object' ? `Nothing has more than one value of ${P}: two names as its values are concluded to name one individual.` : `Nothing has more than one value of ${P}: two different values make the ontology inconsistent.`,
          shacl: `Nothing in the data has more than one value of ${P}.`,
          differ: kind === 'object' ? 'SHACL reports two names as two values; OWL takes them for one individual unless they are known to be different.' : 'Close: both reject two different values. SHACL also rejects two literals OWL takes for one value, such as "1" and "01" as integers.',
        },
        'functional',
      );
    }
    if (kind === 'object' && types.includes(OWL + 'InverseFunctionalProperty')) {
      add(
        {
          group: 'Characteristics',
          origin: `InverseFunctionalObjectProperty(<${p}>)`,
          axiom: `${P} Characteristics: InverseFunctional`,
          classes: [],
          target: { kind: 'targetObjectsOf', iri: p },
          path: { inverse: { iri: p } },
          constraints: [sh('maxCount', int(1))],
          inline: [],
          owl: `Nothing is a value of ${P} of more than one thing: two things with the same value are concluded to be one.`,
          shacl: `Nothing in the data is a value of ${P} of more than one node.`,
          differ: 'SHACL reports two names as two nodes; OWL concludes that they name one individual.',
        },
        'inverseFunctional',
      );
    }
  }

  // ------------------------------------------------------------ keys: read, and said why they give no shape
  for (const q of quads) {
    if (q.predicate.value !== OWL + 'hasKey' || q.subject.termType !== 'NamedNode') continue;
    const props: string[] = [];
    for (let cell: RdfTerm | undefined = q.object; cell && cell.value !== RDF + 'nil'; cell = g.objects(cell, RDF + 'rest')[0]) {
      const first = g.objects(cell, RDF + 'first')[0];
      if (!first) break;
      props.push(first.value);
    }
    const objects = props.filter((p) => declared.get(p) !== 'data');
    const datas = props.filter((p) => declared.get(p) === 'data');
    const C = n.cls(q.subject.value);
    not({
      origin: `HasKey(<${q.subject.value}> (${objects.map((p) => `<${p}>`).join(' ')}) (${datas.map((p) => `<${p}>`).join(' ')}))`,
      axiom: `${C} HasKey ${props.map((p) => (declared.get(p) === 'data' ? n.data(p) : n.obj(p))).join(', ')}`,
      classes: [q.subject.value],
      why: `A key says that two named ${C}s with the same values of its properties are the same individual. SHACL Core cannot compare one node with another; that takes SHACL-SPARQL (stage SH-5).`,
    });
  }
  return out;
}

/** The proposals about any of these classes (by IRI); every one when none are given. */
export const proposalsFor = (all: Proposals, classes: string[] | null): Proposals =>
  classes ? { proposals: all.proposals.filter((p) => p.classes.some((c) => classes.includes(c))), notProposed: all.notProposed.filter((p) => p.classes.some((c) => classes.includes(c))), origins: all.origins } : all;

/** The axioms the shapes of a set say they came from. */
export const originsOf = (s: Shape): string[] => s.props.filter((x) => x.p === FROM_AXIOM && 'lit' in x.v).map((x) => (x.v as { lit: string }).lit);

/** Whether a set has the shape a proposal would add: one from the same axiom, on the same path or on none. */
export function alreadyIn(set: ShapeSet, p: Proposal): boolean {
  const key = p.path ? JSON.stringify(p.path) : '';
  return set.shapes.some((s) => originsOf(s).includes(p.origin) && JSON.stringify(s.props.find((x) => x.p === SH + 'path' && 'path' in x.v)?.v ?? '') === (key ? JSON.stringify({ path: p.path }) : '""'));
}

const TARGET_NAME: Record<ProposalTarget['kind'], (name: string) => string> = {
  targetClass: (name) => name,
  targetSubjectsOf: (name) => `Subjects of ${name}`,
  targetObjectsOf: (name) => `Values of ${name}`,
};

/**
 * The set with the proposals accepted, as one edit: each that is about a path a property shape,
 * inside the node shape from the ontology for its target (made when the set has none); each that
 * is about the node itself a node shape of its own. Every shape made says which axiom it came from.
 * A proposal the set has already is left out.
 */
export function withProposals(model: Model, set: ShapeSet, accepted: Proposal[]): { set: ShapeSet; shapes: number } {
  let next = set;
  let made = 0;
  const naming = namingFor(model);
  const nameOf = (t: ProposalTarget) => TARGET_NAME[t.kind](naming.name(t.iri, t.kind === 'targetClass' ? 'class' : 'object').replace(/^'|'$/g, ''));
  const modelWith = () => ({ ...model, shapeSets: [...model.shapeSets.filter((s) => s.id !== set.id), next] });
  const from = (p: Proposal): ShapeProp => ({ p: FROM_AXIOM, v: { lit: p.origin } });
  const hasTarget = (s: Shape, t: ProposalTarget) => s.props.some((x) => x.p === SH + t.kind && 'iri' in x.v && x.v.iri === t.iri);
  for (const p of accepted) {
    if (alreadyIn(next, p)) continue;
    const label = `${nameOf(p.target)} (from the ontology)`;
    // Inline shapes are fresh for each acceptance: the proposal's own are only a picture of them.
    const ids = new Map(p.inline.map((s) => [s.id, uid()]));
    const fresh = (v: ShaclValue): ShaclValue => ('shape' in v && ids.has(v.shape) ? { shape: ids.get(v.shape)! } : 'list' in v ? { list: v.list.map(fresh) } : v);
    const inline = p.inline.map((s) => ({ id: ids.get(s.id)!, props: s.props.map((x) => ({ ...x, v: fresh(x.v) })) }));
    const constraints = p.constraints.map((x) => ({ ...x, v: fresh(x.v) }));
    if (!p.path) {
      // A shape of the node itself, of its own: named for what it is, the domain of a property or the members of a class.
      const what = `${p.group === 'Enumerations' ? 'Members of' : 'Domain of'} ${naming.name(p.target.iri, p.target.kind === 'targetClass' ? 'class' : 'object').replace(/^'|'$/g, '')}`;
      const shape = newNodeShape(modelWith(), next, what);
      shape.props = [...shape.props.filter((x) => x.p !== RDFS + 'label'), { p: RDFS + 'label', v: { lit: `${what} (from the ontology)` } }, sh(p.target.kind, { iri: p.target.iri }), ...constraints, from(p)];
      next = { ...next, shapes: [...next.shapes, shape, ...inline] };
      made++;
      continue;
    }
    const property: Shape = { id: uid(), props: [{ p: SH + 'path', v: { path: p.path } }, ...constraints, from(p)] };
    // The node shape from the ontology for this target: one that targets it and has shapes that came from axioms.
    const owner = topShapes(next).find((s) => hasTarget(s, p.target) && s.props.some((x) => x.p === SH + 'property' && 'shape' in x.v && originsOf(next.shapes.find((y) => y.id === (x.v as { shape: string }).shape) ?? { id: '', props: [] }).length));
    if (owner) {
      next = { ...next, shapes: [...next.shapes.map((s) => (s.id === owner.id ? { ...s, props: [...s.props, sh('property', { shape: property.id })] } : s)), property, ...inline] };
    } else {
      const shape = newNodeShape(modelWith(), next, nameOf(p.target), p.target.kind === 'targetClass' ? p.target.iri : undefined);
      shape.props = [...shape.props.filter((x) => x.p !== RDFS + 'label'), { p: RDFS + 'label', v: { lit: label } }, ...(p.target.kind === 'targetClass' ? [] : [sh(p.target.kind, { iri: p.target.iri })]), sh('property', { shape: property.id })];
      next = { ...next, shapes: [...next.shapes, shape, property, ...inline] };
    }
    made++;
  }
  return { set: next, shapes: made };
}

/** A proposal's shape as Turtle would say it, with names: for showing what accepting it adds. */
export function proposalText(p: Proposal, name: (iri: string) => string): string {
  const value = (v: ShaclValue): string =>
    'iri' in v
      ? name(v.iri)
      : 'lit' in v
        ? v.dt === XSD + 'integer' && /^-?\d+$/.test(v.lit)
          ? v.lit
          : JSON.stringify(v.lit) + (v.lang ? '@' + v.lang : v.dt && v.dt !== XSD + 'string' ? '^^' + name(v.dt) : '')
        : 'list' in v
          ? `( ${v.list.map(value).join(' ')} )`
          : 'shape' in v
            ? `[ ${(p.inline.find((s) => s.id === v.shape)?.props ?? []).map((x) => `sh:${x.p.slice(SH.length)} ${value(x.v)}`).join(' ; ')} ]`
            : '';
  const lines = p.constraints.map((x) => `sh:${x.p.slice(SH.length)} ${value(x.v)}`);
  const target = `sh:${p.target.kind} ${name(p.target.iri)}`;
  return p.path ? `${target} ; sh:property [ sh:path ${pathToSparql(p.path, name)} ; ${lines.join(' ; ')} ]` : `${target} ; ${lines.join(' ; ')}`;
}

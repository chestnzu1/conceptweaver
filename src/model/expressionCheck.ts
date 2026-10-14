import { keyOfRange, namedProperty, RDF, RDFS, XSD, type ClassExpression, type DataRange, type Literal } from './expressions';
import { validateLiteral } from './literals';
import type { Naming } from './manchester';

/**
 * Whether an expression says something OWL 2 DL allows of the entities it names, as the model
 * has them. What it checks:
 *
 * - an object property where a data property has to be, or the other way round, and a datatype
 *   where a class has to be: OWL 2 DL does not let one IRI be both, so these are errors;
 * - a class that the model has only as an individual or a property, and an individual that it
 *   has only as a class: OWL 2 allows one IRI for both (punning), so these are warnings, in
 *   case it was not meant;
 * - a facet a datatype does not have (a length on a number), and a literal that is not of its
 *   datatype ("abc"^^xsd:integer): errors.
 *
 * It is not reasoning: whether the expression can have members at all is the OWL 2 DL reasoner's
 * to say (an unsatisfiable class is a logical problem, not one of how the expression is written).
 */
export interface ExpressionIssue {
  severity: 'error' | 'warning';
  message: string;
}

/** The facets each family of datatypes has (OWL 2 datatype map). */
const NUMERIC = ['decimal', 'integer', 'nonNegativeInteger', 'positiveInteger', 'negativeInteger', 'nonPositiveInteger', 'long', 'int', 'short', 'byte', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte', 'double', 'float'].map((x) => XSD + x).concat(['http://www.w3.org/2002/07/owl#real', 'http://www.w3.org/2002/07/owl#rational']);
const TIMES = ['dateTime', 'dateTimeStamp', 'date', 'time', 'gYear', 'gYearMonth', 'gMonth', 'gMonthDay', 'gDay', 'duration'].map((x) => XSD + x);
const TEXT = ['string', 'normalizedString', 'token', 'language', 'Name', 'NCName', 'NMTOKEN', 'anyURI', 'hexBinary', 'base64Binary'].map((x) => XSD + x).concat([RDF + 'PlainLiteral', RDF + 'langString']);
const ORDER = ['minInclusive', 'minExclusive', 'maxInclusive', 'maxExclusive'].map((x) => XSD + x);
const LENGTH = ['length', 'minLength', 'maxLength', 'pattern'].map((x) => XSD + x);
function facetsOf(datatype: string): string[] | undefined {
  if (NUMERIC.includes(datatype) || TIMES.includes(datatype)) return ORDER;
  if (TEXT.includes(datatype)) return datatype === RDF + 'PlainLiteral' ? [...LENGTH, RDF + 'langRange'] : LENGTH;
  if (datatype === RDFS + 'Literal' || datatype === XSD + 'boolean') return [];
  return undefined;
}

export function checkExpression(e: ClassExpression | DataRange, n: Naming): ExpressionIssue[] {
  const out: ExpressionIssue[] = [];
  const say = (severity: ExpressionIssue['severity'], message: string) => out.push({ severity, message });
  const kinds = (iri: string) => n.kindsOf(iri);
  const named = (iri: string, kind: Parameters<Naming['name']>[1]) => n.name(iri, kind);
  const literal = (l: Literal, where: string) => {
    if (!l.datatype) return;
    const bad = validateLiteral(l.value, keyOfRange({ type: 'Datatype', iri: l.datatype }));
    if (bad) say('error', `${where}: ${bad}`);
  };
  const walk = (x: ClassExpression | DataRange): void => {
    switch (x.type) {
      case 'Class': {
        const k = kinds(x.iri);
        if (k.length && !k.includes('class')) say(k.includes('datatype') ? 'error' : 'warning', k.includes('datatype') ? `${named(x.iri, 'datatype')} is a datatype: it cannot stand for a class.` : `${named(x.iri, k[0])} is ${k[0] === 'individual' ? 'an individual' : 'a property'} in this model, not a class. OWL allows one IRI for both, but check it is meant.`);
        return;
      }
      case 'Datatype': {
        const k = kinds(x.iri);
        if (k.length && !k.includes('datatype')) say('error', `${named(x.iri, k[0])} is ${k[0] === 'class' ? 'a class' : k[0] === 'individual' ? 'an individual' : 'a property'} in this model, not a datatype.`);
        return;
      }
      case 'ObjectIntersectionOf':
      case 'ObjectUnionOf':
        return x.operands.forEach(walk);
      case 'DataIntersectionOf':
      case 'DataUnionOf':
        return x.operands.forEach(walk);
      case 'ObjectComplementOf':
      case 'DataComplementOf':
        return walk(x.operand);
      case 'ObjectOneOf':
        for (const i of x.individuals) if (kinds(i.iri).length && !kinds(i.iri).includes('individual')) say('warning', `${named(i.iri, kinds(i.iri)[0])} is not an individual in this model. OWL allows one IRI for a class and an individual, but check it is meant.`);
        return;
      case 'ObjectSomeValuesFrom':
      case 'ObjectAllValuesFrom':
      case 'ObjectHasValue':
      case 'ObjectHasSelf':
      case 'ObjectMinCardinality':
      case 'ObjectMaxCardinality':
      case 'ObjectExactCardinality': {
        const iri = namedProperty(x.property);
        const k = kinds(iri);
        if (k.includes('data') && !k.includes('object')) say('error', `${named(iri, 'data')} is a data property: it cannot be restricted as an object property, and has no inverse.`);
        if (x.type === 'ObjectHasValue' && kinds(x.individual.iri).length && !kinds(x.individual.iri).includes('individual')) say('warning', `${named(x.individual.iri, kinds(x.individual.iri)[0])} is not an individual in this model.`);
        if ('filler' in x && x.filler) walk(x.filler);
        return;
      }
      case 'DataSomeValuesFrom':
      case 'DataAllValuesFrom':
      case 'DataHasValue':
      case 'DataMinCardinality':
      case 'DataMaxCardinality':
      case 'DataExactCardinality': {
        const k = kinds(x.property.iri);
        if (k.includes('object') && !k.includes('data')) say('error', `${named(x.property.iri, 'object')} is an object property: its values are individuals, not literals.`);
        if (x.type === 'DataHasValue') literal(x.value, `The value of ${named(x.property.iri, 'data')}`);
        if ('filler' in x && x.filler) walk(x.filler);
        return;
      }
      case 'DataOneOf':
        for (const l of x.literals) literal(l, 'A listed value');
        return;
      case 'DatatypeRestriction': {
        walk({ type: 'Datatype', iri: x.datatype });
        const has = facetsOf(x.datatype);
        for (const f of x.facets) {
          if (has && !has.includes(f.facet)) say('error', `${named(x.datatype, 'datatype')} has no facet ${f.facet.replace(XSD, 'xsd:').replace(RDF, 'rdf:')}${has.length ? `: it has ${has.map((h) => h.replace(XSD, 'xsd:').replace(RDF, 'rdf:')).join(', ')}` : ''}.`);
          literal(f.value, `The value of ${f.facet.replace(XSD, 'xsd:')}`);
        }
        return;
      }
      default:
        return;
    }
  };
  walk(e);
  return out;
}

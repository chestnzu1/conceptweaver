import { ontologyIriOf } from '../model/prefixes';
import type { Model } from '../model/types';
import { sameData, type Category, type DataGraph, type Finding, type ValidationReport } from './contracts';

/**
 * What the validation workbench shows of the checks, and the reports it writes: the engines and
 * what they do and do not do, in words, and a report as JSON or as RDF. Nothing here checks
 * anything.
 */

/**
 * Whether a report no longer describes what is in the editor: it is of another revision, of other
 * data, or of another choice of shapes. Moving terms on the canvas does not count.
 */
export function isStale(run: ValidationReport | null, revisionId: string, data: DataGraph, shapeSet?: string): boolean {
  return !!run && (run.revisionId !== revisionId || !sameData(run.data, data) || run.shapeSet !== shapeSet);
}

export const REASONER_LIMITS = [
  'It is a rule reasoner, not a complete OWL 2 DL reasoner: it finds the contradictions its rules reach, so “consistent” means none of those was found.',
  'Class expressions kept as text (unions, intersections, complements written as expressions, nested restrictions) are not interpreted.',
  'Restrictions are compared only when they are on the same property and the same class or datatype; a clash that needs the fillers’ hierarchy is not found.',
  'Literal values are compared as written: "1" and "01" count as two values.',
  'An enumeration is not reasoned with by cases. An instance of { A, B } is concluded to be A only once it is known to be different from B; what holds for A and for B alike is not concluded of it. Nothing is counted either: a class that needs three different values out of an enumeration of two is not found unsatisfiable, and two enumerations without a common member are not found disjoint.',
  'An enumerated datatype is used for one thing: a value an individual has for a property is checked against the list of that property’s range (a number by its value, anything else as written). Datatypes are not compared with each other, and an owl:oneOf kept as text inside another expression is not read.',
];

/** What an answer of the OWL 2 DL reasoner is and is not about, said where its results are shown. */
export const DL_LIMITS = [
  'HermiT is a complete OWL 2 DL reasoner: when it says “consistent”, that is proved for the ontology it was given.',
  'It is given the ontology exactly as the app exports it. What the app does not keep when it reads a file (property chains, keys, negative property assertions) is not in it.',
  'A relationship kept plain is not an OWL axiom, so it plays no part. Relationships that use an object property, restrictions, and expressions kept as text all do.',
  'An ontology outside OWL 2 DL (a transitive property in a cardinality restriction, for one) may be refused: the status is then “unknown”, and the violations are listed.',
  'Datatypes outside the OWL 2 datatype map (xsd:date, xsd:time, xsd:gYear, xsd:duration) have no meaning to it: their values are not checked or compared, and the result is marked partial.',
  'An imported ontology is reasoned over only if its content is in this browser; nothing is fetched. One that is missing is named, and the result is marked partial.',
  'Justifications are the reasoner’s own, one for each finding, worked out within a time limit; where there is none, that is said.',
];

/** What the SHACL engine supports, said as it is. */
export const SHACL_ENGINE = {
  name: 'rdf-validate-shacl',
  supports: 'SHACL Core: every Core target, property path and constraint component',
  not: ['SHACL-SPARQL constraints and SPARQL targets (sh:sparql, sh:SPARQLTarget): shapes using them are read but those parts are not checked.', 'SHACL Advanced Features (rules, functions, node expressions).', 'Entailment regimes (sh:entailment): the data graph is validated as given. The only inference is the one SHACL itself prescribes, rdfs:subClassOf for class targets and sh:class.'],
};

const CATEGORY_LABEL: Record<Category, string> = { owl: 'OWL', shacl: 'SHACL', quality: 'Quality' };
export const categoryLabel = (c: Category) => CATEGORY_LABEL[c];

/** The run as JSON: everything shown, without the model itself. */
export function reportJson(run: ValidationReport, model: Model): string {
  const { data, findings, shacl, dl, ontologyId: _o, revisionId: _r, fingerprint, ...rest } = run;
  return JSON.stringify(
    {
      ontology: { name: model.name, iri: ontologyIriOf(model) },
      validatedAt: new Date(run.at).toISOString(),
      // What was validated, as a fingerprint of its content: the same content, the same revision.
      revision: fingerprint,
      ...rest,
      at: undefined,
      // The OWL 2 DL reasoner's own answer, as it gave it, when the run used it.
      reasoner: dl?.report,
      shacl: shacl ? { ...shacl, report: undefined } : undefined,
      dataGraph: { source: data.source, name: data.name, includesOntologyTriples: data.source === 'model' || data.includeOntology },
      shapeSet: shacl?.shapeSet?.name ?? 'every shape set',
      findings: findings.map(({ fix, id: _id, ...f }) => ({ ...f, category: CATEGORY_LABEL[f.category], ...(fix ? { quickFix: fix.label } : {}) })),
    },
    null,
    2,
  );
}

/**
 * The run as RDF. SHACL results are the engine's own sh:ValidationReport, untouched. OWL and
 * quality findings are not SHACL results and are not dressed up as them: they are written with
 * a small vocabulary of the app's own.
 */
export function reportTurtle(run: ValidationReport, model: Model): string {
  const CW = 'https://conceptweaver.app/validation#';
  const lit = (s: string) => JSON.stringify(s);
  const node = (f: Finding) => (f.entity?.iri ? `<${f.entity.iri}>` : undefined);
  const own = run.findings.filter((f) => f.category !== 'shacl');
  const lines = [
    `@prefix cw: <${CW}> .`,
    '@prefix dcterms: <http://purl.org/dc/terms/> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    '[] a cw:ValidationRun ;',
    `    cw:ontology <${ontologyIriOf(model)}> ;`,
    `    dcterms:created "${new Date(run.at).toISOString()}"^^xsd:dateTime ;`,
    `    cw:revision ${lit(run.fingerprint)}${run.owl ? ` ;\n    cw:owlReasoner ${lit(run.owl.engineName)} ;\n    cw:owlStatus ${lit(run.owl.status)} ;\n    cw:owlStatusProved ${run.owl.proved} ;\n    cw:unsatisfiableClasses ${run.owl.unsatisfiable.length}` : ''}${own.length ? ' ;\n    cw:finding' : ' .'}`,
    ...own.map(
      (f, i) =>
        `        [ a cw:Finding ; cw:category ${lit(CATEGORY_LABEL[f.category])} ; cw:severity ${lit(f.severity)} ; cw:rule ${lit(f.rule)} ; cw:message ${lit(f.message)}${f.explanation ? ` ; cw:explanation ${lit(f.explanation)}` : ''}${node(f) ? ` ; cw:entity ${node(f)}` : ''} ]${i === own.length - 1 ? ' .' : ' ,'}`,
    ),
  ];
  return lines.join('\n') + '\n' + (run.shacl?.report ? '\n# ---- SHACL validation report, as the engine produced it\n\n' + run.shacl.report : '');
}

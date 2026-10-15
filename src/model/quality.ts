import { runChecks, type Severity } from './checks';
import { literalText, usersOf } from './datatypes';
import { metaProblems } from './governance';
import { baseIriOf } from './iri';
import { validateLiteral } from './literals';
import { isAbsoluteIri, STANDARD } from './prefixes';
import { nameKey } from './identity';
import { assertedSuperclasses, objectProperties, propLinks } from './props';
import { shapeReferences } from './shapes';
import { OWL, unparsedIn, type ClassAxiomKind } from './expressions';
import { classText, namingFor } from './manchester';

/** How each kind of class axiom is written in Manchester syntax, before its expression. */
const CLASS_AXIOM_WORDS: Record<ClassAxiomKind, string> = { SubClassOf: 'SubClassOf:', EquivalentClasses: 'EquivalentTo:', DisjointClasses: 'DisjointWith:' };
import { DATATYPES, PROP_LINKS, isLang, type Model, type QualityConfig, type Term } from './types';
import { resolveModel } from './vocab';
import { quoted } from './words';

/**
 * Modelling diagnostics: things worth a second look that are neither a logical contradiction
 * nor a broken data constraint. Every rule can be switched off, and none of them says the
 * ontology is wrong: a class without a definition, or a property without a range, is valid OWL.
 */

export type RuleGroup = 'Documentation' | 'Structure' | 'IRIs and namespaces' | 'Modelling practice' | 'Enumerations' | 'Governance' | 'SKOS integrity';

export interface QualityRule {
  id: string;
  group: RuleGroup;
  label: string;
  about: string;
  severity: Severity;
  /** On unless the user switches it off. Rules about taste are off until asked for. */
  default: boolean;
}

export const QUALITY_RULES: QualityRule[] = [
  { id: 'missing-label', group: 'Documentation', label: 'Missing label', about: 'An entity without a human-readable name.', severity: 'warning', default: true },
  { id: 'missing-definition', group: 'Documentation', label: 'Missing definition', about: 'A named entity without a description. Not every entity needs one.', severity: 'info', default: true },
  { id: 'duplicate-label', group: 'Documentation', label: 'Duplicate label', about: 'Two entities with the same name in the same language. They are still different entities: their IRIs differ.', severity: 'warning', default: true },
  { id: 'label-clash', group: 'Documentation', label: 'Label used twice', about: 'A synonym of one entity that is the name of another, or one label given to an entity in two roles.', severity: 'warning', default: true },
  { id: 'missing-language', group: 'Documentation', label: 'Missing language tag', about: 'Text without a language, in a model whose other text has one.', severity: 'info', default: true },
  { id: 'naming-convention', group: 'Documentation', label: 'Naming convention', about: 'An IRI written differently from most others of its kind, such as release_date among releaseDate, hasTitle.', severity: 'info', default: true },
  { id: 'annotation-practice', group: 'Documentation', label: 'Annotation names that differ only in spelling', about: 'Two annotation properties of your own whose names differ only in case, spaces or punctuation.', severity: 'info', default: true },

  { id: 'root-class', group: 'Structure', label: 'Class without an asserted superclass', about: 'A class directly under owl:Thing. Every hierarchy has some; switch this on to review them.', severity: 'info', default: false },
  { id: 'unused-entity', group: 'Structure', label: 'Unused entity', about: 'A term nothing refers to, or an object property that is declared but never used and has no domain or range.', severity: 'info', default: true },
  { id: 'redundant-subclass', group: 'Structure', label: 'Redundant superclass', about: 'A superclass that is stated directly and also follows through another stated superclass. Harmless, and sometimes deliberate.', severity: 'info', default: true },
  { id: 'subclass-cycle', group: 'Structure', label: 'Subclass cycle', about: 'Classes that are each other’s ancestors. OWL reads them as equivalent, which is seldom what was meant.', severity: 'warning', default: true },
  { id: 'multiple-inheritance', group: 'Structure', label: 'Multiple inheritance', about: 'A class with more than one asserted superclass. Perfectly valid; switch this on to review where it happens.', severity: 'info', default: false },
  { id: 'missing-domain-range', group: 'Structure', label: 'Missing domain or range', about: 'A property without a domain, a range or a datatype. Properties do not need them.', severity: 'info', default: true },
  { id: 'outside-domain-range', group: 'Structure', label: 'Use outside the declared domain or range', about: 'A class uses a property whose hand-set domain or range does not cover it.', severity: 'warning', default: true },
  { id: 'duplicate-axiom', group: 'Structure', label: 'Duplicate relationship', about: 'The same statement made twice.', severity: 'warning', default: true },
  { id: 'self-relation', group: 'Structure', label: 'Self relation', about: 'A term related to itself.', severity: 'info', default: true },

  { id: 'malformed-iri', group: 'IRIs and namespaces', label: 'Malformed IRI', about: 'An IRI that is not an absolute IRI and cannot be written to RDF.', severity: 'warning', default: true },
  { id: 'duplicate-iri', group: 'IRIs and namespaces', label: 'Shared IRI', about: 'Two entities with the same IRI. In RDF they are one and the same thing.', severity: 'warning', default: true },
  { id: 'namespace-usage', group: 'IRIs and namespaces', label: 'Namespace without a prefix', about: 'Entities in a namespace that is neither the default one nor has a prefix. Normal for reused vocabularies; a prefix makes them readable.', severity: 'info', default: true },
  { id: 'unresolved-reference', group: 'IRIs and namespaces', label: 'Unresolved reference', about: 'A reference to a property or entity that is not in the model, including from SHACL shapes.', severity: 'warning', default: true },
  { id: 'prefix-conflict', group: 'IRIs and namespaces', label: 'Prefix conflict', about: 'Two prefixes for one namespace, one prefix defined twice, or a prefix that redefines a standard one.', severity: 'warning', default: true },

  { id: 'property-kind', group: 'Modelling practice', label: 'Object and data property mixed up', about: 'A data property and an object property with the same name, or a term used as a property that is not one.', severity: 'warning', default: true },
  { id: 'undetermined-relationship', group: 'Modelling practice', label: 'Relationship that is not an object property', about: 'A labelled relationship that has not been declared as an object property, so it has no domain, range or characteristics.', severity: 'info', default: true },
  { id: 'unlabelled-relationship', group: 'Modelling practice', label: 'Relationship without a label', about: 'A relationship that does not say what it means.', severity: 'warning', default: true },
  { id: 'standard-property-misuse', group: 'Modelling practice', label: 'Standard property between the wrong kinds', about: 'An RDFS or OWL property used between kinds of entity it is not meant for.', severity: 'warning', default: true },
  { id: 'invalid-cardinality', group: 'Modelling practice', label: 'Cardinality that cannot be read', about: 'A cardinality on a relationship that is not of the form 1, 0..1, 1..*.', severity: 'warning', default: true },

  { id: 'enumeration-empty', group: 'Enumerations', label: 'Enumeration without members', about: 'A class defined as an enumeration that lists no individual yet, or an enumerated datatype without values. Nothing is written for such a definition until it lists something.', severity: 'warning', default: true },
  { id: 'enumeration-member', group: 'Enumerations', label: 'Member that is not one individual', about: 'An enumeration (owl:oneOf) lists individuals. Something else on the list, something that is no longer in the model, or two members with one IRI, is not what the list is meant to say.', severity: 'warning', default: true },
  { id: 'enumeration-value', group: 'Enumerations', label: 'Value that is not a literal of its datatype', about: 'A value of an enumerated datatype that is not written the way the datatype it claims is written, such as "ninety" as an integer, or that is listed twice.', severity: 'warning', default: true },
  { id: 'enumeration-unsupported', group: 'Enumerations', label: 'owl:oneOf the editor does not take', about: 'An owl:oneOf that is not, by itself, the definition of a class or the range of a data property: one inside another expression, a list with something other than named individuals or literals in it, or a list that is not well formed. It is kept as it was read and exported with the entity (of a list that is not well formed, the part that could be followed), but it is not shown as an enumeration and the reasoner does not read it.', severity: 'info', default: true },
  { id: 'enumeration-distinct', group: 'Enumerations', label: 'Members not declared different', about: 'OWL does not take two names to mean two individuals. Unless its members are declared all different, an enumeration of three may have fewer than three members. Often that is fine; switch this on to review where it is left open.', severity: 'info', default: false },

  { id: 'required-metadata', group: 'Governance', label: 'Required metadata missing', about: 'An entity without a value for a metadata field that is marked as required for its kind. Which fields are required is set under Entities, Governance & Metadata; it is a rule of this model, not of RDF or OWL.', severity: 'warning', default: true },
  { id: 'metadata-value', group: 'Governance', label: 'Metadata value of the wrong kind', about: 'A metadata value that is not what its field takes: text where a date or a number is expected, a value outside the controlled vocabulary, several values where one is allowed.', severity: 'warning', default: true },

  { id: 'skos-integrity', group: 'SKOS integrity', label: 'SKOS integrity conditions', about: 'The conditions the SKOS standard sets for a concept scheme: one preferred label per language, no overlap between label kinds, related and broader kept apart.', severity: 'error', default: true },
];

const BY_ID = new Map(QUALITY_RULES.map((r) => [r.id, r]));
export const ruleById = (id: string) => BY_ID.get(id);

export const ruleEnabled = (config: QualityConfig, rule: QualityRule) => (rule.default ? !config.off.includes(rule.id) : config.on.includes(rule.id));

/** Switches one rule on or off, keeping only what differs from its default. */
export function setRule(config: QualityConfig, id: string, on: boolean): QualityConfig {
  const rule = BY_ID.get(id);
  if (!rule) return config;
  const off = config.off.filter((x) => x !== id);
  const onList = config.on.filter((x) => x !== id);
  if (rule.default && !on) off.push(id);
  if (!rule.default && on) onList.push(id);
  return { off, on: onList };
}

/** The earlier model checks, by the rule each now belongs to. */
const LEGACY: Record<string, string> = {
  'Unnamed term': 'missing-label',
  'Missing description': 'missing-definition',
  'Duplicate name': 'duplicate-label',
  'Synonym clash': 'label-clash',
  'Circular hierarchy': 'subclass-cycle',
  'Self relation': 'self-relation',
  'Duplicate relation': 'duplicate-axiom',
  'Unlabelled relation': 'unlabelled-relationship',
  'Redundant hierarchy': 'redundant-subclass',
  'Multiple parents': 'multiple-inheritance',
  'Isolated term': 'unused-entity',
  'No domain': 'missing-domain-range',
  'No range': 'missing-domain-range',
  'Outside domain': 'outside-domain-range',
  'Outside range': 'outside-domain-range',
  'Undetermined relationship': 'undetermined-relationship',
  'Type mismatch': 'property-kind',
  'Property misuse': 'standard-property-misuse',
  'Invalid cardinality': 'invalid-cardinality',
  'Not SKOS': 'skos-integrity',
  'Preferred label clash': 'skos-integrity',
  'Label clash': 'label-clash',
  'Related and broader clash': 'skos-integrity',
  'Mapping clash': 'skos-integrity',
};

/** A change that would resolve a diagnostic, described before it is made. */
export interface QuickFix {
  label: string;
  /** What exactly would change, in words, shown to the user before anything happens. */
  preview: string;
  apply: (m: Model) => Model;
}

export interface Diagnostic {
  rule: string;
  severity: Severity;
  message: string;
  /** Why it is worth a look, when the message alone does not say. */
  explanation?: string;
  /** What could be done about it, when that is clear. */
  suggestion?: string;
  terms: string[];
  rels: string[];
  /** Key of the object property it is about. */
  prop?: string;
  /** Id of the SHACL shape it is about. */
  shape?: string;
  /** About the model as a whole (its settings) rather than one entity. */
  model?: boolean;
  fix?: QuickFix;
}

const local = (iri: string) => iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);
const namespace = (iri: string) => iri.slice(0, Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);
const humanize = (iri: string) => decodeURIComponent(local(iri)).replace(/[_-]+/g, ' ').replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2').trim();

type Style = 'UpperCamel' | 'lowerCamel' | 'snake_case' | 'kebab-case' | 'other';
const styleOf = (name: string): Style => (/^[A-Z][A-Za-z0-9]*$/.test(name) ? 'UpperCamel' : /^[a-z][A-Za-z0-9]*$/.test(name) ? 'lowerCamel' : /^[A-Za-z0-9]+(_[A-Za-z0-9]+)+$/.test(name) ? 'snake_case' : /^[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/.test(name) ? 'kebab-case' : 'other');
/** A one-word lower-case name is written the same way in every style but UpperCamel. */
const fits = (name: string, style: Style) => styleOf(name) === style || (style !== 'UpperCamel' && /^[a-z][a-z0-9]*$/.test(name)) || (style === 'snake_case' && /^[A-Za-z][A-Za-z0-9]*$/.test(name) && !/[a-z][A-Z]/.test(name));

/** Annotations whose values are text in a language (rather than codes, dates or links). */
const TEXTUAL = /^(rdfs:(label|comment)|skos:(prefLabel|altLabel|hiddenLabel|definition|example|note|scopeNote|editorialNote|historyNote|changeNote))$/;

/** Every diagnostic of the rules that are switched on, most serious first. */
export function qualityDiagnostics(model: Model, config: QualityConfig = model.quality): Diagnostic[] {
  const on = (id: string) => {
    const rule = BY_ID.get(id);
    return !!rule && ruleEnabled(config, rule);
  };
  const out: Diagnostic[] = [];
  const add = (rule: string, message: string, d: Partial<Diagnostic> = {}) => on(rule) && out.push({ rule, severity: BY_ID.get(rule)!.severity, message, terms: [], rels: [], ...d });
  const skos = model.mode === 'skos';
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const name = (id: string) => byId.get(id)?.name || '(unnamed)';

  // ---- the checks the app has always had, each under the rule it belongs to
  for (const i of runChecks(model)) {
    const rule = LEGACY[i.rule];
    if (!rule || !on(rule)) continue;
    // A relationship drawn on itself as "is a" is a cycle of one.
    const d: Diagnostic = { rule, severity: rule === 'skos-integrity' && i.severity !== 'error' ? i.severity : BY_ID.get(rule)!.severity, message: i.message.replace(/"([^"]*)"/g, '“$1”'), terms: i.terms, rels: i.rels };
    if (i.rule === 'Duplicate relation' && i.rels.length === 2) {
      const [first, second] = i.rels.map((id) => model.relations.find((r) => r.id === id));
      if (first && second && first.from === second.from && first.to === second.to) {
        d.fix = {
          label: 'Remove the second one',
          preview: `Removes the later of the two identical relationships ${quoted(name(second.from))} → ${quoted(name(second.to))}. The first stays, so what the model says does not change.`,
          apply: (m) => ({ ...m, relations: m.relations.filter((r) => r.id !== second.id) }),
        };
      }
    }
    if (i.rule === 'Redundant hierarchy') d.suggestion = 'Nothing has to be done: it follows either way. Remove the direct statement in the class’s Asserted superclasses if it was not meant.';
    if (i.rule === 'Missing description') d.suggestion = 'Open the entity and write a description under Annotations, if it needs one.';
    if (i.rule === 'No range') d.suggestion = 'Open the property and choose a datatype under Range, if its values have one.';
    if (i.rule === 'No domain') d.suggestion = 'Open the property and set a domain, or attach it to a class with a restriction. A property does not need a domain.';
    if (i.rule === 'Unnamed term') {
      const t = byId.get(i.terms[0]);
      if (t?.iri && humanize(t.iri)) {
        const label = humanize(t.iri);
        d.fix = { label: `Name it ${quoted(label)}`, preview: `Sets the label (rdfs:label) to ${quoted(label)}, taken from the last part of its IRI <${t.iri}>. The IRI is not changed.`, apply: (m) => ({ ...m, terms: m.terms.map((x) => (x.id === t.id ? { ...x, name: label } : x)) }) };
      }
    }
    out.push(d);
  }

  // ---- documentation
  const props = skos ? [] : objectProperties(model);
  if (!skos) for (const p of props) if (!p.description.trim()) add('missing-definition', `Object property ${quoted(p.name)} has no description.`, { prop: p.id, suggestion: 'Open the property and write a description under Annotations, if it needs one.' });

  if (on('missing-language')) {
    if (!model.lang && model.terms.length) {
      add('missing-language', 'The model has no language, so names, descriptions and synonyms are exported without a language tag.', { model: true, suggestion: 'Set the language (for example en) in the Model panel, shown when nothing is selected.' });
    }
    if (model.lang) {
      const untagged = (fields: { key: string; value: string; lang?: string }[]) => fields.filter((f) => TEXTUAL.test(f.key) && !f.lang && f.value.trim());
      for (const t of model.terms) {
        const bare = untagged(t.fields);
        if (!bare.length) continue;
        add('missing-language', `${quoted(t.name)} has ${bare.length} annotation${bare.length === 1 ? '' : 's'} without a language: ${bare.map((f) => f.key).join(', ')}.`, {
          terms: [t.id],
          fix: {
            label: `Tag as “${model.lang}”`,
            preview: `Gives ${bare.map((f) => `${f.key} ${quoted(f.value)}`).join(', ')} the model’s language, ${model.lang}. Only do this if ${bare.length === 1 ? 'it is' : 'they are'} written in that language.`,
            apply: (m) => ({ ...m, terms: m.terms.map((x) => (x.id === t.id ? { ...x, fields: x.fields.map((f) => (TEXTUAL.test(f.key) && !f.lang && f.value.trim() && isLang(m.lang) ? { ...f, lang: m.lang } : f)) } : x)) }),
          },
        });
      }
      for (const p of props) {
        const bare = untagged(p.fields);
        if (bare.length) add('missing-language', `Object property ${quoted(p.name)} has ${bare.length} annotation${bare.length === 1 ? '' : 's'} without a language: ${bare.map((f) => f.key).join(', ')}.`, { prop: p.id });
      }
    }
  }

  if (on('naming-convention')) {
    // What most entities of a kind do is taken as the convention; nothing is imposed from outside.
    const kinds: { what: string; items: { iri: string; term?: string; prop?: string; name: string }[] }[] = [
      { what: 'classes', items: model.terms.filter((t) => t.type === 'concept' && t.iri).map((t) => ({ iri: t.iri!, term: t.id, name: t.name })) },
      { what: 'properties', items: [...model.terms.filter((t) => t.type === 'property' && t.iri).map((t) => ({ iri: t.iri!, term: t.id, name: t.name })), ...props.filter((p) => p.iri).map((p) => ({ iri: p.iri!, prop: p.id, name: p.name }))] },
    ];
    for (const { what, items } of kinds) {
      if (items.length < 8) continue;
      const tally = new Map<Style, number>();
      for (const i of items) tally.set(styleOf(local(i.iri)), (tally.get(styleOf(local(i.iri))) ?? 0) + 1);
      const [style, n] = [...tally].filter(([s]) => s !== 'other').sort((a, b) => b[1] - a[1])[0] ?? ['other', 0];
      if (style === 'other' || n / items.length < 0.7) continue;
      for (const i of items) {
        if (fits(local(i.iri), style)) continue;
        add('naming-convention', `The IRI of ${quoted(i.name)} ends in ${quoted(local(i.iri))}; most ${what} here are written in ${style}.`, {
          terms: i.term ? [i.term] : [],
          prop: i.prop,
          explanation: `${n} of ${items.length} ${what} use ${style}. An IRI is an identifier: changing it changes which entity this is for everyone who refers to it, so it is not changed for you.`,
        });
      }
    }
  }

  if (on('annotation-practice')) {
    const seen = new Map<string, Map<string, string[]>>();
    for (const t of model.terms) {
      for (const f of t.fields) {
        if (/^(rdfs|owl|skos|dcterms|dcat|prov|dqv|adms):/.test(f.key) || !f.key.trim()) continue;
        const norm = f.key.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const spellings = seen.get(norm) ?? seen.set(norm, new Map()).get(norm)!;
        spellings.set(f.key, [...(spellings.get(f.key) ?? []), t.id]);
      }
    }
    for (const spellings of seen.values()) {
      if (spellings.size < 2) continue;
      const names = [...spellings.keys()];
      add('annotation-practice', `The annotation properties ${names.map(quoted).join(' and ')} differ only in spelling. Each is exported as a property of its own.`, { terms: [...new Set([...spellings.values()].flat())].slice(0, 50), suggestion: 'If they are meant to be one property, give them the same name in each entity’s annotations.' });
    }
  }

  // ---- structure
  if (!skos && on('root-class')) {
    for (const t of model.terms) if (t.type === 'concept' && !assertedSuperclasses(model, t.id).some((id) => byId.get(id)?.type === 'concept')) add('root-class', `${quoted(t.name)} has no asserted superclass, so it sits directly under owl:Thing.`, { terms: [t.id] });
  }
  if (!skos) {
    for (const p of props) {
      const domain = (p.domainAuto ? p.usedFrom : p.domains).length > 0;
      const range = (p.rangeAuto ? p.usedTo : p.ranges).length > 0;
      if (!p.rels.length && !domain && !range && !PROP_LINKS.some((l) => propLinks(model, p.id, l).length)) add('unused-entity', `Object property ${quoted(p.name)} is declared but never used, and has no domain or range.`, { prop: p.id });
      else if (!domain || !range) add('missing-domain-range', `Object property ${quoted(p.name)} has no ${!domain && !range ? 'domain or range' : !domain ? 'domain' : 'range'}.`, { prop: p.id, suggestion: 'Open the property and add a class, if there is one that everything having it belongs to. A property does not need a domain or a range.' });
    }
  }

  // ---- IRIs and namespaces
  const entities: { iri?: string; term?: string; prop?: string; name: string }[] = [...model.terms.map((t) => ({ iri: t.iri, term: t.id, name: t.name })), ...model.props.map((p) => ({ iri: p.iri, prop: p.id, name: p.name }))];
  const where = (e: { term?: string; prop?: string }) => ({ terms: e.term ? [e.term] : [], prop: e.prop });
  for (const e of entities) if (e.iri && !isAbsoluteIri(e.iri)) add('malformed-iri', `The IRI of ${quoted(e.name)}, ${quoted(e.iri)}, is not an absolute IRI.`, { ...where(e), explanation: 'An absolute IRI has a scheme such as http: and no spaces or characters like < > " { }.' });
  if (on('duplicate-iri')) {
    const byIri = new Map<string, typeof entities>();
    for (const e of entities) if (e.iri) byIri.set(e.iri, [...(byIri.get(e.iri) ?? []), e]);
    for (const [iri, list] of byIri) if (list.length > 1) add('duplicate-iri', `${list.map((e) => quoted(e.name)).join(' and ')} share the IRI <${iri}>. In RDF they are one entity.`, { terms: list.flatMap((e) => (e.term ? [e.term] : [])), prop: list.find((e) => e.prop)?.prop });
  }
  if (on('namespace-usage')) {
    const base = baseIriOf(model);
    const known = new Set([base, ...model.prefixes.map((p) => p.iri), ...STANDARD.map((p) => p.iri)]);
    const groups = new Map<string, typeof entities>();
    for (const e of entities) if (e.iri && isAbsoluteIri(e.iri) && !known.has(namespace(e.iri))) groups.set(namespace(e.iri), [...(groups.get(namespace(e.iri)) ?? []), e]);
    for (const [ns, list] of groups) {
      add('namespace-usage', `${list.length} ${list.length === 1 ? 'entity is' : 'entities are'} in the namespace <${ns}>, which has no prefix: ${list.slice(0, 4).map((e) => e.name).join(', ')}${list.length > 4 ? '…' : ''}.`, {
        terms: list.flatMap((e) => (e.term ? [e.term] : [])).slice(0, 200),
        prop: list.find((e) => e.prop)?.prop,
        model: true,
        suggestion: 'If this is a vocabulary you reuse, give it a prefix under Ontology settings. If these entities belong in the default namespace, the settings can move them.',
      });
    }
  }
  if (on('unresolved-reference')) {
    const ids = new Set(props.map((p) => p.id));
    for (const p of model.props) for (const link of PROP_LINKS) for (const k of p[link] ?? []) if (!ids.has(k)) add('unresolved-reference', `Object property ${quoted(p.name)} refers to a property that is not in the model.`, { prop: p.id, suggestion: 'Open the property and remove the reference, or declare the missing property.' });
    const iris = new Set(entities.map((e) => e.iri).filter(Boolean));
    const missing = new Map<string, string[]>();
    for (const r of shapeReferences(model.shapes)) if (!iris.has(r.iri)) missing.set(r.shape.id, [...(missing.get(r.shape.id) ?? []), `${r.as} <${r.iri}>`]);
    for (const [shape, list] of missing) {
      const s = model.shapes.nodes.find((x) => x.id === shape)!;
      add('unresolved-reference', `Shape ${quoted(s.name)} refers to ${list.length === 1 ? 'an IRI that is' : `${list.length} IRIs that are`} not in this ontology: ${[...new Set(list)].slice(0, 3).join(', ')}${list.length > 3 ? '…' : ''}.`, { shape, severity: 'info', explanation: 'That is as it should be when the shape is for imported data with a vocabulary of its own. Against this model’s own data it will match nothing.' });
    }
  }
  if (on('prefix-conflict')) {
    const seenName = new Map<string, string>();
    const seenNs = new Map<string, string>();
    for (const p of model.prefixes) {
      const std = STANDARD.find((s) => s.prefix.toLowerCase() === p.prefix.toLowerCase());
      if (std && std.iri !== p.iri) add('prefix-conflict', `The prefix ${quoted(p.prefix)} is defined as <${p.iri}>, but it is the standard prefix for <${std.iri}>.`, { model: true });
      if (seenName.has(p.prefix.toLowerCase())) add('prefix-conflict', `The prefix ${quoted(p.prefix)} is defined twice: <${seenName.get(p.prefix.toLowerCase())}> and <${p.iri}>.`, { model: true });
      if (seenNs.has(p.iri)) add('prefix-conflict', `The prefixes ${quoted(seenNs.get(p.iri)!)} and ${quoted(p.prefix)} both stand for <${p.iri}>.`, { model: true });
      seenName.set(p.prefix.toLowerCase(), p.iri);
      seenNs.set(p.iri, p.prefix);
    }
  }

  // ---- modelling practice
  if (!skos && on('property-kind')) {
    const dataNames = new Map(model.terms.filter((t) => t.type === 'property' && t.name.trim()).map((t) => [nameKey(t.name), t]));
    for (const p of props) {
      const twin = dataNames.get(nameKey(p.name));
      if (twin) add('property-kind', `${quoted(p.name)} is the name of an object property and of a data property. They are two properties with two IRIs; it is easy to use the wrong one.`, { terms: [twin.id], prop: p.id });
    }
    for (const r of resolveModel(model).relations) {
      const ends = [byId.get(r.from)?.type, byId.get(r.to)?.type].sort().join('|');
      if (ends === 'instance|property' && !r.predicate) {
        const [individual, property] = byId.get(r.from)?.type === 'instance' ? [r.from, r.to] : [r.to, r.from];
        add('property-kind', `${quoted(name(individual))} is joined to the data property ${quoted(name(property))} by a line. In OWL an individual has a value for a data property; a line between the two says nothing.`, {
          terms: [individual, property],
          rels: [r.id],
          suggestion: `Give ${quoted(name(individual))} its value under Data property assertions in its editor, and remove the line.`,
          fix: { label: 'Remove the line', preview: `Removes the line between ${quoted(name(individual))} and ${quoted(name(property))}. Both stay in the model, and so do the values ${quoted(name(individual))} has.`, apply: (m) => ({ ...m, relations: m.relations.filter((x) => x.id !== r.id) }) },
        });
        continue;
      }
      if (r.kind === 'association' && !r.predicate && byId.get(r.to)?.type === 'property' && byId.get(r.from)?.type === 'concept') {
        add('property-kind', `${quoted(name(r.from))} is linked to the data property ${quoted(name(r.to))} by an ordinary relationship${r.label.trim() ? ` ${quoted(r.label.trim())}` : ''}. To say the class has the property, the relationship should be of the kind “Has data property”.`, { rels: [r.id] });
      }
    }
  }

  // ---- enumerations
  if (!skos) {
    const kindOf = (t: Term) => (t.type === 'concept' ? 'class' : t.type === 'property' ? 'data property' : 'individual');
    const naming = namingFor(model);
    for (const c of model.terms) {
      // A list in a class axiom (a superclass that is one, a second definition, a list inside another expression).
      for (const a of c.classAxioms ?? []) {
        const json = JSON.stringify(a.expression);
        if (!/"type":"(ObjectOneOf|DataOneOf)"/.test(json) && !unparsedIn(a.expression).some((x) => x.includes(OWL + 'oneOf'))) continue;
        const text = `${CLASS_AXIOM_WORDS[a.kind]} ${classText(a.expression, naming)}`;
        add('enumeration-unsupported', `${quoted(c.name)} has an owl:oneOf the editor does not take as an enumeration: ${text.length > 140 ? text.slice(0, 140) + '…' : text}`, { terms: [c.id], suggestion: 'Nothing has to be done: it is exported as it is, and the OWL 2 DL reasoner reads it. It is listed with the class’s axioms.' });
      }
      // In a domain or range, a list is part of the expression; one kept as it was read (empty, or not well formed) is not taken.
      for (const a of [...(c.domains ?? []).map((x) => x.expression), ...(c.ranges ?? []).map((x) => x.range)].flatMap(unparsedIn)) {
        if (!a.includes(OWL + 'oneOf')) continue;
        add('enumeration-unsupported', `${quoted(c.name)} has an owl:oneOf the editor does not take as an enumeration: ${a.length > 140 ? a.slice(0, 140) + '…' : a}`, { terms: [c.id], suggestion: 'Nothing has to be done: it is exported as it is. It is listed with the property’s domain or range, kept as it was read.' });
      }
      if (c.type !== 'concept' || !c.oneOf) continue;
      const here = c.oneOf.map((id) => byId.get(id)).filter((t): t is Term => !!t);
      const drop = (ids: Set<string>) => (m: Model) => ({ ...m, terms: m.terms.map((t) => (t.id === c.id && t.oneOf ? { ...t, oneOf: t.oneOf.filter((id) => !ids.has(id)) } : t)) });
      if (!here.length) add('enumeration-empty', `${quoted(c.name)} is defined as an enumeration but lists no individual yet. Until it does, it is exported as an ordinary class.`, { terms: [c.id], suggestion: 'Open the class and add its members under Class definition, or make it an ordinary class again there.' });
      const gone = c.oneOf.filter((id) => !byId.has(id));
      if (gone.length) {
        add('enumeration-member', `${quoted(c.name)} lists ${gone.length === 1 ? 'an individual that is' : `${gone.length} individuals that are`} no longer in the model.`, {
          terms: [c.id],
          fix: { label: 'Take off the list', preview: `Removes ${gone.length === 1 ? 'the entry' : `the ${gone.length} entries`} that no longer ${gone.length === 1 ? 'refers' : 'refer'} to anything from the members of ${quoted(c.name)}. Nothing that is exported changes.`, apply: drop(new Set(gone)) },
        });
      }
      for (const t of here) {
        if (t.type === 'instance') continue;
        add('enumeration-member', `${quoted(c.name)} lists ${quoted(t.name)}, which is a ${kindOf(t)}, not an individual.`, {
          terms: [c.id, t.id],
          explanation: 'An enumeration (owl:oneOf) lists individuals. It is exported with this member as it is, but the reasoner leaves the whole enumeration alone until the list holds individuals only.',
          fix: { label: 'Take it off the list', preview: `Removes ${quoted(t.name)} from the members of ${quoted(c.name)}. ${quoted(t.name)} itself stays in the model.`, apply: drop(new Set([t.id])) },
        });
      }
      const byIri = new Map<string, Term[]>();
      for (const t of here) if (t.iri) byIri.set(t.iri, [...(byIri.get(t.iri) ?? []), t]);
      for (const [iri, twins] of byIri) {
        if (twins.length < 2) continue;
        add('enumeration-member', `${quoted(c.name)} lists ${twins.map((t) => quoted(t.name)).join(' and ')}, which share the IRI <${iri}>. In RDF that is one individual, listed ${twins.length === 2 ? 'twice' : `${twins.length} times`}.`, {
          terms: [c.id, ...twins.map((t) => t.id)],
          fix: { label: 'Keep the first only', preview: `Removes ${twins.slice(1).map((t) => quoted(t.name)).join(', ')} from the members of ${quoted(c.name)}, leaving ${quoted(twins[0].name)}. The individuals themselves stay in the model.`, apply: drop(new Set(twins.slice(1).map((t) => t.id))) },
        });
      }
      const individuals = here.filter((t) => t.type === 'instance');
      if (!c.allDifferent && individuals.length > 1) {
        add('enumeration-distinct', `The ${individuals.length} members of ${quoted(c.name)} are not declared different, so two of them may be one and the same individual.`, {
          terms: [c.id],
          fix: { label: 'Declare them all different', preview: `States that ${individuals.map((t) => quoted(t.name)).join(', ')} are all different individuals (owl:AllDifferent). Only do this if they are.`, apply: (m) => ({ ...m, terms: m.terms.map((t) => (t.id === c.id && t.oneOf ? { ...t, allDifferent: true } : t)) }) },
        });
      }
    }
    for (const d of model.datatypes) {
      const users = usersOf(model, d.id);
      const about = users.length ? { terms: users.map((t) => t.id) } : { model: true };
      const of = users.length ? `, the range of ${users.map((t) => quoted(t.name)).join(', ')},` : '';
      if (!d.values.length) {
        add('enumeration-empty', `The enumerated datatype ${quoted(d.name)}${of} has no values yet. ${d.anonymous ? 'Nothing is written for it until it has one.' : 'Until it has one, it is exported as a datatype without a definition.'}`, { ...about, suggestion: 'Select a data property that has it as its range and add the values there.' });
      }
      const seen = new Set<string>();
      const twice = new Set<number>();
      d.values.forEach((v, i) => {
        const key = JSON.stringify([v.value, v.dt ?? '', v.lang ?? '']);
        if (seen.has(key)) twice.add(i);
        seen.add(key);
        // A datatype the app does not know the shape of cannot be checked, and is taken as it is.
        const wrong = v.dt && v.lang ? 'has a language and a datatype; a literal has one or the other' : !v.dt || DATATYPES.some((x) => x.id === v.dt) ? validateLiteral(v.value, v.dt) : undefined;
        if (wrong) add('enumeration-value', `${literalText(v)}, one of the values of ${quoted(d.name)}, is not a literal that can be written: ${wrong.replace(/^Enter a value\.$/, 'it is empty.')}`, { ...about, suggestion: 'Remove the value from the datatype and add it again as it should be.' });
      });
      if (twice.size) {
        add('enumeration-value', `${quoted(d.name)} lists ${[...twice].map((i) => literalText(d.values[i])).join(', ')} more than once.`, {
          ...about,
          fix: { label: 'Keep one of each', preview: `Removes the repeated ${twice.size === 1 ? 'value' : 'values'} from ${quoted(d.name)}. What the datatype allows does not change.`, apply: (m) => ({ ...m, datatypes: m.datatypes.map((x) => (x.id === d.id ? { ...x, values: x.values.filter((_, i) => !twice.has(i)) } : x)) }) },
        });
      }
    }
  }

  // ---- governance
  if (on('required-metadata') || on('metadata-value')) {
    for (const p of metaProblems(model)) {
      const about = 'term' in p.entity.owner ? { terms: [p.entity.owner.term] } : { prop: p.entity.owner.prop };
      if (p.kind === 'missing') add('required-metadata', p.message, { ...about, suggestion: 'Fill it in under Entities, Governance & Metadata. Whether the field is required is set there too, under Configure fields.' });
      else add('metadata-value', p.message, { ...about, suggestion: 'Correct the value under Entities, Governance & Metadata.' });
    }
  }

  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

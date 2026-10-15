import { withDatatype } from './domains';
import { describe, expect, it } from 'vitest';
import { addCustomField, checkValue, fieldKey, fieldsFor, metaEntity, metaProblems, overrideField, registry, removeCustomField, termKind, updateCustomField, valuesOf, withProfile, writeValues, type MetaValue } from './governance';
import { setIriSuffix, withIris } from './iri';
import { qualityDiagnostics } from './quality';
import { fromTurtle, toTurtle } from './rdf';
import { stable } from './stable';
import { emptyModel, newRelation, newTerm, normalizeModel, type Model } from './types';
import { fingerprintOf, MODEL_DATA } from './validation';

const base = (): Model => {
  const m = emptyModel('Shop');
  m.baseIri = 'http://example.org/shop#';
  m.lang = 'en';
  m.terms = [
    newTerm({ id: 'customer', name: 'Customer', description: 'A person or organization purchasing products.' }),
    newTerm({ id: 'crm', name: 'CRM Department', type: 'instance' }),
    newTerm({ id: 'dept', name: 'Department' }),
    newTerm({ id: 'email', name: 'email', type: 'property', ranges: withDatatype({}, 'xsd:string') }),
    newTerm({ id: 'table', name: 'Customer table', type: 'instance' }),
  ];
  m.relations = [newRelation({ from: 'crm', to: 'dept', kind: 'generalization' })];
  return withIris(m);
};
const field = (m: Model, id: string) => registry(m).find((f) => f.id === id)!;
/** Sets a field the way the store does, for a term. */
const set = (m: Model, term: string, id: string, values: MetaValue[]): Model => ({ ...m, terms: m.terms.map((t) => (t.id === term ? { ...t, fields: writeValues(t.fields, field(m, id), values) } : t)) });
const iri = (m: Model, id: string) => m.terms.find((t) => t.id === id)!.iri!;
const block = (ttl: string, subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '';

describe('governance metadata', () => {
  it('offers different fields to different kinds of entity', () => {
    const m = base();
    const ids = (kind: Parameters<typeof fieldsFor>[1]) => fieldsFor(m, kind).map((f) => f.id);
    expect(ids('class')).toEqual(expect.arrayContaining(['name', 'definition', 'domain', 'owner', 'status', 'assets']));
    expect(ids('class')).not.toContain('database');
    expect(ids('technicalAsset')).toEqual(expect.arrayContaining(['source', 'database', 'schema', 'location', 'refresh', 'completeness', 'upstream']));
    expect(ids('businessAsset')).toEqual(expect.arrayContaining(['owner', 'steward', 'sensitivity', 'policies', 'concepts']));
    expect(ids('objectProperty')).not.toContain('altLabels');
    expect(ids('dataProperty')).toContain('range');
  });

  it('reads the name, definition and synonyms from the entity itself rather than a copy', () => {
    const m = base();
    m.terms[0].synonyms = 'Client, Buyer';
    const e = metaEntity(m, { term: 'customer' })!;
    expect(valuesOf(m, e, field(m, 'name'))).toEqual([{ value: 'Customer' }]);
    expect(valuesOf(m, e, field(m, 'altLabels')).map((v) => v.value)).toEqual(['Client', 'Buyer']);
    expect(valuesOf(m, e, field(m, 'entityType'))[0].value).toContain('owl:Class');
    expect(e.fields).toEqual([]);
  });

  it('stores values as typed annotations on the entity, under standard properties', () => {
    let m = base();
    m = set(m, 'customer', 'modified', [{ value: '2026-10-12' }]);
    m = set(m, 'customer', 'owner', [{ value: iri(m, 'crm'), iri: true }]);
    m = set(m, 'customer', 'status', [{ value: 'approved' }]);
    m = set(m, 'customer', 'keywords', [{ value: 'sales' }, { value: 'crm' }, { value: 'sales' }]);
    expect(m.terms[0].fields).toEqual([
      { key: 'dcterms:modified', value: '2026-10-12', dt: 'xsd:date' },
      { key: 'dcterms:rightsHolder', value: 'http://example.org/shop#CRMDepartment', iri: true },
      { key: 'adms:status', value: 'Approved' },
      { key: 'dcat:keyword', value: 'sales' },
      { key: 'dcat:keyword', value: 'crm' },
    ]);
    const ttl = toTurtle(m);
    const customer = block(ttl, ':Customer');
    expect(customer).toContain('dcterms:modified "2026-10-12"^^xsd:date');
    expect(customer).toContain('dcterms:rightsHolder :CRMDepartment');
    expect(customer).toContain('adms:status "Approved"');
    expect(customer).toContain('a owl:Class');
    // The class is not given a superclass, a type or a restriction by any of it.
    expect(customer).not.toMatch(/subClassOf|owl:Restriction/);
    expect(ttl).toContain('adms:status a owl:AnnotationProperty .');
    expect(ttl).toContain('@prefix adms: <http://www.w3.org/ns/adms#> .');
    expect(ttl).toContain('@prefix dcat: <http://www.w3.org/ns/dcat#> .');
  });

  it('keeps every value, with its type, through export and import', () => {
    let m = base();
    m = set(m, 'customer', 'modified', [{ value: '2026-10-12' }]);
    m = set(m, 'customer', 'owner', [{ value: iri(m, 'crm'), iri: true }]);
    m = set(m, 'customer', 'steward', [{ value: 'Jane Doe' }]);
    m = set(m, 'customer', 'status', [{ value: 'Approved' }]);
    m = set(m, 'email', 'technicalOwner', [{ value: 'Platform team' }]);
    m = set(m, 'email', 'completeness', [{ value: '97.5' }]);
    m = set(m, 'email', 'column', [{ value: 'EMAIL_ADDR' }]);
    m = { ...m, terms: m.terms.map((t) => (t.id === 'table' ? { ...t, fields: withProfile(m, t, 'technicalAsset') } : t)) };
    m = set(m, 'table', 'location', [{ value: 'https://warehouse.example.org/crm/customer' }]);
    const ttl = toTurtle(m);
    expect(block(ttl, ':email')).toContain('dqv:hasQualityMeasurement [ a dqv:QualityMeasurement ; dqv:isMeasurementOf :completeness ; dqv:value "97.5"^^xsd:decimal ]');
    expect(ttl).toContain(':completeness a dqv:Metric');
    const back = fromTurtle(ttl);
    const of = (name: string) => back.terms.find((t) => t.name === name)!;
    expect(of('Customer').iri).toBe(iri(m, 'customer'));
    expect(of('Customer').fields).toEqual(m.terms[0].fields);
    expect(of('email').fields).toEqual(expect.arrayContaining(m.terms.find((t) => t.id === 'email')!.fields));
    expect(termKind(back, of('Customer table'))).toBe('technicalAsset');
    expect(of('Customer table').fields).toContainEqual({ key: 'dcat:accessURL', value: 'https://warehouse.example.org/crm/customer', iri: true });
    // Nothing of the metadata became a term, a relationship or an object property.
    expect(back.terms.map((t) => t.name).sort()).toEqual(m.terms.map((t) => t.name).sort());
    expect(back.relations).toHaveLength(m.relations.length);
    expect(back.props).toEqual([]);
    // And a second round trip writes the same file.
    expect(toTurtle(back)).toBe(ttl);
  });

  it('keeps it in the saved model', () => {
    let m = set(base(), 'customer', 'created', [{ value: '2025-01-31' }]);
    m = (addCustomField(m, { label: 'Retention period', type: 'integer', appliesTo: ['class'] }) as { model: Model }).model;
    m = (overrideField(m, 'owner', { required: true }) as { model: Model }).model;
    const back = normalizeModel(JSON.parse(JSON.stringify(m)));
    expect(back.terms[0].fields).toEqual(m.terms[0].fields);
    expect(back.governance).toEqual(m.governance);
    // A model saved before there was any governance metadata opens with the standard registry.
    const { governance: _, ...old } = m;
    expect(normalizeModel(JSON.parse(JSON.stringify(old))).governance).toEqual({ custom: [], overrides: {} });
  });

  it('checks a value against what its field takes', () => {
    const m = base();
    expect(checkValue(field(m, 'modified'), { value: 'last week' })).toMatch(/not a date/);
    expect(checkValue(field(m, 'modified'), { value: '2026-02-30' })).toMatch(/not a date/);
    expect(checkValue(field(m, 'modified'), { value: '2026-02-28' })).toBeUndefined();
    expect(checkValue(field(m, 'completeness'), { value: '120' })).toMatch(/more than 100/);
    expect(checkValue(field(m, 'completeness'), { value: 'high' })).toMatch(/not a number/);
    expect(checkValue(field(m, 'status'), { value: 'Retired' })).toMatch(/not one of/);
    expect(checkValue(field(m, 'location'), { value: 'the warehouse' })).toMatch(/not a link/);
    expect(checkValue(field(m, 'owner'), { value: 'Jane Doe' })).toBeUndefined();
  });

  it('lets the model add, change and remove fields of its own', () => {
    let m = base();
    const added = addCustomField(m, { label: 'Retention period', type: 'integer', appliesTo: ['class', 'technicalAsset'], group: 'Governance' });
    m = added.model!;
    const f = m.governance.custom[0];
    expect(fieldsFor(m, 'class').some((x) => x.id === f.id)).toBe(true);
    expect(fieldsFor(m, 'individual').some((x) => x.id === f.id)).toBe(false);
    m = set(m, 'customer', f.id, [{ value: '7' }]);
    expect(block(toTurtle(m), ':Customer')).toContain(':retentionPeriod "7"^^xsd:integer');
    // A name or a property already in use is refused, and so is a prefix nobody declared.
    expect(addCustomField(m, { label: 'retention period' }).error).toMatch(/already a field/);
    expect(addCustomField(m, { label: 'Changed', property: 'dcterms:modified' }).error).toMatch(/already stored/);
    expect(addCustomField(m, { label: 'Audience', property: 'gov:audience' }).error).toMatch(/prefix “gov” is not known/);
    expect(addCustomField(m, { label: 'Audience', property: 'dcterms:audience' }).error).toBeUndefined();
    // Giving it another property moves the values along.
    m = updateCustomField(m, f.id, { property: 'dcterms:temporal' }).model!;
    expect(m.terms[0].fields).toEqual([{ key: 'dcterms:temporal', value: '7', dt: 'xsd:integer' }]);
    const removed = removeCustomField(m, f.id);
    expect(removed.note).toMatch(/kept as annotations/);
    expect(removed.model!.terms[0].fields).toHaveLength(1);
    expect(registry(removed.model!).some((x) => x.id === f.id)).toBe(false);
  });

  it('reports required fields and ill-typed values as governance rules that can be switched off', () => {
    let m = base();
    expect(metaProblems(m)).toEqual([]);
    m = overrideField(m, 'owner', { required: true }).model!;
    const missing = qualityDiagnostics(m).filter((d) => d.rule === 'required-metadata');
    // Required where the field applies: the classes, the data property and the individuals.
    expect(missing).toHaveLength(5);
    m = set(m, 'customer', 'owner', [{ value: 'Jane Doe' }]);
    expect(qualityDiagnostics(m).filter((d) => d.rule === 'required-metadata')).toHaveLength(4);
    expect(qualityDiagnostics({ ...m, quality: { off: ['required-metadata'], on: [] } }).filter((d) => d.rule === 'required-metadata')).toEqual([]);
    // A value typed into the annotations that is not a date.
    m = { ...m, terms: m.terms.map((t) => (t.id === 'customer' ? { ...t, fields: [...t.fields, { key: 'dcterms:created', value: 'sometime in 2020' }] } : t)) };
    const bad = qualityDiagnostics(m).filter((d) => d.rule === 'metadata-value');
    expect(bad).toHaveLength(1);
    expect(bad[0].terms).toEqual(['customer']);
    // Back to the standard: the override is forgotten rather than stored as "not required".
    expect(overrideField(m, 'owner', { required: false }).model!.governance.overrides).toEqual({});
  });

  it('follows an entity that is referred to when its IRI changes, and stays put when a label does', () => {
    let m = base();
    m = set(m, 'customer', 'owner', [{ value: iri(m, 'crm'), iri: true }]);
    const renamed: Model = { ...m, terms: m.terms.map((t) => (t.id === 'customer' ? { ...t, name: 'Client' } : t)) };
    expect(renamed.terms[0].iri).toBe(iri(m, 'customer'));
    expect(renamed.terms[0].fields).toEqual(m.terms[0].fields);
    const moved = setIriSuffix(m, { term: 'crm' }, 'CrmDept').model!;
    expect(moved.terms[0].fields[0].value).toBe('http://example.org/shop#CrmDept');
    expect(block(toTurtle(moved), ':Customer')).toContain('dcterms:rightsHolder :CrmDept');
  });

  it('leaves a catalogue property alone where the file declares it an object property', () => {
    const back = fromTurtle(`
      @prefix : <http://example.org/x#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix prov: <http://www.w3.org/ns/prov#> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      prov:wasDerivedFrom a owl:ObjectProperty .
      :Report a owl:Class .
      :Dataset a owl:Class .
      :r1 a owl:NamedIndividual , :Report ; prov:wasDerivedFrom :d1 ; prov:generatedAtTime "2026-01-01T00:00:00Z"^^xsd:dateTime .
      :d1 a owl:NamedIndividual , :Dataset .`);
    const r1 = back.terms.find((t) => t.iri === 'http://example.org/x#r1')!;
    const d1 = back.terms.find((t) => t.iri === 'http://example.org/x#d1')!;
    // The statement between the two individuals is a relationship, once, and not an annotation too.
    expect(back.relations.filter((r) => r.from === r1.id && r.to === d1.id && r.kind === 'association')).toHaveLength(1);
    expect(r1.fields).toEqual([{ key: 'prov:generatedAtTime', value: '2026-01-01T00:00:00Z', dt: 'xsd:dateTime' }]);
    const ttl = toTurtle(back);
    expect(ttl).toContain('prov:wasDerivedFrom a owl:ObjectProperty');
    expect(ttl).not.toContain('prov:wasDerivedFrom a owl:AnnotationProperty');
    expect(block(ttl, ':r1').match(/prov:wasDerivedFrom/g)).toHaveLength(1);
  });

  it('keeps the IRI of a quality metric and of an annotation property from another vocabulary', () => {
    const back = fromTurtle(`
      @prefix : <http://example.org/x#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix dqv: <http://www.w3.org/ns/dqv#> .
      @prefix m: <http://metrics.example/> .
      @prefix gov: <http://governance.example/ns#> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      gov:retention a owl:AnnotationProperty .
      :Customer a owl:Class ; gov:retention 7 ;
        dqv:hasQualityMeasurement [ a dqv:QualityMeasurement ; dqv:isMeasurementOf m:completeness ; dqv:value "0.9"^^xsd:decimal ] .`);
    expect(back.terms[0].fields).toEqual([
      { key: 'gov:retention', value: '7', dt: 'xsd:integer' },
      { key: 'm:completeness', value: '0.9', dt: 'xsd:decimal', measure: true },
    ]);
    const ttl = toTurtle(back);
    expect(block(ttl, ':Customer')).toContain('gov:retention "7"^^xsd:integer');
    expect(block(ttl, ':Customer')).toContain('dqv:isMeasurementOf m:completeness');
    expect(toTurtle(fromTurtle(ttl))).toBe(ttl);
  });

  it('counts a change to the field set-up as a change to the model', () => {
    const m = base();
    expect(stable(m)).toBe(m);
    const required = overrideField(m, 'owner', { required: true }).model!;
    expect(stable(required)).toBe(required);
    expect(fingerprintOf(required, MODEL_DATA)).not.toBe(fingerprintOf(m, MODEL_DATA));
  });

  it('drops a prefix of the model that only repeats one that is standard now', () => {
    const m = { ...base(), prefixes: [{ prefix: 'prov', iri: 'http://www.w3.org/ns/prov#' }, { prefix: 'ex', iri: 'http://ex.example/' }] };
    expect(normalizeModel(JSON.parse(JSON.stringify(m))).prefixes).toEqual([{ prefix: 'ex', iri: 'http://ex.example/' }]);
  });

  it('keeps a number as it was typed', () => {
    let m = addCustomField(base(), { label: 'Record count', type: 'integer' }).model!;
    m = set(m, 'customer', m.governance.custom[0].id, [{ value: ' 12345678901234567890 ' }]);
    expect(m.terms[0].fields).toEqual([{ key: 'Record count', value: '12345678901234567890', dt: 'xsd:integer' }]);
  });

  it('files a field under one key however its property is written', () => {
    expect(fieldKey({ property: 'DCTERMS:modified', label: 'x' })).toBe('dcterms:modified');
    expect(fieldKey({ property: '', label: 'Technical owner' })).toBe('Technical owner');
  });
});

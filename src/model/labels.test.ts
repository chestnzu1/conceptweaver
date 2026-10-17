import { describe, expect, it } from 'vitest';
import { descriptionFieldAt, descriptionIn, labelFieldAt, languageName, modelLanguages, nameIn, standardFieldKey } from './labels';
import { emptyModel, newAnnotationProp, newProp, newTerm, type ExtraField, type Model } from './types';

const field = (key: string, value: string, extra: Partial<ExtraField> = {}): ExtraField => ({ key, value, ...extra });

/** A model whose language is English, with names and descriptions in a few others. */
function languages(): Model {
  const m = emptyModel('Languages');
  m.lang = 'EN';
  m.nameLang = 'de';
  m.descriptionLang = 'fr';
  m.terms = [
    newTerm({ name: 'Person', description: 'A human being.' }),
    newTerm({
      name: 'Organisation',
      description: 'A body of people.',
      fields: [
        field('rdfs:label', 'Organisation', { lang: 'fr' }),
        field('skos:prefLabel', 'Organisatie', { lang: 'nl' }),
        field('dcterms:title', 'Vereniging', { lang: 'nl' }),
        field('rdfs:comment', 'Een groep mensen.', { lang: 'nl' }),
        // Not a name or a description: a link, a typed value, an empty value.
        field('rdfs:label', 'http://example.org/org', { iri: true, lang: 'es' }),
        field('rdfs:label', '42', { dt: 'xsd:integer', lang: 'es' }),
        field('rdfs:label', '   ', { lang: 'es' }),
      ],
    }),
    newTerm({ name: 'Persona', nameLang: 'es', description: 'Un ser humano.', descriptionLang: 'es' }),
  ];
  m.props = [newProp({ name: 'knows', nameLang: 'it' })];
  m.annProps = [newAnnotationProp({ name: 'note', nameLang: 'pt', fields: [field('rdfs:label', 'nota', { lang: 'ja' })] })];
  return m;
}

describe('what an entity is called', () => {
  it('is its own name in the model language, and a label in the language asked for', () => {
    const m = languages();
    const [person, org, persona] = m.terms;
    // No language asked for: the names as they are.
    expect(nameIn(org, m.lang, '')).toBe('Organisation');
    // The model's own language, in another case: the name itself.
    expect(nameIn(person, m.lang, 'en')).toBe('Person');
    // Another language: the first label in it, whether rdfs:label, skos:prefLabel or dcterms:title.
    expect(nameIn(org, m.lang, 'nl')).toBe('Organisatie');
    // An entity whose name is in the language asked for gives its name, whatever fields it has.
    expect(nameIn(persona, m.lang, 'es')).toBe('Persona');
    // A language it has no name in: its own name.
    expect(nameIn(org, m.lang, 'de')).toBe('Organisation');
    // A name tag is matched without regard to case.
    expect(nameIn(m.annProps[0], m.lang, 'PT')).toBe('note');
    expect(nameIn(m.annProps[0], m.lang, 'ja')).toBe('nota');
  });

  it('leaves out what is not a name, and reads a name written as a full IRI', () => {
    const org = languages().terms[1];
    // A link, a typed value and blank text are not names in Spanish.
    expect(labelFieldAt(org.fields, 'es')).toBe(-1);
    expect(nameIn(org, 'en', 'es')).toBe('Organisation');
    expect(labelFieldAt([field('http://www.w3.org/2000/01/rdf-schema#label', 'Nom', { lang: 'fr' })], 'fr')).toBe(0);
    expect(labelFieldAt([field('http://www.w3.org/2000/01/rdf-schema#label', 'Nom', { lang: 'fr' })], 'en')).toBe(-1);
    expect(labelFieldAt(undefined, 'fr')).toBe(-1);
    expect(labelFieldAt([], 'fr')).toBe(-1);
    // No language, no field: a name is never read from a field then.
    expect(labelFieldAt(org.fields, '')).toBe(-1);
  });

  it('gives the description in the language asked for, and its own otherwise', () => {
    const m = languages();
    const [person, org, persona] = m.terms;
    expect(descriptionIn(person, m.lang, '')).toBe('A human being.');
    expect(descriptionIn(person, m.lang, 'en')).toBe('A human being.');
    expect(descriptionIn(org, m.lang, 'nl')).toBe('Een groep mensen.');
    expect(descriptionIn(persona, m.lang, 'es')).toBe('Un ser humano.');
    expect(descriptionIn(org, m.lang, 'de')).toBe('A body of people.');
    expect(descriptionIn(newTerm({ name: 'Nothing' }), 'en', 'en')).toBe('');
    expect(descriptionFieldAt(org.fields, 'nl')).toBe(3);
    expect(descriptionFieldAt(org.fields, 'fr')).toBe(-1);
  });
});

describe('the languages a model has', () => {
  it('are its own first, then every other one it names anything in, each once and in lower case', () => {
    expect(modelLanguages(languages())).toEqual(['en', 'de', 'es', 'fr', 'it', 'ja', 'nl', 'pt']);
    // A model with no language at all has none.
    expect(modelLanguages(emptyModel('Bare'))).toEqual([]);
    // The same language written in two cases is one language.
    const m = emptyModel('One');
    m.lang = 'en';
    m.terms = [newTerm({ name: 'A', nameLang: 'EN' })];
    expect(modelLanguages(m)).toEqual(['en']);
  });
});

describe('standard annotation fields', () => {
  it('are known by their prefixed name or their full IRI, whatever the case', () => {
    expect(standardFieldKey('rdfs:label')).toBe('rdfs:label');
    expect(standardFieldKey('RDFS:Label')).toBe('rdfs:label');
    expect(standardFieldKey('http://www.w3.org/2000/01/rdf-schema#label')).toBe('rdfs:label');
    expect(standardFieldKey('http://www.w3.org/2004/02/skos/core#prefLabel')).toBe('skos:prefLabel');
    expect(standardFieldKey('data owner')).toBeUndefined();
    expect(standardFieldKey('http://example.org/own#label')).toBeUndefined();
    expect(standardFieldKey('')).toBeUndefined();
  });
});

describe('a language tag', () => {
  it('is named where the reader’s locale knows it, and is itself where it does not', () => {
    expect(languageName('')).toBe('untagged');
    // Not a language tag at all: it is shown as written.
    expect(languageName('not a tag!')).toBe('not a tag!');
    expect(languageName('zz')).toBe('zz');
    expect(languageName('en')).not.toBe('');
  });
});

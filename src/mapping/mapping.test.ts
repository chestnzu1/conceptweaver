import { describe, expect, it } from 'vitest';
import { propDatatype } from '../model/domains';
import { withIris } from '../model/iri';
import { toTurtle } from '../model/rdf';
import { sampleModel } from '../model/sample';
import { emptyModel, newTerm, type Model } from '../model/types';
import { parseDelimited, tableOf } from '../import/delimited';
import type { Table, TabularMapping } from './contracts';
import { applyPlan, planImport } from './plan';
import { fillTemplate, parseTemplate } from './template';
import { convert } from './values';

/** The mapping core (roadmap task 2.4, ADR-019): IRI templates, value conversion, and the plan of an import with its reasons. */

const csv = (text: string): Table => {
  const { rows, lines } = parseDelimited(text);
  return tableOf(rows, lines, 1);
};
const base = (): Model => ({ ...emptyModel('Films'), baseIri: 'http://example.org/f#' });

describe('IRI templates', () => {
  it('fill placeholders with values as written, encoded, or made into names', () => {
    const row: Record<string, string> = { Code: 'A 12/é', Name: 'Running time' };
    const at = (t: string) => fillTemplate(parseTemplate(t), (c) => row[c]);
    expect(at('http://example.org/p/{Code}')).toEqual({ iri: 'http://example.org/p/A%2012/é' });
    expect(at('http://example.org/f#{Name:name}')).toEqual({ iri: 'http://example.org/f#RunningTime' });
    // Braces written twice are braces; an IRI cannot hold one, and says so.
    expect(parseTemplate('a{{b}}c{Code}')).toEqual([{ text: 'a{b}c' }, { column: 'Code', style: 'encoded' }]);
    expect(at('http://example.org/{{x}}/{Code}')).toMatchObject({ error: expect.stringContaining('is not an IRI') });
    expect(at('http://example.org/{Missing}')).toEqual({ error: 'there is no column “Missing” for the IRI' });
    expect(fillTemplate(parseTemplate('http://e/{Code}'), () => ' ')).toEqual({ error: 'it has no value for Code, which its IRI is made from' });
    expect(at('{Name:name}')).toMatchObject({ error: expect.stringContaining('is not an IRI') });
    expect(() => parseTemplate('http://e/{Code')).toThrow('not closed');
  });
});

describe('values', () => {
  it('are made into literals of their datatype, as the datatype writes them, or say why not', () => {
    expect(convert(' Yes ', 'xsd:boolean')).toEqual({ value: 'true' });
    expect(convert('1,234.50', 'xsd:decimal')).toEqual({ value: '1234.50' });
    expect(convert('1.234,5', 'xsd:decimal')).toEqual({ value: '1234.5' });
    expect(convert('12,5', 'xsd:double')).toEqual({ value: '12.5' });
    expect(convert('2 000', 'xsd:integer')).toEqual({ value: '2000' });
    expect(convert('42.0', 'xsd:integer')).toEqual({ value: '42' });
    expect(convert('2026/10/6', 'xsd:date')).toEqual({ value: '2026-10-06' });
    expect(convert('2026-10-16 09:30', 'xsd:dateTime')).toEqual({ value: '2026-10-16T09:30:00' });
    expect(convert('abc', 'xsd:decimal')).toEqual({ error: '“abc” is not a decimal number (xsd:decimal). It should look like 3.14' });
    expect(convert('16/10/2026', 'xsd:date')).toMatchObject({ error: expect.stringContaining('is not a date') });
    expect(convert('as written', undefined)).toEqual({ value: 'as written' });
  });
});

describe('the plan of an import', () => {
  it('makes 2,000 rows with parent references a hierarchy, and skips a row whose parent is missing, by its row number', () => {
    const lines = ['Code,Label,Parent'];
    for (let i = 1; i <= 2000; i++) lines.push(`C${i},Class ${i},${i === 1 ? '' : `C${Math.floor(i / 2)}`}`);
    lines.push('C2001,Orphan,C9999');
    const table = csv(lines.join('\n'));
    const mapping: TabularMapping = { rows: 'class', iri: 'http://example.org/f#{Code}', columns: { Label: { as: 'name' }, Parent: { as: 'parent' } } };
    const plan = planImport(base(), table, mapping);
    expect(plan.counts).toEqual({ create: 2000, update: 0, unchanged: 0, exists: 0, skip: 1, notes: 0 });
    expect(plan.rows[2000]).toMatchObject({ row: 2002, status: 'skip', reason: 'its Parent, “C9999”, is neither a row of the table nor a class of the model' });
    const { model } = applyPlan(base(), plan);
    expect(model.terms).toHaveLength(2000);
    expect(model.terms.some((t) => t.name === 'Orphan')).toBe(false);
    const byId = new Map(model.terms.map((t) => [t.id, t]));
    const parents = model.relations.filter((r) => r.kind === 'generalization').map((r) => `${byId.get(r.from)!.name} < ${byId.get(r.to)!.name}`);
    expect(parents).toHaveLength(1999);
    expect(parents).toContain('Class 7 < Class 3');
    expect(model.terms.find((t) => t.name === 'Class 7')!.iri).toBe('http://example.org/f#C7');
  });

  it('skips a row under a skipped row, a row whose IRI another has, and leaves what the model has as it is', () => {
    const m = withIris({ ...base(), terms: [newTerm({ name: 'Thing B', iri: 'http://example.org/f#B' })] });
    const table = csv('Code,Label,Parent\nA,Alpha,Nowhere\nA1,Under alpha,A\nA2,Under under,A1\nB,Bee,\nB1,Under bee,B\nB1,Again,B\n,No code,');
    const plan = planImport(m, table, { rows: 'class', iri: 'http://example.org/f#{Code}', columns: { Label: { as: 'name' }, Parent: { as: 'parent' } } });
    expect(plan.rows.map((r) => `${r.row} ${r.status} ${r.reason ?? ''}`.trim())).toEqual([
      '2 skip its Parent, “Nowhere”, is neither a row of the table nor a class of the model',
      '3 skip what it is under, row 2, is skipped',
      '4 skip what it is under, row 3, is skipped',
      '5 exists it is in the model already, as “Thing B”, and is left as it is',
      '6 create',
      '7 skip row 6 has the same IRI, http://example.org/f#B1',
      '8 skip it has no value for Code, which its IRI is made from',
    ]);
    // What is under a row the model has goes under the entity in the model.
    const { model } = applyPlan(m, plan);
    const b1 = model.terms.find((t) => t.name === 'Under bee')!;
    expect(model.relations.find((r) => r.from === b1.id)!.to).toBe(m.terms[0].id);
    // Imported again, nothing is made, and it says so.
    expect(planImport(model, table, { rows: 'class', iri: 'http://example.org/f#{Code}', columns: { Label: { as: 'name' }, Parent: { as: 'parent' } } }).counts.create).toBe(0);
  });

  it('makes individuals of a class, with data values converted, links, annotations in a language; leaves out what cannot be', () => {
    const m = withIris(sampleModel());
    const film = m.terms.find((t) => t.name === 'Film')!;
    const release = m.terms.find((t) => t.name === 'Release date')!;
    const running = m.terms.find((t) => t.name === 'Running time')!;
    const wins = m.props.find((p) => p.name === 'wins')!;
    expect(propDatatype(running)).toBe('xsd:integer');
    const table = csv('ID;Title;Released;Minutes;Won;Note;Seen\nf9;Alien;1979-05-25;117;;Sci-fi horror;yes\nf10;Heat;13/12/1995;170 min;Oscar;Crime;\nf11;Up;2009-05-29;96;f10;Animated;');
    const mapping: TabularMapping = {
      rows: 'individual',
      classIri: film.iri,
      iri: 'http://example.org/film-knowledge-graph#{Title:name}',
      // Rows refer to each other by their ID; the IRI is made from the title.
      key: 'ID',
      columns: { Title: { as: 'name' }, Released: { as: 'value', property: release.iri! }, Minutes: { as: 'value', property: running.iri! }, Won: { as: 'link', property: wins.iri! }, Note: { as: 'annotation', property: 'skos:note', lang: 'en' } },
    };
    const plan = planImport(m, table, mapping);
    expect(plan.counts).toMatchObject({ create: 3, skip: 0 });
    expect(plan.rows[1].notes).toEqual([
      'Released “13/12/1995” is left out: “13/12/1995” is not a date (xsd:date). It should look like 2024-05-17',
      'Minutes “170 min” is left out: “170 min” is not a whole number (xsd:integer). It should look like 42',
      'the link by “wins” to “Oscar” is left out: it is neither a row of the table nor in the model',
    ]);
    const { model } = applyPlan(m, plan);
    const alien = model.terms.find((t) => t.name === 'Alien')!;
    expect(alien).toMatchObject({ type: 'instance', iri: 'http://example.org/film-knowledge-graph#Alien', fields: [{ key: 'skos:note', value: 'Sci-fi horror', lang: 'en' }] });
    expect(alien.values).toEqual([
      { prop: release.id, value: '1979-05-25' },
      { prop: running.id, value: '117' },
    ]);
    const ttl = toTurtle(model);
    expect(ttl).toMatch(/:Alien a owl:NamedIndividual ?, :Film/);
    expect(ttl).toContain(':runningTime "117"^^xsd:integer');
    // A link between two rows, by the object property: Up wins Heat (as nonsensical as the data).
    const up = model.terms.find((t) => t.name === 'Up')!;
    const heat = model.terms.find((t) => t.name === 'Heat')!;
    expect(model.relations.some((r) => r.from === up.id && r.to === heat.id && r.prop === wins.id)).toBe(true);
  });

  it('plans 20,000 rows in well under a second', () => {
    const lines = ['Code,Label,Parent'];
    for (let i = 1; i <= 20000; i++) lines.push(`C${i},Class ${i},${i === 1 ? '' : `C${Math.floor(i / 2)}`}`);
    const table = csv(lines.join('\n'));
    const t0 = performance.now();
    const plan = planImport(base(), table, { rows: 'class', iri: 'http://example.org/f#{Code}', columns: { Label: { as: 'name' }, Parent: { as: 'parent' } } });
    const ms = performance.now() - t0;
    expect(plan.counts.create).toBe(20000);
    expect(ms).toBeLessThan(1000);
  });
});

describe('update mode', () => {
  it('changes only what a matched row says differently, shows every change, and makes a row the model does not have', () => {
    const m = withIris(sampleModel());
    const film = m.terms.find((t) => t.name === 'Film')!;
    const release = m.terms.find((t) => t.name === 'Release date')!;
    const running = m.terms.find((t) => t.name === 'Running time')!;
    const wins = m.props.find((p) => p.name === 'wins')!;
    const mapping: TabularMapping = {
      rows: 'individual',
      classIri: film.iri,
      // The key column makes the IRI, so a row whose title changes is still the same entity.
      iri: 'http://example.org/film-knowledge-graph#{ID}',
      key: 'ID',
      update: true,
      columns: {
        Title: { as: 'name' },
        Released: { as: 'value', property: release.iri! },
        Minutes: { as: 'value', property: running.iri! },
        Won: { as: 'link', property: wins.iri! },
        Note: { as: 'annotation', property: 'skos:note', lang: 'en' },
      },
    };
    const first = csv('ID;Title;Released;Minutes;Won;Note\nf9;Alien;1979-05-25;117;;Sci-fi horror\nf10;Heat;1995-12-13;170;;Crime');
    const once = applyPlan(m, planImport(m, first, mapping)).model;
    const alien = once.terms.find((t) => t.name === 'Alien')!;
    const at = { x: alien.x, y: alien.y };

    // The same rows, with one name, one date and one number changed, a link added, and a row the model does not have.
    const next = csv('ID;Title;Released;Minutes;Won;Note\nf9;Alien 3;;116;f10;Sci-fi horror\nf10;Heat;1995-12-13;170;;Crime\nf11;Up;2009-05-29;96;;Animated');
    const plan = planImport(once, next, mapping);
    expect(plan.counts).toMatchObject({ create: 1, update: 1, unchanged: 1, exists: 0, skip: 0 });
    expect(plan.rows[0]).toMatchObject({
      status: 'update',
      changes: [
        { what: 'Name', from: '“Alien”', to: '“Alien 3”' },
        { what: 'Value of “Release date”', from: '“1979-05-25”', to: 'none' },
        { what: 'Value of “Running time”', from: '“117”', to: '“116”' },
        { what: 'Link by “wins”', from: 'none', to: '“Heat”' },
      ],
    });
    expect(plan.rows[1]).toMatchObject({ status: 'unchanged' });
    expect(plan.rows[2]).toMatchObject({ status: 'create' });

    const applied = applyPlan(once, plan);
    expect(applied.updated).toEqual([alien.id]);
    expect(applied.terms).toHaveLength(1);
    const after = applied.model;
    const renamed = after.terms.find((t) => t.id === alien.id)!;
    expect(renamed.name).toBe('Alien 3');
    expect(renamed).toMatchObject(at);
    expect(renamed.values).toEqual([{ prop: running.id, value: '116' }]);
    expect(renamed.fields).toEqual([{ key: 'skos:note', value: 'Sci-fi horror', lang: 'en' }]);
    const heat = after.terms.find((t) => t.name === 'Heat')!;
    expect(after.relations.some((r) => r.from === alien.id && r.to === heat.id && r.prop === wins.id)).toBe(true);
    // What no column speaks for is left as it was.
    expect(after.terms.find((t) => t.name === 'Heat')).toBe(once.terms.find((t) => t.name === 'Heat'));

    // The same file again changes nothing, and says so.
    const again = planImport(after, next, mapping);
    expect(again.counts).toMatchObject({ create: 0, update: 0, unchanged: 3, skip: 0 });
    expect(again.rows.every((r) => r.status === 'unchanged')).toBe(true);
    expect(applyPlan(after, again).model).toBe(after);
  });

  it('matches by the IRI a column gives, leaves the name when the name column is empty, and keeps what no column speaks for', () => {
    const m: Model = withIris({ ...base(), terms: [newTerm({ name: 'Thing', iri: 'http://example.org/f/thing/T1', description: 'Old' })] });
    const table = csv('IRI;Label;Note\nhttp://example.org/f/thing/T1;;New note\nhttp://example.org/f/thing/T2;Other;Other note');
    const mapping: TabularMapping = { rows: 'class', iri: '{IRI}', update: true, columns: { Label: { as: 'name' }, Note: { as: 'annotation', property: 'skos:note' } } };
    const plan = planImport(m, table, mapping);
    expect(plan.rows[0]).toMatchObject({ status: 'update', name: 'Thing', changes: [{ what: 'Annotation skos:note', from: 'none', to: '“New note”' }] });
    expect(plan.rows[0].notes).toEqual(['it has no Label: its name is left as it is']);
    expect(plan.rows[1]).toMatchObject({ status: 'create', name: 'Other' });
    const { model } = applyPlan(m, plan);
    const thing = model.terms.find((t) => t.iri === 'http://example.org/f/thing/T1')!;
    expect(thing.name).toBe('Thing');
    expect(thing.description).toBe('Old');
    expect(thing.fields).toEqual([{ key: 'skos:note', value: 'New note' }]);
    expect(model.terms.find((t) => t.iri === 'http://example.org/f/thing/T2')!.name).toBe('Other');
  });
});

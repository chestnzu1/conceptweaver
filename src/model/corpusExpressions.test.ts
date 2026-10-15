import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORPUS, corpusFile, missing } from '../../corpus/corpus.mjs';
import { fromDraft, toDraft } from './expressionDraft';
import type { ClassExpression, DataRange } from './expressions';
import { readModelFile } from './files';
import { withIris } from './iri';
import { classText, dataText, formatClass, hasUnparsed, namingFor, parseClass, parseDataRange } from './manchester';
import { toTurtle } from './rdf';
import { decodeDocument } from './rdfFormats';
import { useStore } from './store';
import type { Model } from './types';
import { statementsOf } from './unmapped';

/**
 * Every class expression of the corpus (corpus/corpus.mjs) opens as structure, and survives an
 * edit of its class unchanged (Phase 2's acceptance, FR-M2-2): none is kept as text; each reads
 * back the same from its Manchester syntax, laid out or on one line, and from the blocks of the
 * visual editor; and renaming and describing every class that has one leaves every axiom of the
 * ontology as it was. Needs the corpus (pnpm corpus); an ontology not fetched yet is skipped.
 */
if (missing().length) console.warn(`Corpus class expressions: ${missing().map((e) => e.name).join(', ')} skipped, not fetched yet. Run “pnpm corpus”.`);

/** Every expression of a model, with the class or property it is stated of. */
function expressions(m: Model): { of: string; e: ClassExpression }[] {
  return [
    ...m.terms.flatMap((t) => [...(t.classAxioms ?? []).map((a) => a.expression), ...(t.domains ?? []).map((a) => a.expression)].map((e) => ({ of: t.id, e }))),
    ...m.props.flatMap((p) => [...(p.domains ?? []), ...(p.ranges ?? [])].map((a) => ({ of: p.id, e: a.expression }))),
  ];
}
const dataRanges = (m: Model): DataRange[] => m.terms.flatMap((t) => (t.ranges ?? []).map((a) => a.range));
/** The axioms of an export, statement by statement: what classes and properties are said to be. */
const axioms = (m: Model) => statementsOf(toTurtle(m)).map((s) => s.text).filter((t) => /#(subClassOf|equivalentClass|disjointWith|domain|range)> /.test(t)).sort();

describe('the class expressions of the corpus', () => {
  for (const entry of CORPUS) {
    it.skipIf(!fs.existsSync(corpusFile(entry)))(`${entry.name}: each opens as structure, reads back the same, and survives an edit of its class`, async () => {
      const { model } = await readModelFile(decodeDocument(new Uint8Array(fs.readFileSync(corpusFile(entry)))), entry.file);
      const m = withIris(model);
      const n = namingFor(m);
      const all = expressions(m);
      const ranges = dataRanges(m);
      expect(all.length + ranges.length).toBeGreaterThan(0);
      expect(all.filter((x) => hasUnparsed(x.e)).map((x) => classText(x.e, n))).toEqual([]);
      expect(ranges.filter(hasUnparsed).map((r) => dataText(r, n))).toEqual([]);
      for (const { e } of all) {
        expect(parseClass(classText(e, n), n)).toEqual(e);
        expect(parseClass(formatClass(e, n), n)).toEqual(e);
        expect(fromDraft(toDraft(e), 'class').value).toEqual(e);
      }
      for (const r of ranges) {
        expect(parseDataRange(dataText(r, n), n)).toEqual(r);
        expect(fromDraft(toDraft(r), 'data').value).toEqual(r);
      }

      // Each class that has an expression renamed and described, an edit at a time, as in the editor.
      const st = useStore.getState;
      st().replaceModel(m);
      const before = axioms(st().model);
      const classes = new Set(all.map((x) => x.of).filter((id) => m.terms.some((t) => t.id === id && t.type === 'concept')));
      for (const id of classes) {
        const t = st().model.terms.find((x) => x.id === id)!;
        st().updateTerm(id, { name: `${t.name} (edited)` });
        st().updateTerm(id, { description: 'Edited.' });
      }
      expect(st().model.terms.filter((t) => classes.has(t.id)).every((t) => t.name.endsWith('(edited)'))).toBe(true);
      expect(axioms(st().model)).toEqual(before);
    }, 120_000);
  }
});

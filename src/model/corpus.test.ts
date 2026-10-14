import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORPUS, corpusFile, missing, type CorpusEntry } from '../../corpus/corpus.mjs';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import { readModelFile } from './files';
import { withIris } from './iri';
import { toTurtle } from './rdf';
import { decodeDocument, FORMAT_LABEL, type DocumentFormat } from './rdfFormats';

/**
 * The round trip of the corpus (corpus/corpus.mjs): each ontology is opened as the app opens a
 * file, saved as Turtle without a change, and the two are compared by the OWL service, statement
 * by statement. What is lost today is the expected result, in corpus/expected/<id>.txt, so that
 * a fix, or a new loss, shows as a change to that file. When a change is meant, record it with
 *
 *   pnpm exec vitest run src/model/corpus.test.ts -u
 *
 * Needs Java and the service's libraries, and the corpus (pnpm corpus); skipped, saying so, without.
 * With CORPUS_SAVED=<directory>, what was saved of each is written there as <id>.ttl, to look at.
 */
const why = unavailable();
if (why) console.warn(`Round-trip corpus skipped: ${why}`);
else if (missing().length) console.warn(`Round-trip corpus: ${missing().map((e) => e.name).join(', ')} skipped, not fetched yet. Run “pnpm corpus”.`);

interface Comparison {
  errors: string[];
  original: { format: string; axioms: number };
  exported: { format: string; axioms: number };
  removed: string[];
  added: string[];
}

/** How many statements of each kind: SubClassOf 3, Declaration 2. */
const kinds = (lines: string[]) => {
  const n = new Map<string, number>();
  for (const l of lines) {
    const kind = /^(\w+)\(/.exec(l)?.[1] ?? 'other';
    n.set(kind, (n.get(kind) ?? 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, c]) => `${k} ${c}`).join(', ');
};
// One statement to a line: a literal may hold line breaks.
const oneLine = (s: string) => '  ' + s.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');

function report(entry: CorpusEntry, format: DocumentFormat, leftOut: string[], c: Comparison): string {
  return [
    `${entry.name} (${entry.file}, read as ${FORMAT_LABEL[format]}), opened in ConceptWeaver and saved as Turtle`,
    'unchanged, then compared with the original by the OWL API: axioms by structure, and the',
    "ontology's IRI, annotations and imports.",
    '',
    `Original: ${c.original.axioms} axioms. Saved: ${c.exported.axioms} axioms.`,
    `Lost: ${c.removed.length}${c.removed.length ? ` (${kinds(c.removed)})` : ''}.`,
    `Added: ${c.added.length}${c.added.length ? ` (${kinds(c.added)})` : ''}.`,
    `Said to be left out when it was opened: ${leftOut.length ? leftOut.join(', ') : 'nothing'}.`,
    '',
    'Lost: in the original, not in what was saved',
    ...c.removed.map(oneLine),
    '',
    'Added: in what was saved, not in the original',
    ...c.added.map(oneLine),
    '',
  ].join('\n');
}

describe.skipIf(why)('round trip of the corpus', () => {
  let service: Awaited<ReturnType<typeof startReasoner>>;
  beforeAll(async () => {
    service = await startReasoner({ port: 5193, quiet: true });
  }, 120_000);
  afterAll(() => service?.stop());

  for (const entry of CORPUS) {
    it.skipIf(!fs.existsSync(corpusFile(entry)))(`${entry.name}: what is lost or added on a round trip is what was recorded`, async () => {
      const original = decodeDocument(new Uint8Array(fs.readFileSync(corpusFile(entry))));
      const { model, format, leftOut } = await readModelFile(original, entry.file, { serviceUrl: service.url });
      // As the editor holds an opened model, and as Download as Turtle writes it.
      const saved = toTurtle(withIris(model));
      if (process.env.CORPUS_SAVED) fs.writeFileSync(`${process.env.CORPUS_SAVED}/${entry.id}.ttl`, saved);
      const response = await fetch(`${service.url}/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ original, exported: saved }) });
      const comparison = (await response.json()) as Comparison;
      expect(comparison.errors).toEqual([]);
      await expect(report(entry, format, leftOut, comparison)).toMatchFileSnapshot(`../../corpus/expected/${entry.id}.txt`);
    }, 120_000);
  }
});

// The round-trip corpus: public ontologies that the app should open and save without losing a
// statement (NFR-1, FR-M1-8). src/model/corpus.test.ts opens each, saves it unchanged and has
// the OWL service compare the two; what is lost today is in corpus/expected/.
//
//   node corpus/corpus.mjs      (pnpm corpus) fetches the files that are not there yet, and the
//                               W3C SHACL Core test suite (corpus/shacl.mjs)
//
// The files are not kept in the repository: each is fetched from where it is published, at a
// fixed version, and checked against its SHA-256, so the corpus is the same everywhere. A file
// whose source has changed is refused, not taken: the corpus changes only by changing this list
// (and then the expected results).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchShaclSuite } from './shacl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FILES = path.join(here, 'files');

export const CORPUS = [
  {
    id: 'pizza',
    name: 'Pizza',
    file: 'pizza.owl',
    // The version of 2016, in the co-ode.org namespace that tools and tutorials know; the one of
    // 2025 moved every IRI to the address of the file on GitHub.
    url: 'https://raw.githubusercontent.com/owlcs/pizza-ontology/dc48fca9142ab9ba63fb2cfb8732c1129278ffdf/pizza.owl',
    sha256: 'f1af596252f2e2a9f2df85bc64a9384dcf88a558084c25add5ffedca163ba45a',
    about: 'The Manchester OWL tutorial ontology: defined classes, closure axioms, value partitions, SKOS labels. RDF/XML.',
  },
  {
    id: 'wine',
    name: 'Wine',
    file: 'wine.rdf',
    url: 'https://www.w3.org/TR/owl-guide/wine.rdf',
    sha256: 'bb1666593f9d7ba2ec9cb06dd4fcc17751ac8d523dc33ce22bcee6beeda778eb',
    about: 'The OWL Guide example (W3C, 2004): enumerations, hasValue restrictions, individuals. Imports Food, which is not read. RDF/XML.',
  },
  {
    id: 'koala',
    name: 'Koala',
    file: 'koala.owl',
    url: 'https://raw.githubusercontent.com/owlcs/owlapi/owlapi-parent-4.5.29/contract/src/test/resources/koala.owl',
    sha256: '81add809c95c37045fa91c0f4477851dcd787ab443cabb8c8a10b6f18ef2785b',
    about: 'The Protégé example, as the OWL API tests keep it: cardinalities, hasValue, data properties. RDF/XML.',
  },
  {
    id: 'prov-o',
    name: 'PROV-O',
    file: 'prov-o.ttl',
    url: 'https://www.w3.org/ns/prov-o-20130430',
    sha256: '3d03c8e15753178541fb8cd59fbefecaf1861f9c37ef75190c6e938b85fb0c3d',
    about: 'The W3C provenance ontology, 2013-04-30: property chains, axiom annotations, annotation properties of its own. Turtle.',
  },
  {
    id: 'skos',
    name: 'SKOS',
    file: 'skos.rdf',
    url: 'https://www.w3.org/2009/08/skos-reference/skos.rdf',
    sha256: 'e79633b8d0564816cee8a99f5c9acf9a0e6fc7257c7209acd684ecad53a89dd6',
    about: 'The SKOS vocabulary itself (W3C, 2009): annotation-heavy, sub-properties, disjointness. RDF/XML.',
  },
  {
    id: 'time',
    name: 'OWL-Time',
    file: 'time.ttl',
    url: 'https://www.w3.org/2006/time.ttl',
    sha256: '251bd6970b0d7a5efa97ff681afe81a297df85deab3d860fa4f8eeba72d8f16c',
    about: 'The W3C time ontology as published at its namespace: data properties, unions, qualified cardinalities. Turtle.',
  },
  {
    id: 'foaf',
    name: 'FOAF',
    file: 'foaf.rdf',
    url: 'https://xmlns.com/foaf/spec/20140114.rdf',
    sha256: '3d859b5d92a2c3d041545d014fa826f682ca06d056af8c7b31e32d930abf2bc5',
    about: 'Friend of a Friend, 2014-01-14: RDFS and OWL mixed, inverse functional properties, external vocabularies. RDF/XML.',
  },
  {
    id: 'primer',
    name: 'OWL 2 Primer example',
    file: 'primer.owl',
    url: 'https://raw.githubusercontent.com/owlcs/owlapi/owlapi-parent-4.5.29/contract/src/test/resources/primer.rdfxml.xml',
    sha256: 'ecb69210f776f0df343f440137217f10fa66090dea7dda671bf849d432a29d4f',
    about: 'The complete example of the W3C OWL 2 Primer: property chains, keys, negative property assertions, disjoint unions, axiom annotations. RDF/XML.',
  },
  {
    id: 'ro-core',
    name: 'Relation Ontology, core',
    file: 'ro-core.owl',
    url: 'https://raw.githubusercontent.com/oborel/obo-relations/v2025-12-17/core.owl',
    sha256: '3bf41e9e0de4f191357903c4ec1a1e86c93b18675b6bff911a4762ad370d57eb',
    about: 'The core relations of the OBO Relation Ontology, release 2025-12-17: property chains and axiom annotations, as OBO ontologies write them. RDF/XML.',
  },
];

export const corpusFile = (entry) => path.join(FILES, entry.file);

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The entries whose file is not there yet. */
export const missing = () => CORPUS.filter((e) => !fs.existsSync(corpusFile(e)));

/** Fetches every file that is not there, and checks each. Throws on the first that cannot be had as listed. */
export async function fetchCorpus(log = console.log) {
  fs.mkdirSync(FILES, { recursive: true });
  for (const entry of missing()) {
    log(`Fetching ${entry.name}: ${entry.url}`);
    const response = await fetch(entry.url);
    if (!response.ok) throw new Error(`${entry.name} could not be fetched (${response.status}) from ${entry.url}.`);
    const partial = corpusFile(entry) + '.part';
    fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    const got = sha256(partial);
    if (got !== entry.sha256) {
      fs.rmSync(partial);
      throw new Error(`What was fetched for ${entry.name} is not the version listed (sha256 ${got}): its source has changed. Nothing was kept.`);
    }
    fs.renameSync(partial, corpusFile(entry));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const before = missing().length;
    await fetchCorpus();
    console.log(before ? `The corpus is complete: ${CORPUS.length} ontologies in ${path.relative(process.cwd(), FILES)}.` : `The corpus was already complete (${CORPUS.length} ontologies).`);
    // And the W3C SHACL Core test suite (corpus/shacl.mjs).
    await fetchShaclSuite();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

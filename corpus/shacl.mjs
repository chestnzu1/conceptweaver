// The W3C SHACL 1.0 Core test suite (https://w3c.github.io/data-shapes/data-shapes-test-suite/):
// the shapes the editor must hold without losing a statement (roadmap stage SH-1) and, each with
// its data and expected report, the conformance suite for validation (SH-2).
//
//   pnpm corpus      fetches these with the round-trip corpus, if they are not there yet
//
// The files are fetched at a fixed commit of the W3C repository, the last to change the Core tests
// (2019-03-31, an erratum); which files is read from the suite's own manifests, which include one
// another. All of them together are checked against one SHA-256, so the suite is the same
// everywhere, and a changed source is refused, not taken.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHACL_FILES = path.join(here, 'shacl');

export const SHACL_SUITE = {
  commit: 'b5f4d0c8a3722ea20407ab9a2ac6a45fddfd7c09',
  root: 'data-shapes-test-suite/tests/core',
  /** Over every file, in the order of their paths: each path, a newline, the file, a newline. */
  sha256: '9f03a964363b02f3ca49811c60fc8ebef40f11d3ad2891623d89f2db65695abe',
};

/** Where a file of the suite is published, at the commit. */
export const shaclUrl = (file) => `https://raw.githubusercontent.com/w3c/data-shapes/${SHACL_SUITE.commit}/${SHACL_SUITE.root}/${file}`;
/** The address the suite's files resolve their relative IRIs against, as its manifests do. */
export const shaclBase = (file) => `https://w3c.github.io/data-shapes/data-shapes-test-suite/tests/core/${file}`;

const LIST = path.join(SHACL_FILES, 'files.txt');

/** The files of the suite (paths below its root), once it has been fetched; none before. */
export function shaclFiles() {
  return fs.existsSync(LIST) ? fs.readFileSync(LIST, 'utf8').split('\n').filter(Boolean) : [];
}

/** The test files: those that are not manifests. */
export const shaclTests = () => shaclFiles().filter((f) => !f.endsWith('manifest.ttl'));

export const shaclFile = (file) => path.join(SHACL_FILES, file);

/** The digest of the files as listed, to compare with the pinned one. */
export function digest(files, read) {
  const h = createHash('sha256');
  for (const f of [...files].sort()) h.update(f + '\n').update(read(f)).update('\n');
  return h.digest('hex');
}

/** Fetches the suite if it is not there, following its manifests from the top. Throws if it cannot be had as pinned. */
export async function fetchShaclSuite(log = console.log) {
  if (shaclFiles().length) return;
  log(`Fetching the W3C SHACL Core test suite at ${SHACL_SUITE.commit.slice(0, 7)}`);
  const got = new Map();
  const todo = ['manifest.ttl'];
  while (todo.length) {
    const file = todo.shift();
    if (got.has(file)) continue;
    const response = await fetch(shaclUrl(file));
    if (!response.ok) throw new Error(`The SHACL test ${file} could not be fetched (${response.status}).`);
    const text = await response.text();
    got.set(file, text);
    // A manifest includes others, and the tests, by relative IRI; a test names its data and shapes
    // graphs, most often itself (<>), sometimes files of their own.
    const dir = path.posix.dirname(file);
    for (const m of text.matchAll(/(?:mf:include|sht:dataGraph|sht:shapesGraph)\s+<([^>]+)>/g)) todo.push(path.posix.normalize(path.posix.join(dir, m[1])));
  }
  const sum = digest(got.keys(), (f) => got.get(f));
  if (sum !== SHACL_SUITE.sha256) throw new Error(`What was fetched of the SHACL test suite is not the version pinned (sha256 ${sum}). Nothing was kept.`);
  for (const [file, text] of got) {
    fs.mkdirSync(path.dirname(shaclFile(file)), { recursive: true });
    fs.writeFileSync(shaclFile(file), text);
  }
  fs.writeFileSync(LIST, [...got.keys()].sort().join('\n') + '\n');
  log(`The SHACL Core test suite is here: ${got.size} files in ${path.relative(process.cwd(), SHACL_FILES)} (sha256 ${sum}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await fetchShaclSuite();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

// Starts the OWL 2 DL reasoning service: HermiT behind a small HTTP interface on this machine.
//
//   node reasoner/run.mjs [--port=5190] [--host=127.0.0.1] [--allow-origin=https://where.the.app.is]
//
// It needs Java 11 or later, with its compiler (a JDK). The first start fetches the libraries
// (the OWL API, HermiT and the explanation library, as the one file the ROBOT project publishes
// them in) and compiles ReasonerService.java; after that it starts at once.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'ReasonerService.java');
const BUILD = path.join(here, 'build');
export const LIBRARY = {
  file: path.join(here, 'lib', 'robot.jar'),
  // ROBOT 1.9.6: OWL API 4.5.29, HermiT 1.4.5.456, owlexplanation 2.0.0.
  url: 'https://github.com/ontodev/robot/releases/download/v1.9.6/robot.jar',
  sha256: '3d112f47a5c2e82fd96c2bc40e582a86d1e6ad24f67648ef103ec5f21985ba5e',
};
export const DEFAULT_PORT = 5190;

const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

/** What stands in the way of running the service on this machine, in words; nothing when it can run. */
export function javaProblem() {
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (java.error || java.status !== 0) return 'Java was not found. The OWL 2 DL reasoner (HermiT) is a Java program: install a JDK, version 11 or later.';
  const major = Number(/version "(\d+)/.exec(java.stderr + java.stdout)?.[1] ?? 0);
  if (major && major < 11) return `Java ${major} was found; the reasoning service needs Java 11 or later.`;
  const compiled = fs.existsSync(path.join(BUILD, 'ReasonerService.class')) && fs.statSync(path.join(BUILD, 'ReasonerService.class')).mtimeMs >= fs.statSync(SOURCE).mtimeMs;
  if (!compiled && spawnSync('javac', ['-version'], { encoding: 'utf8' }).error) return 'The Java compiler (javac) was not found. Install a JDK, not only a Java runtime: the service is compiled on its first start.';
  return undefined;
}

/** Why the service cannot be started here without fetching anything, in words; nothing when it can. For tests, which do not go to the network. */
export function unavailable() {
  return javaProblem() ?? (fs.existsSync(LIBRARY.file) ? undefined : `The reasoner's libraries are not there yet (${path.relative(process.cwd(), LIBRARY.file)}). Start the service once with “pnpm reasoner” to fetch them.`);
}

/** Makes sure the libraries are there and the service is compiled. */
export async function prepare(log = console.log) {
  const problem = javaProblem();
  if (problem) throw new Error(problem);
  if (!fs.existsSync(LIBRARY.file)) {
    log(`Fetching the reasoner's libraries (about 90 MB, once): ${LIBRARY.url}`);
    fs.mkdirSync(path.dirname(LIBRARY.file), { recursive: true });
    const response = await fetch(LIBRARY.url);
    if (!response.ok || !response.body) throw new Error(`The libraries could not be fetched (${response.status}). Put robot.jar of ROBOT 1.9.6 at ${LIBRARY.file} by hand.`);
    const partial = LIBRARY.file + '.part';
    await pipeline(response.body, fs.createWriteStream(partial));
    const got = await sha256(partial);
    if (got !== LIBRARY.sha256) {
      fs.rmSync(partial);
      throw new Error(`What was fetched is not the file expected (sha256 ${got}). Nothing was installed.`);
    }
    fs.renameSync(partial, LIBRARY.file);
  }
  const target = path.join(BUILD, 'ReasonerService.class');
  if (!fs.existsSync(target) || fs.statSync(target).mtimeMs < fs.statSync(SOURCE).mtimeMs) {
    log('Compiling the reasoning service…');
    fs.mkdirSync(BUILD, { recursive: true });
    const javac = spawnSync('javac', ['-nowarn', '-cp', LIBRARY.file, '-d', BUILD, SOURCE], { encoding: 'utf8' });
    if (javac.status !== 0) throw new Error(`The reasoning service did not compile:\n${javac.stderr || javac.stdout}`);
  }
}

/** Starts the service and waits until it answers. `stop` ends it. */
export async function startReasoner({ port = DEFAULT_PORT, host = '127.0.0.1', allowOrigins = [], log = console.log, quiet = false } = {}) {
  await prepare(log);
  // Something already at that address would answer in place of the service started here, and never be stopped by it.
  const there = await fetch(`http://${host}:${port}/health`).then((r) => r.json()).catch(() => undefined);
  if (there) throw new Error(there.service === 'conceptweaver-reasoner' ? `The reasoning service is already running at http://${host}:${port}.` : `Port ${port} is in use by something else. Start the service on another: --port=<number>.`);
  const child = spawn('java', ['-Xmx2g', '-Djava.net.preferIPv4Stack=true', '-cp', [BUILD, LIBRARY.file].join(path.delimiter), 'ReasonerService', `--port=${port}`, `--host=${host}`, ...allowOrigins.map((o) => `--allow-origin=${o}`)], { stdio: ['ignore', quiet ? 'ignore' : 'inherit', quiet ? 'ignore' : 'inherit'] });
  const url = `http://${host}:${port}`;
  let exited;
  child.on('exit', (code) => (exited = code ?? 1));
  for (let i = 0; i < 150; i++) {
    if (exited !== undefined) throw new Error(`The reasoning service stopped as it started (exit ${exited}). Is port ${port} in use?`);
    try {
      const health = await (await fetch(url + '/health')).json();
      if (health.service === 'conceptweaver-reasoner') return { url, health, stop: () => new Promise((done) => (exited !== undefined ? done(exited) : (child.once('exit', done), child.kill()))) };
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('The reasoning service did not answer within 15 seconds.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const allowOrigins = process.argv.filter((a) => a.startsWith('--allow-origin=')).map((a) => a.slice('--allow-origin='.length));
  try {
    const service = await startReasoner({ port: Number(arg('port') ?? DEFAULT_PORT), host: arg('host') ?? '127.0.0.1', allowOrigins });
    const elsewhere = service.url === `http://127.0.0.1:${DEFAULT_PORT}` ? '' : ` and give it this address: ${service.url}`;
    console.log(`Leave this running. In the app: Validation → Reasoning engine → Advanced reasoner (OWL 2 DL)${elsewhere}. Ctrl+C stops it.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

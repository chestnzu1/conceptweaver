// Runs the benchmarks and keeps what they measure:
//
//   pnpm bench [output directory]
//
// The model layer (src/model/bench.test.ts) and the structure services (src/structure/bench.test.ts)
// on generated models; then, in the browser, the main thread on the 2,600-class model
// (scripts/main-thread.mjs) and the Graph view on it and on one of some 10,000 terms
// (scripts/canvas.mjs). The results go to bench-results/<date and time>/ unless a directory is
// given: model.txt, structure.txt, main-thread.txt, canvas.txt, and report.md, which puts them
// together with the machine and the commit they were measured on. Numbers from different machines
// do not compare.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bin, headlessShell, NO_BROWSER, root, run, seconds, startPreview } from './shared.mjs';

const started = performance.now();
const stamp = new Date().toISOString().slice(0, 16).replace(':', '');
const out = path.resolve(process.argv[2] ?? path.join(root, 'bench-results', stamp));
fs.mkdirSync(out, { recursive: true });
if (!headlessShell()) {
  console.error(`✗ The browser measurement cannot run: ${NO_BROWSER}`);
  process.exit(1);
}
const step = async (label, command, args, options) => {
  console.log(`\n▶ ${label}`);
  const t0 = performance.now();
  const result = await run(command, args, options);
  if (result.code !== 0) {
    console.error(`${result.output}\n✗ ${label} failed (exit ${result.code}).`);
    process.exit(1);
  }
  console.log(`✓ ${label} (${seconds(performance.now() - t0)})`);
  return result;
};

await step('model layer: src/model/bench.test.ts', bin('vitest'), ['run', 'src/model/bench.test.ts'], { env: { BENCH_OUT: path.join(out, 'model.txt') } });
await step('structure services: src/structure/bench.test.ts', bin('vitest'), ['run', 'src/structure/bench.test.ts'], { env: { BENCH_OUT: path.join(out, 'structure.txt') } });
await step('build', bin('vite'), ['build', '--logLevel', 'error']);
const { base, stop } = await startPreview();
// The model bench saves each generated model as it would be downloaded; the browser opens the largest.
const model = path.join(out, 'model.txt.2600.json');
const { output } = await step('main thread in the browser: scripts/main-thread.mjs', process.execPath, [path.join(root, 'scripts', 'main-thread.mjs'), model, base], { show: false });
const canvas = [];
for (const n of [2600, 6700]) canvas.push((await step(`Graph view in the browser, ${n} classes: scripts/canvas.mjs`, process.execPath, [path.join(root, 'scripts', 'canvas.mjs'), path.join(out, `model.txt.${n}.json`), base], { show: false })).output.trimEnd());
stop();
fs.writeFileSync(path.join(out, 'main-thread.txt'), output);
fs.writeFileSync(path.join(out, 'canvas.txt'), canvas.join('\n\n') + '\n');
for (const f of fs.readdirSync(out)) if (/^model\.txt\.\d+\.json$/.test(f)) fs.rmSync(path.join(out, f));

const git = (args) => { try { return execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };
const cpus = os.cpus();
const read = (f) => fs.readFileSync(path.join(out, f), 'utf8').trimEnd();
const report = `# Benchmarks, ${new Date().toISOString().slice(0, 10)}

- Commit: ${git('rev-parse --short HEAD') || 'unknown'}${git('status --porcelain') ? ' (with uncommitted changes)' : ''}
- Machine: ${cpus[0]?.model.trim() ?? 'unknown CPU'}, ${cpus.length} logical cores, ${Math.round(os.totalmem() / 2 ** 30)} GB; ${os.type()} ${os.release()}
- Node ${process.versions.node}

## Main thread in the browser (scripts/main-thread.mjs)

The longest task over 50 ms while the operation runs and the page settles. Phase 1's target: under 100 ms for an edit, a reasoner run and a validation run.

\`\`\`
${output.trimEnd()}
\`\`\`

## Graph view in the browser (scripts/canvas.mjs)

What is drawn and how smoothly it pans, with the whole model fitted and with some 300 terms in view. FR-M5-4's target: 30 frames a second with 10,000 terms loaded and 300 in view.

\`\`\`
${read('canvas.txt')}
\`\`\`

## Model layer (src/model/bench.test.ts)

\`\`\`
${read('model.txt')}
\`\`\`

## Structure services (src/structure/bench.test.ts)

\`\`\`
${read('structure.txt')}
\`\`\`
`;
fs.writeFileSync(path.join(out, 'report.md'), report);
console.log(`\n${output.trimEnd()}\n\n✓ Benchmarks done in ${seconds(performance.now() - started)}. Report: ${path.relative(process.cwd(), path.join(out, 'report.md'))}`);

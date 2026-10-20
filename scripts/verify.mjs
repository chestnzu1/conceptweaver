// Runs every check the project has and exits non-zero if any fails:
//
//   pnpm verify
//
// In order: type-check, lint, unit tests, build; then the built app is served on a free port and
// every browser script in e2e/ is run against it, the UI audit last. The first four stop at the
// first failure (the browser scripts need the build); the browser scripts all run, and those that
// fail are shown with their output at the end.
//
// The browser scripts need Chromium's headless shell:  pnpm exec playwright-core install chromium-headless-shell
// Those that need Java say SKIPPED where it, or the reasoner's libraries, are missing (reasoner/run.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { bin, headlessShell, NO_BROWSER, root, run, seconds, startPreview } from './shared.mjs';

const SCRIPT_TIMEOUT = 10 * 60_000;
const started = performance.now();

// ---- type-check, lint, unit tests, build
const steps = [
  ['type-check', 'tsc', ['--noEmit']],
  ['lint', 'oxlint', ['--deny-warnings']],
  ['unit tests', 'vitest', ['run', '--maxWorkers=4']],
  ['build', 'vite', ['build', '--logLevel', 'warn']],
];
for (const [label, name, args] of steps) {
  console.log(`\n▶ ${label}: ${name} ${args.join(' ')}`);
  const t0 = performance.now();
  const { code } = await run(bin(name), args);
  if (code !== 0) {
    console.error(`\n✗ ${label} failed (exit ${code}). verify stops here.`);
    process.exit(1);
  }
  console.log(`✓ ${label} (${seconds(performance.now() - t0)})`);
}

// ---- the browser scripts, against the built app
if (!headlessShell()) {
  console.error(`\n✗ The browser scripts cannot run: ${NO_BROWSER}`);
  process.exit(1);
}
const { base, stop } = await startPreview();
console.log(`\n▶ browser scripts, against the built app at ${base}`);
const scripts = fs.readdirSync(path.join(root, 'e2e')).filter((f) => f.endsWith('.mjs')).sort();
const order = [...scripts.filter((f) => f !== 'ui-audit.mjs'), ...scripts.filter((f) => f === 'ui-audit.mjs')];
const width = Math.max(...order.map((f) => f.length));
const failed = [];
for (const file of order) {
  const t0 = performance.now();
  const { code, output } = await run(process.execPath, [path.join('e2e', file), base], { show: false, timeout: SCRIPT_TIMEOUT });
  console.log(`${code === 0 ? '✓' : '✗'} ${file.padEnd(width)}  ${seconds(performance.now() - t0).padStart(7)}${code === 0 ? '' : `  exit ${code}`}`);
  for (const line of output.split('\n')) if (/^SKIP/.test(line)) console.log('    ' + line);
  if (code !== 0) failed.push({ file, output });
}
stop();

for (const { file, output } of failed) console.log(`\n───── ${file} ─────\n${output.trimEnd()}`);
const total = seconds(performance.now() - started);
if (failed.length) {
  console.error(`\n✗ ${failed.length} of ${order.length} browser scripts failed: ${failed.map((f) => f.file).join(', ')}. (${total})`);
  process.exit(1);
}
console.log(`\n✓ Everything passed: type-check, lint, unit tests, build and ${order.length} browser scripts. (${total})`);

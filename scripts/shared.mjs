// What scripts/verify.mjs and scripts/bench.mjs both need: running the project's tools, and
// serving the built app on a free port for the scripts that drive it in a browser.
import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const bin = (name) => path.join(root, 'node_modules', '.bin', name);
export const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const shell = process.platform === 'win32';

/** Runs a command in the project, its output shown or kept, and gives its exit code and what it printed. */
export const run = (command, args, { show = true, timeout, env } = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: show ? 'inherit' : ['ignore', 'pipe', 'pipe'], shell, env: env && { ...process.env, ...env } });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const timer = timeout && setTimeout(() => { output += `\n(stopped after ${seconds(timeout)})`; child.kill(); }, timeout);
    child.on('error', (e) => { output += e.message; });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 1 : 0), output }); });
  });

/** Where the browser scripts find Chromium's headless shell, or nothing when it is not installed. */
export const headlessShell = () => globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
export const NO_BROWSER = 'Chromium’s headless shell is not installed. Install it with:\n    pnpm exec playwright-core install chromium-headless-shell';

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer().on('error', reject);
    server.listen(0, () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });

/** Serves dist/ with `vite preview` on a free port and waits until it answers. `stop` ends it, as does this process's exit. */
export async function startPreview() {
  const port = await freePort();
  const base = `http://localhost:${port}/`;
  const child = spawn(bin('vite'), ['preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore', shell });
  let exited;
  child.on('exit', (code) => (exited = code ?? 1));
  const stop = () => { if (exited === undefined) child.kill(); };
  process.on('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
  for (let waited = 0; !(await fetch(base).then((r) => r.ok, () => false)); waited += 100) {
    if (exited !== undefined || waited > 30_000) {
      stop();
      throw new Error(`The preview server did not start on port ${port}${exited !== undefined ? ` (exit ${exited})` : ''}.`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, stop };
}

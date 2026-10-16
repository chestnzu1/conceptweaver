import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';

/**
 * The local service's connection to an AI endpoint (ReasonerService.aiRequest): made to the very
 * address that was checked, with TLS spoken to the endpoint by its name and its certificate
 * verified for that name; and keys it holds, by a handle, for one endpoint only.
 *
 * A fake provider speaks HTTPS on this machine with a certificate for pinned.test and
 * rebind.test, made here with keytool; the services are given a hosts file in place of DNS
 * (jdk.net.hosts.file) and that certificate to trust. To stand for DNS rebinding the hosts file of
 * one service is a pipe that answers the first lookup of rebind.test with a public address and
 * every later one with this machine's, as a rebinding name server does: the service as it was
 * before, which checked the name and then let its HTTP client look it up again, reached the fake
 * provider so. Needs Java, keytool and mkfifo; skipped, saying so, without.
 */

const missing = unavailable() ?? (spawnSync('keytool', ['-help']).error ? 'keytool was not found' : spawnSync('mkfifo', ['--version']).error ? 'mkfifo was not found' : undefined);
if (missing) console.warn(`Pinned-connection tests skipped: ${missing}`);
const KEY = 'sk-pinned-test-4242';
const PORT = 5167;

describe.skipIf(!!missing)('the local service’s connection to an endpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ai-tls-'));
  const seen: { host?: string; auth?: string; path?: string }[] = [];
  let provider: https.Server;
  let local: Awaited<ReturnType<typeof startReasoner>>;
  let strict: Awaited<ReturnType<typeof startReasoner>>;
  let feeder: ChildProcess;

  beforeAll(async () => {
    const keytool = (...args: string[]) => {
      const r = spawnSync('keytool', args, { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    };
    const store = path.join(dir, 'provider.p12');
    keytool('-genkeypair', '-alias', 'provider', '-keyalg', 'RSA', '-keysize', '2048', '-dname', 'CN=pinned.test', '-ext', 'SAN=dns:pinned.test,dns:rebind.test', '-validity', '2', '-keystore', store, '-storetype', 'PKCS12', '-storepass', 'secret', '-keypass', 'secret');
    keytool('-exportcert', '-rfc', '-alias', 'provider', '-keystore', store, '-storetype', 'PKCS12', '-storepass', 'secret', '-file', path.join(dir, 'provider.pem'));
    keytool('-importcert', '-noprompt', '-alias', 'provider', '-file', path.join(dir, 'provider.pem'), '-keystore', path.join(dir, 'trust.p12'), '-storetype', 'PKCS12', '-storepass', 'secret');
    provider = https.createServer({ pfx: fs.readFileSync(store), passphrase: 'secret' }, (req, res) => {
      seen.push({ host: req.headers.host, auth: req.headers.authorization, path: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm' }] }));
    });
    await new Promise<void>((r) => provider.listen(PORT, '127.0.0.1', r));

    const hosts = path.join(dir, 'hosts');
    fs.writeFileSync(hosts, '127.0.0.1 pinned.test\n127.0.0.1 other.test\n');
    // Each lookup reads the pipe afresh, one answer each (hence the pause): a public address the
    // first time, this machine's ever after. (203.0.113.0/24 is for documentation: nothing answers there.)
    const pipe = path.join(dir, 'rebinding');
    spawnSync('mkfifo', [pipe]);
    feeder = spawn('bash', ['-c', `printf '203.0.113.7 rebind.test\\n127.0.0.1 pinned.test\\n' > "${pipe}"; sleep 0.1; while true; do printf '127.0.0.1 rebind.test\\n127.0.0.1 pinned.test\\n' > "${pipe}"; sleep 0.1; done`], { stdio: 'ignore' });
    const trust = ['-Djavax.net.ssl.trustStore=' + path.join(dir, 'trust.p12'), '-Djavax.net.ssl.trustStorePassword=secret', '-Djavax.net.ssl.trustStoreType=PKCS12', '-Dsun.net.inetaddr.ttl=0', '-Dsun.net.inetaddr.negative.ttl=0', '-Dconceptweaver.ai.connectTimeoutMs=1500'];
    [local, strict] = await Promise.all([
      startReasoner({ port: 5168, quiet: true, log: () => {}, allowLocalAi: true, javaOptions: [...trust, '-Djdk.net.hosts.file=' + hosts] }),
      startReasoner({ port: 5169, quiet: true, log: () => {}, javaOptions: [...trust, '-Djdk.net.hosts.file=' + pipe] }),
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([local?.stop(), strict?.stop()]);
    feeder?.kill();
    await new Promise((r) => provider?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (service: { url: string }, route: string, body: object) => fetch(`${service.url}${route}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  const models = (service: { url: string }, baseUrl: string, auth: object = { key: KEY }) => post(service, '/ai/forward', { provider: 'custom', baseUrl, path: '/models', method: 'GET', ...auth });

  it('speaks TLS to the endpoint by its name, and verifies its certificate for that name', async () => {
    const ok = await models(local, `https://pinned.test:${PORT}/v1`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: [{ id: 'm' }] });
    expect(seen.at(-1)).toEqual({ host: `pinned.test:${PORT}`, auth: `Bearer ${KEY}`, path: '/v1/models' });
    // other.test is the same address, but the certificate is not for it: nothing is sent.
    const before = seen.length;
    const wrong = await models(local, `https://other.test:${PORT}/v1`);
    expect(wrong.status).toBe(502);
    expect((await wrong.json()).errors[0]).toMatch(/certificate could not be verified for other\.test/);
    expect(seen.length).toBe(before);
  });

  it('connects to the address it checked, so a name that changes what it resolves to is not followed there', async () => {
    const before = seen.length;
    // Checked, the name is public; looked up again it would be this machine. The request goes to the
    // public address it checked, where nothing answers, and not to this machine.
    const first = await models(strict, `https://rebind.test:${PORT}/v1`);
    expect([502, 504]).toContain(first.status);
    expect(seen.length).toBe(before);
    // Asked again, the name is this machine's from the start, and the request is refused as such.
    const again = await models(strict, `https://rebind.test:${PORT}/v1`);
    expect(again.status).toBe(403);
    expect((await again.json()).errors[0]).toMatch(/on this machine or a private network/);
    expect(seen.length).toBe(before);
  }, 60_000);

  it('holds a key for one endpoint by a handle, and gives it back to no one', async () => {
    expect(local.health).toMatchObject({ holdsAiKeys: true });
    const held = await post(local, '/ai/key', { provider: 'custom', baseUrl: `https://pinned.test:${PORT}/v1/`, key: KEY });
    expect(held.status).toBe(200);
    const { handle, ...rest } = await held.json();
    expect(rest).toEqual({});
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(handle).not.toContain(KEY);
    const ok = await models(local, `https://pinned.test:${PORT}/v1`, { handle });
    expect(ok.status).toBe(200);
    expect(seen.at(-1)!.auth).toBe(`Bearer ${KEY}`);
    // For another endpoint, or another provider, the handle does nothing.
    expect((await models(local, `https://other.test:${PORT}/v1`, { handle })).status).toBe(403);
    expect((await post(local, '/ai/forward', { provider: 'openai', path: '/models', method: 'GET', handle })).status).toBe(403);
    // Forgotten, or unknown, it is gone.
    expect((await post(local, '/ai/key/forget', { handle })).status).toBe(200);
    const gone = await models(local, `https://pinned.test:${PORT}/v1`, { handle });
    expect(gone.status).toBe(410);
    expect((await gone.json()).errors[0]).toMatch(/^The key is no longer held/);
    // A key for a private address is not held where the service does not forward there.
    expect((await post(strict, '/ai/key', { provider: 'custom', baseUrl: `https://pinned.test:${PORT}/v1`, key: KEY })).status).toBe(403);
  });
});

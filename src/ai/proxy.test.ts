import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import type { ProviderSettings } from './providers/contracts';
import { forgetKey, holdKey } from './providers/http';
import { adapterFor } from './providers/index';

/**
 * The local service as the assistant's proxy (reasoner/ReasonerService.java, /ai/forward): it
 * streams the provider's answer through and sets the key on the request itself; it refuses a
 * custom endpoint on this machine or a private network unless it was started to allow one, a
 * redirect, a path a chat does not need, and a page it does not serve. A fake provider on this
 * machine stands in for one. Needs Java and the service's libraries; skipped, saying so, without.
 */

const why = process.env.CONCEPTWEAVER_COMPANION_JAR ? 'The proxy is the single-file service’s; the companion does not answer it.' : unavailable();
if (why) console.warn(`Proxy tests skipped: ${why}`);
const KEY = 'sk-proxy-test-5678';

describe.skipIf(!!why)('the local service as the assistant’s proxy', () => {
  let strict: Awaited<ReturnType<typeof startReasoner>>;
  let local: Awaited<ReturnType<typeof startReasoner>>;
  let provider: http.Server;
  const seen: { path: string; auth?: string; body: string }[] = [];
  beforeAll(async () => {
    provider = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
        if (req.url === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-model' }] }));
        if (req.url?.startsWith('/redir/')) return res.writeHead(302, { Location: 'http://127.0.0.1:5178/stolen' }).end();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const part of ['Hel', 'lo']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
          await new Promise((r) => setTimeout(r, 30));
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => provider.listen(5178, '127.0.0.1', r));
    [strict, local] = await Promise.all([startReasoner({ port: 5176, quiet: true, log: () => {} }), startReasoner({ port: 5177, quiet: true, log: () => {}, allowLocalAi: true })]);
  }, 120_000);
  afterAll(async () => {
    forgetKey();
    await Promise.all([strict?.stop(), local?.stop()]);
    await new Promise((r) => provider?.close(r));
  });
  const via = (service: { url: string }, baseUrl = 'http://127.0.0.1:5178/v1'): ProviderSettings => ({ provider: 'custom', model: 'local-model', baseUrl, transport: 'proxy', proxyUrl: service.url });

  it('says it forwards', () => {
    expect(strict.health).toMatchObject({ forwardsAi: true });
  });

  it('streams the answer through, with the key set on the request it makes', async () => {
    const s = via(local);
    holdKey(KEY, s);
    const texts: string[] = [];
    const result = await adapterFor(s).chat({ system: 'x', messages: [{ role: 'user', text: 'hi' }], tools: [] }, { onEvent: (e) => e.type === 'text' && texts.push(e.text) });
    expect(result.text).toBe('Hello');
    expect(texts).toEqual(['Hel', 'lo']);
    const asked = seen.find((x) => x.path === '/v1/chat/completions')!;
    expect(asked.auth).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(asked.body)).toMatchObject({ model: 'local-model', stream: true });
    expect(await adapterFor(s).test()).toEqual({ detail: 'Connected. The provider has the model local-model.' });
  });

  it('refuses an endpoint on this machine unless it was started to allow one', async () => {
    const s = via(strict);
    holdKey(KEY, s);
    const before = seen.length;
    await expect(adapterFor(s).test()).rejects.toMatchObject({ code: 'blocked', message: expect.stringMatching(/^The local service: The endpoint has to be https/) });
    expect(seen.length).toBe(before);
  });

  it('never follows a redirect, so the key goes nowhere it was not sent', async () => {
    const s = via(local, 'http://127.0.0.1:5178/redir/v1');
    holdKey(KEY, s);
    await expect(adapterFor(s).test()).rejects.toMatchObject({ code: 'network', message: expect.stringMatching(/redirect, which is not followed/) });
    expect(seen.some((x) => x.path === '/stolen')).toBe(false);
  });

  it('forwards only what a chat needs, for pages it serves, to endpoints that are what they say', async () => {
    const post = (body: unknown, origin?: string) => fetch(`${strict.url}/ai/forward`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    const base = { provider: 'openai', method: 'GET', key: KEY };
    expect((await post({ ...base, path: '/files' })).status).toBe(400);
    expect((await post({ ...base, path: '/../v2/models' })).status).toBe(400);
    expect((await post({ ...base, provider: 'elsewhere', path: '/models' })).status).toBe(400);
    expect((await post({ ...base, path: '/models', key: 'two\nlines' })).status).toBe(400);
    expect((await post({ ...base, provider: 'custom', baseUrl: 'https://user:pw@example.org/v1', path: '/models' })).status).toBe(403);
    expect((await post({ ...base, provider: 'custom', baseUrl: 'http://example.org/v1', path: '/models' })).status).toBe(403);
    expect((await post({ ...base, path: '/models' }, 'https://evil.example')).status).toBe(403);
    // https to this machine, or to an address of a private network, is refused all the same.
    const inside = await post({ ...base, provider: 'custom', baseUrl: 'https://127.0.0.1:5178/v1', path: '/models' });
    expect(inside.status).toBe(403);
    expect((await inside.json()).errors[0]).toMatch(/on this machine or a private network/);
    expect((await post({ ...base, provider: 'custom', baseUrl: 'https://10.0.0.8/v1', path: '/models' })).status).toBe(403);
    expect((await post({ ...base, provider: 'custom', baseUrl: 'https://169.254.169.254/v1', path: '/models' })).status).toBe(403);
  });
});

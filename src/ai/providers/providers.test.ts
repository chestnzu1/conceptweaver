import { afterEach, describe, expect, it } from 'vitest';
import { AiError, type ProviderSettings, type StreamEvent } from './contracts';
import { endpointProblem, forgetKey, hasKey, holdKey, keyFor } from './http';
import { adapterFor } from './index';

/**
 * The providers behind one interface: what each is sent and how its streamed answer is read, by
 * a fetch that stands in for the network; and what keeps the key where it belongs.
 */

const KEY = 'sk-test-0123456789';
afterEach(() => forgetKey());

/** A fetch that answers with server-sent events (or a status), and keeps what it was asked. */
function fake(answer: { status?: number; events?: string[]; json?: unknown; hang?: boolean }) {
  const asked: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    asked.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : {} });
    if (answer.hang)
      return new Promise((_r, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    if (answer.json !== undefined) return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    const text = (answer.events ?? []).join('');
    return new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) }), { status: answer.status ?? 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { f, asked };
}
const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const chat = async (s: ProviderSettings, f: typeof fetch) => {
  const events: StreamEvent[] = [];
  const result = await adapterFor(s, f).chat({ system: 'Be exact.', messages: [{ role: 'user', text: 'Explain Film' }], tools: [{ name: 'getEntityDetails', description: 'An entity.', parameters: { type: 'object', properties: { iri: { type: 'string' } }, required: ['iri'] } }] }, { onEvent: (e) => events.push(e) });
  return { result, events };
};

describe('OpenAI, and endpoints that speak its API', () => {
  const s: ProviderSettings = { provider: 'openai', model: 'some-model', transport: 'direct' };
  it('streams text, assembles a tool call from its pieces, and is sent the key as a bearer token, with no redirect followed', async () => {
    holdKey(KEY, s);
    const { f, asked } = fake({
      events: [
        data({ choices: [{ delta: { content: 'Film is ' } }] }),
        data({ choices: [{ delta: { content: 'a class.' } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'getEntity', arguments: '{"iri":' } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Details', arguments: '"http://e/x#Film"}' } }] }, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ],
    });
    const { result, events } = await chat(s, f);
    expect(result).toEqual({ text: 'Film is a class.', toolCalls: [{ id: 'c1', name: 'getEntityDetails', arguments: { iri: 'http://e/x#Film' } }], stop: 'tool' });
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Film is ', 'a class.']);
    expect(asked[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(asked[0].init).toMatchObject({ redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect((asked[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(asked[0].body).toMatchObject({ model: 'some-model', stream: true, messages: [{ role: 'system', content: 'Be exact.' }, { role: 'user', content: 'Explain Film' }], tools: [{ type: 'function', function: { name: 'getEntityDetails' } }] });
  });

  it('says why the provider refused, by its status, with the key taken out of what it said', async () => {
    holdKey(KEY, s);
    const { f } = fake({ status: 401, json: { error: { message: `Incorrect API key provided: ${KEY}.` } } });
    const e = await chat(s, f).catch((x: AiError) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(e).toMatchObject({ code: 'auth', message: 'The provider refused the key (HTTP 401): Incorrect API key provided: [key].' });
    expect(String((e as Error).message)).not.toContain(KEY);
  });

  it('tests the connection by the models the provider lists', async () => {
    holdKey(KEY, s);
    expect(await adapterFor(s, fake({ json: { data: [{ id: 'some-model' }] } }).f).test()).toEqual({ detail: 'Connected. The provider has the model some-model.' });
    expect((await adapterFor(s, fake({ json: { data: [{ id: 'other' }] } }).f).test()).detail).toContain('does not list a model called some-model');
  });
});

describe('Anthropic', () => {
  const s: ProviderSettings = { provider: 'anthropic', model: 'claude-sonnet-5-5', transport: 'direct' };
  it('streams named events, a tool use’s input in partial JSON, with its own headers', async () => {
    holdKey(KEY, s);
    const ev = (type: string, o: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
    const { f, asked } = fake({
      events: [
        ev('message_start', { message: {} }),
        ev('content_block_start', { index: 0, content_block: { type: 'text' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Looking it up.' } }),
        ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'getEntityDetails' } }),
        ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"iri": "http://e/x#' } }),
        ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'Film"}' } }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' } }),
        ev('message_stop', {}),
      ],
    });
    const { result } = await chat(s, f);
    expect(result).toEqual({ text: 'Looking it up.', toolCalls: [{ id: 'tu1', name: 'getEntityDetails', arguments: { iri: 'http://e/x#Film' } }], stop: 'tool' });
    expect(asked[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(asked[0].init.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
    expect(asked[0].body).toMatchObject({ system: 'Be exact.', tools: [{ name: 'getEntityDetails', input_schema: { type: 'object' } }] });
  });

  it('gives the results of one turn’s tools together, in one user message', async () => {
    holdKey(KEY, s);
    const { f, asked } = fake({ events: [`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`] });
    await adapterFor(s, f).chat({
      system: '',
      tools: [],
      messages: [
        { role: 'user', text: 'Two things' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'a', name: 't', arguments: {} }, { id: 'b', name: 't', arguments: {} }] },
        { role: 'tool', callId: 'a', name: 't', result: '{"x":1}' },
        { role: 'tool', callId: 'b', name: 't', result: '{"x":2}' },
      ],
    });
    const sent = asked[0].body.messages as { role: string; content: { type: string }[] }[];
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[2].content.map((c) => c.type)).toEqual(['tool_result', 'tool_result']);
  });
});

describe('Gemini', () => {
  it('declares tools with its own schema, streams parts, and is sent the key in its header', async () => {
    const s: ProviderSettings = { provider: 'gemini', model: 'gemini-test', transport: 'direct' };
    holdKey(KEY, s);
    const { f, asked } = fake({ events: [data({ candidates: [{ content: { parts: [{ text: 'Film ' }] } }] }), data({ candidates: [{ content: { parts: [{ functionCall: { name: 'getEntityDetails', args: { iri: 'http://e/x#Film' } } }] }, finishReason: 'STOP' }] })] });
    const { result } = await chat(s, f);
    expect(result).toMatchObject({ text: 'Film ', toolCalls: [{ name: 'getEntityDetails', arguments: { iri: 'http://e/x#Film' } }], stop: 'tool' });
    expect(asked[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
    expect(asked[0].init.headers).toMatchObject({ 'x-goog-api-key': KEY });
    expect(asked[0].body).toMatchObject({ systemInstruction: { parts: [{ text: 'Be exact.' }] }, tools: [{ functionDeclarations: [{ name: 'getEntityDetails', parameters: { type: 'OBJECT', properties: { iri: { type: 'STRING' } } } }] }] });
  });
});

describe('the key, and where requests go', () => {
  it('is held for one endpoint: changing the provider or a custom endpoint’s origin asks for it again', () => {
    const a: ProviderSettings = { provider: 'custom', model: 'm', baseUrl: 'https://llm.example.org/v1', transport: 'direct' };
    holdKey(KEY, a);
    expect(keyFor(a)).toBe(KEY);
    expect(keyFor({ ...a, baseUrl: 'https://llm.example.org/v2' })).toBe(KEY);
    expect(hasKey({ ...a, baseUrl: 'https://elsewhere.example/v1' })).toBe(false);
    expect(hasKey({ provider: 'openai' })).toBe(false);
  });

  it('refuses a custom endpoint that is not https, holds a password, or has a query', () => {
    expect(endpointProblem('https://llm.example.org/v1')).toBeUndefined();
    expect(endpointProblem('http://localhost:11434/v1')).toBeUndefined();
    expect(endpointProblem('http://llm.example.org/v1')).toMatch(/has to be https/);
    expect(endpointProblem('https://user:pass@llm.example.org/v1')).toMatch(/user name or password/);
    expect(endpointProblem('https://llm.example.org/v1?key=x')).toMatch(/query/);
    expect(endpointProblem('file:///etc/passwd')).toMatch(/has to be https/);
  });

  it('goes through the local service when that is the transport, and only there', async () => {
    const s: ProviderSettings = { provider: 'openai', model: 'm', transport: 'proxy', proxyUrl: 'http://localhost:5190' };
    holdKey(KEY, s);
    const { f, asked } = fake({ events: ['data: [DONE]\n\n'] });
    await chat(s, f);
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe('http://localhost:5190/ai/forward');
    expect(asked[0].body).toMatchObject({ provider: 'openai', path: '/chat/completions', method: 'POST', key: KEY });
    expect(JSON.parse(asked[0].body.body as string)).toMatchObject({ model: 'm', stream: true });
  });

  it('gives up after the time it is given, and when stopped', async () => {
    const s: ProviderSettings = { provider: 'openai', model: 'm', transport: 'direct' };
    holdKey(KEY, s);
    await expect(adapterFor(s, fake({ hang: true }).f).chat({ system: '', messages: [], tools: [] }, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' });
    const stop = new AbortController();
    const going = adapterFor(s, fake({ hang: true }).f).chat({ system: '', messages: [], tools: [] }, { signal: stop.signal });
    stop.abort();
    await expect(going).rejects.toMatchObject({ code: 'cancelled' });
    forgetKey();
    await expect(adapterFor(s, fake({ events: [] }).f).chat({ system: '', messages: [], tools: [] })).rejects.toMatchObject({ code: 'config' });
  });
});

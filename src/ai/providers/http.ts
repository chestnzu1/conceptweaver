import { AiError, PROVIDERS, type CallOptions, type ProviderId, type ProviderSettings } from './contracts';

/**
 * How the assistant reaches a provider, and what keeps the key safe on the way.
 *
 * The key is held in this module's memory for the session only: not in the store, not in
 * localStorage, not in a model or anything exported. It is held for one endpoint (the provider
 * and the origin of its URL): a key typed for one is never sent to another, so changing the base
 * URL of a custom endpoint, or the provider, asks for the key again.
 *
 * A request goes straight from the browser (`direct`), with redirects refused so that the key
 * cannot follow one, no cookies and no referrer; or through the local OWL service (`proxy`),
 * which sets the key on the request itself and refuses endpoints it should not reach.
 */

let held: { key: string; endpoint: string } | null = null;

/** Where a key belongs: the provider, and for a custom endpoint the origin of its URL. */
export const endpointOf = (s: Pick<ProviderSettings, 'provider' | 'baseUrl'>): string => (s.provider === 'custom' ? `custom ${originOf(s.baseUrl ?? '')}` : s.provider);
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** Keeps a key for this session, for the endpoint of these settings. */
export function holdKey(key: string, settings: Pick<ProviderSettings, 'provider' | 'baseUrl'>): void {
  held = key.trim() ? { key: key.trim(), endpoint: endpointOf(settings) } : null;
}
export const forgetKey = (): void => void (held = null);
/** The key for these settings: none when it was given for another endpoint. */
export const keyFor = (settings: Pick<ProviderSettings, 'provider' | 'baseUrl'>): string | undefined => (held && held.endpoint === endpointOf(settings) ? held.key : undefined);
export const hasKey = (settings: Pick<ProviderSettings, 'provider' | 'baseUrl'>): boolean => !!keyFor(settings);

/** Text with the key taken out wherever it is, before it is shown or thrown. */
export const redact = (text: string): string => {
  const k = held?.key;
  return k && k.length >= 4 ? text.split(k).join('[key]') : text;
};

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Why the base URL of an OpenAI-compatible endpoint is refused, if it is: it has to be https (or,
 * from the browser, http to this machine, where a local model server is), with no user name or
 * password in it, and no query or fragment. The proxy holds custom endpoints to more, in the service.
 */
export function endpointProblem(url: string | undefined): string | undefined {
  if (!url?.trim()) return 'An OpenAI-compatible endpoint needs its base URL, such as https://example.org/v1.';
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'The base URL is not a URL.';
  }
  if (u.username || u.password) return 'The base URL may not hold a user name or password: the key is given apart.';
  if (u.search || u.hash) return 'The base URL may not have a query or a fragment.';
  if (u.protocol === 'https:') return undefined;
  // A model server on this machine. Through the proxy, the service decides: it has to be started allowing it (--allow-local-ai).
  if (u.protocol === 'http:' && LOOPBACK.test(u.hostname)) return undefined;
  return 'The base URL has to be https:// (or http:// to localhost, for a model server on this machine).';
}

/** Where a request goes, the headers that carry the key, and what the request says. */
export interface Call {
  /** The path below the provider's base: /chat/completions, /messages, /models, /models/{model}:streamGenerateContent?alt=sse. */
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
}

const baseOf = (s: ProviderSettings) => (s.provider === 'custom' ? (s.baseUrl ?? '').trim().replace(/\/+$/, '') : PROVIDERS.find((p) => p.id === s.provider)!.base);

/** The headers that carry the key, as each provider wants them. */
function authHeaders(provider: ProviderId, key: string, direct: boolean): Record<string, string> {
  if (provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(direct ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}) };
  if (provider === 'gemini') return { 'x-goog-api-key': key };
  return { Authorization: `Bearer ${key}` };
}

/** One call to the provider, by the transport the settings say; refused, with why, before anything is sent if it should not be. */
export async function send(settings: ProviderSettings, call: Call, options: CallOptions & { fetch?: typeof fetch } = {}): Promise<{ response: Response; touch: () => void; done: () => void }> {
  const key = keyFor(settings);
  if (!key) throw new AiError('config', 'There is no API key for this provider in this session. Enter it in the assistant’s settings.');
  if (!settings.model.trim()) throw new AiError('config', 'Choose the model, by the identifier the provider gives it.');
  if (settings.provider === 'custom') {
    const problem = endpointProblem(settings.baseUrl);
    if (problem) throw new AiError('blocked', problem);
  }
  const doFetch = options.fetch ?? fetch;
  // Given up by the caller, or after a while with nothing from the provider: before its answer begins, and then between its parts.
  const stop = new AbortController();
  const timeout = options.timeoutMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, timeout);
  };
  const done = () => clearTimeout(timer);
  const giveUp = () => stop.abort();
  if (options.signal?.aborted) throw new AiError('cancelled', 'Stopped.');
  options.signal?.addEventListener('abort', giveUp, { once: true });
  touch();
  const json = call.body === undefined ? undefined : JSON.stringify(call.body);
  try {
    let response: Response;
    if (settings.transport === 'proxy') {
      const proxy = (settings.proxyUrl ?? 'http://localhost:5190').replace(/\/+$/, '');
      // To the local service only; it adds the key's headers to the request it makes, and nothing else gets the key.
      response = await doFetch(`${proxy}/ai/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ provider: settings.provider, ...(settings.provider === 'custom' ? { baseUrl: baseOf(settings) } : {}), path: call.path, method: call.method, ...(json ? { body: json } : {}), key }),
        signal: stop.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      // A service that does not know /ai/forward answers 404 with no JSON: it is an older one.
      if (response.status === 404) {
        const text = await response.text().catch(() => '');
        if (!text.trimStart().startsWith('{')) throw new AiError('network', `The local service at ${proxy} does not forward to AI providers: it is an older one. Stop it and start it again with “pnpm reasoner”.`);
        response = new Response(text, { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
    } else {
      response = await doFetch(baseOf(settings) + call.path, {
        method: call.method,
        headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...authHeaders(settings.provider, key, true) },
        ...(json ? { body: json } : {}),
        signal: stop.signal,
        // A redirect is refused rather than followed, so that the key never goes where it was not sent.
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    }
    touch();
    return { response, touch, done: () => (done(), options.signal?.removeEventListener('abort', giveUp)) };
  } catch (e) {
    done();
    options.signal?.removeEventListener('abort', giveUp);
    if (e instanceof AiError) throw e;
    if (options.signal?.aborted) throw new AiError('cancelled', 'Stopped.');
    if (timedOut) throw new AiError('timeout', `The provider did not answer within ${Math.round(timeout / 1000)} seconds.`);
    throw new AiError(
      'network',
      settings.transport === 'proxy'
        ? `The local service did not answer at ${settings.proxyUrl ?? 'http://localhost:5190'}. Start it with “pnpm reasoner”, or send requests straight from the browser.`
        : `The provider could not be reached from the browser${settings.provider === 'custom' ? ' (an endpoint has to allow requests from this page: CORS)' : ''}. Check the address and your connection, or send requests through the local service.`,
    );
  }
}

/** A refusal of the provider, as an error to act on: by its status, with its own message where it gave one, the key taken out. */
export async function failure(response: Response): Promise<AiError> {
  let said = '';
  let service: string | undefined;
  try {
    const text = await response.text();
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string; errors?: unknown[] };
    // The local service's own refusals: an endpoint it does not forward to, a request it does not take.
    if (Array.isArray(json.errors) && json.errors.length) service = String(json.errors[0]);
    said = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.message ?? '');
  } catch {
    said = '';
  }
  const s = response.status;
  if (service) return new AiError(s === 403 ? 'blocked' : s === 504 ? 'timeout' : s >= 500 ? 'network' : 'bad-request', `The local service: ${redact(service).slice(0, 400)}`);
  said = redact(said).slice(0, 400);
  const code = s === 401 || s === 403 ? 'auth' : s === 429 ? 'rate-limit' : s === 404 ? 'not-found' : s >= 500 ? 'server' : 'bad-request';
  const what = { auth: 'The provider refused the key', 'rate-limit': 'The provider is limiting requests for now', 'not-found': 'The provider does not know the model or the address', server: 'The provider failed', 'bad-request': 'The provider refused the request' }[code];
  return new AiError(code, `${what} (HTTP ${s})${said ? `: ${said}` : '.'}`);
}

/**
 * The events of a streamed answer (server-sent events): each with its event name, if any, and its
 * data, as they arrive. Ends when the stream does, or with a refusal when it is stopped.
 */
export async function readEvents(response: Response, onEvent: (event: string | undefined, data: string) => void, touch: () => void, signal?: AbortSignal): Promise<void> {
  if (!response.body) throw new AiError('server', 'The provider answered with nothing.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) onEvent(event, data.join('\n'));
    event = undefined;
    data = [];
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + (buffer[at] === '\r' ? 2 : 1));
        if (!line) dispatch();
        else if (line.startsWith(':')) continue;
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (buffer.trim().startsWith('data:')) data.push(buffer.trim().slice(5).trim());
    dispatch();
  } catch (e) {
    if (signal?.aborted) throw new AiError('cancelled', 'Stopped.');
    if (e instanceof AiError) throw e;
    throw new AiError('timeout', 'The provider stopped sending its answer.');
  }
}

/**
 * The AI providers the assistant talks to, behind one interface (adapters in this folder): a chat
 * that streams text and asks for tools, a test of the connection, and refusals that say what went
 * wrong without ever saying the key. Everything here is plain data, so that the same calls can be
 * answered by the browser, by the local service as a proxy, or by a backend later.
 */

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'custom';

/**
 * How a request reaches the provider: straight from the browser, or through the local OWL
 * service (`pnpm reasoner`), which forwards it, sets the key on it, and refuses endpoints it
 * should not reach (reasoner/ReasonerService.java, /ai/forward).
 */
export type Transport = 'direct' | 'proxy';

/** What the assistant is configured with, apart from the key, which is never kept with it. */
export interface ProviderSettings {
  provider: ProviderId;
  /** The model's identifier, as the provider names it. */
  model: string;
  /** For an OpenAI-compatible endpoint: its base URL, up to and without /chat/completions. */
  baseUrl?: string;
  transport: Transport;
  /** Where the local service is, for the proxy transport. */
  proxyUrl?: string;
}

export const PROVIDERS: { id: ProviderId; label: string; base: string; placeholder: string }[] = [
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', placeholder: 'a model of OpenAI, as its API names it' },
  { id: 'anthropic', label: 'Anthropic', base: 'https://api.anthropic.com/v1', placeholder: 'claude-sonnet-5-5' },
  { id: 'gemini', label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta', placeholder: 'a Gemini model, as its API names it' },
  { id: 'custom', label: 'OpenAI-compatible endpoint', base: '', placeholder: 'the model the endpoint serves' },
];

/** A tool the model may call: its name, what it does, and the JSON Schema of its arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** The part of JSON Schema every provider takes: objects, arrays, strings, numbers, booleans, enumerations. */
export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  /** The arguments, as the model gave them: parsed JSON, checked by the tool before it is run. */
  arguments: unknown;
}

/** A turn of the conversation, as every provider is told it. */
export type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; result: string };

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens?: number;
}

/** What comes while the answer streams: text as it is written, and each tool call once it is whole. */
export type StreamEvent = { type: 'text'; text: string } | { type: 'tool'; call: ToolCall };

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  /** end: the answer is whole. tool: it asks for tools. length: it was cut at the token limit. */
  stop: 'end' | 'tool' | 'length' | 'other';
}

export interface CallOptions {
  /** Gives the call up: the request is aborted. */
  signal?: AbortSignal;
  onEvent?: (e: StreamEvent) => void;
  /** How long to wait for the first byte, and then between bytes, before giving up. */
  timeoutMs?: number;
}

export interface ProviderAdapter {
  chat(request: ChatRequest, options?: CallOptions): Promise<ChatResult>;
  /** Whether the provider answers with this key, and whether it knows the model. */
  test(options?: CallOptions): Promise<{ detail: string }>;
}

export type AiErrorCode = 'config' | 'blocked' | 'auth' | 'rate-limit' | 'bad-request' | 'not-found' | 'server' | 'network' | 'timeout' | 'cancelled';

/** Why a call failed, in words a person can act on; never with the key in it. */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

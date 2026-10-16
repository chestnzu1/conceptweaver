import { AiError, type CallOptions, type ChatRequest, type ChatResult, type JsonSchema, type Message, type ProviderAdapter, type ProviderSettings, type ToolCall } from './contracts';
import { failure, readEvents, send } from './http';

/**
 * Google's Gemini API (generateContent): the system instruction apart, turns of the user and the
 * model as parts, function declarations for tools and function responses for their results, and
 * an answer streamed as server-sent events (alt=sse), each a whole part.
 */

/** What Gemini's function declarations take of JSON Schema: types in capitals, and no more than the shared part. */
function schema(s: JsonSchema): unknown {
  return {
    type: s.type.toUpperCase(),
    ...(s.description ? { description: s.description } : {}),
    ...(s.enum ? { enum: s.enum } : {}),
    ...(s.items ? { items: schema(s.items) } : {}),
    ...(s.properties ? { properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, schema(v)])) } : {}),
    ...(s.required?.length ? { required: s.required } : {}),
  };
}

function contents(r: ChatRequest) {
  const out: { role: 'user' | 'model'; parts: unknown[] }[] = [];
  const add = (role: 'user' | 'model', part: unknown) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.parts.push(part);
    else out.push({ role, parts: [part] });
  };
  for (const m of r.messages as Message[]) {
    if (m.role === 'user') add('user', { text: m.text });
    else if (m.role === 'assistant') {
      if (m.text) add('model', { text: m.text });
      for (const c of m.toolCalls ?? []) add('model', { functionCall: { name: c.name, args: c.arguments ?? {} } });
    } else {
      let response: unknown;
      try {
        response = JSON.parse(m.result);
      } catch {
        response = m.result;
      }
      add('user', { functionResponse: { name: m.name, response: response && typeof response === 'object' && !Array.isArray(response) ? response : { result: response } } });
    }
  }
  return out;
}

export function geminiAdapter(settings: ProviderSettings, fetchImpl?: typeof fetch): ProviderAdapter {
  const model = settings.model.trim().replace(/^models\//, '');
  return {
    async chat(request, options: CallOptions = {}): Promise<ChatResult> {
      if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new AiError('config', 'A Gemini model identifier has letters, digits, dots, dashes and underscores only.');
      const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: contents(request),
        ...(request.tools.length ? { tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: schema(t.parameters) })) }] } : {}),
        ...(request.maxTokens ? { generationConfig: { maxOutputTokens: request.maxTokens } } : {}),
      };
      const { response, touch, done } = await send(settings, { path: `/models/${model}:streamGenerateContent?alt=sse`, method: 'POST', body }, { ...options, fetch: fetchImpl });
      try {
        if (!response.ok) throw await failure(response);
        let text = '';
        let stop: ChatResult['stop'] = 'other';
        const toolCalls: ToolCall[] = [];
        await readEvents(
          response,
          (_event, data) => {
            let chunk: { candidates?: { content?: { parts?: { text?: string; functionCall?: { name: string; args?: unknown } }[] }; finishReason?: string }[]; error?: { message?: string } };
            try {
              chunk = JSON.parse(data);
            } catch {
              return;
            }
            if (chunk.error) throw new AiError('server', `The provider stopped: ${chunk.error.message ?? 'an error'}`);
            const c = chunk.candidates?.[0];
            for (const part of c?.content?.parts ?? []) {
              if (part.text) {
                text += part.text;
                options.onEvent?.({ type: 'text', text: part.text });
              }
              if (part.functionCall) {
                const call = { id: `call_${toolCalls.length + 1}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {} };
                toolCalls.push(call);
                options.onEvent?.({ type: 'tool', call });
              }
            }
            if (c?.finishReason) stop = c.finishReason === 'STOP' ? 'end' : c.finishReason === 'MAX_TOKENS' ? 'length' : 'other';
          },
          touch,
          options.signal,
        );
        return { text, toolCalls, stop: toolCalls.length ? 'tool' : stop };
      } finally {
        done();
      }
    },
    async test(options: CallOptions = {}) {
      const { response, done } = await send(settings, { path: '/models?pageSize=1000', method: 'GET' }, { ...options, fetch: fetchImpl });
      try {
        if (!response.ok) throw await failure(response);
        const list = ((await response.json().catch(() => ({}))) as { models?: { name: string }[] }).models ?? [];
        const known = list.some((m) => m.name === `models/${model}`);
        return { detail: list.length && !known ? `Connected, but the provider does not list a model called ${model}: check its identifier.` : `Connected${known ? `. The provider has the model ${model}` : ''}.` };
      } finally {
        done();
      }
    },
  };
}

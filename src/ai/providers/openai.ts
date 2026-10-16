import { AiError, type CallOptions, type ChatRequest, type ChatResult, type Message, type ProviderAdapter, type ProviderSettings, type ToolCall } from './contracts';
import { failure, readEvents, send } from './http';

/**
 * OpenAI's Chat Completions API, which OpenAI-compatible endpoints (a local model server, a
 * gateway) speak too: messages, function tools, and an answer streamed as server-sent events,
 * a tool call arriving in pieces by its index.
 */

const messages = (r: ChatRequest) => [
  { role: 'system', content: r.system },
  ...r.messages.map((m: Message) =>
    m.role === 'user'
      ? { role: 'user', content: m.text }
      : m.role === 'assistant'
        ? { role: 'assistant', content: m.text || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) } : {}) }
        : { role: 'tool', tool_call_id: m.callId, content: m.result },
  ),
];

export function openAiAdapter(settings: ProviderSettings, fetchImpl?: typeof fetch): ProviderAdapter {
  const official = settings.provider === 'openai';
  return {
    async chat(request, options: CallOptions = {}): Promise<ChatResult> {
      const body = {
        model: settings.model,
        messages: messages(request),
        ...(request.tools.length ? { tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
        stream: true,
        // OpenAI names the limit anew; endpoints that copy its API mostly know the older name.
        ...(request.maxTokens ? (official ? { max_completion_tokens: request.maxTokens } : { max_tokens: request.maxTokens }) : {}),
      };
      const { response, touch, done } = await send(settings, { path: '/chat/completions', method: 'POST', body }, { ...options, fetch: fetchImpl });
      try {
        if (!response.ok) throw await failure(response);
        let text = '';
        let stop: ChatResult['stop'] = 'other';
        const calls = new Map<number, { id: string; name: string; args: string }>();
        await readEvents(
          response,
          (_event, data) => {
            if (data.trim() === '[DONE]') return;
            let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; error?: { message?: string } };
            try {
              chunk = JSON.parse(data);
            } catch {
              return;
            }
            if (chunk.error) throw new AiError('server', `The provider stopped: ${chunk.error.message ?? 'an error'}`);
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (delta?.content) {
              text += delta.content;
              options.onEvent?.({ type: 'text', text: delta.content });
            }
            for (const t of delta?.tool_calls ?? []) {
              const c = calls.get(t.index) ?? { id: '', name: '', args: '' };
              if (t.id) c.id = t.id;
              if (t.function?.name) c.name += t.function.name;
              if (t.function?.arguments) c.args += t.function.arguments;
              calls.set(t.index, c);
            }
            if (choice?.finish_reason) stop = choice.finish_reason === 'stop' ? 'end' : choice.finish_reason === 'tool_calls' ? 'tool' : choice.finish_reason === 'length' ? 'length' : 'other';
          },
          touch,
          options.signal,
        );
        const toolCalls: ToolCall[] = [...calls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseArgs(c.args) }));
        for (const call of toolCalls) options.onEvent?.({ type: 'tool', call });
        return { text, toolCalls, stop: toolCalls.length ? 'tool' : stop };
      } finally {
        done();
      }
    },
    async test(options: CallOptions = {}) {
      const { response, done } = await send(settings, { path: '/models', method: 'GET' }, { ...options, fetch: fetchImpl });
      try {
        if (!response.ok) throw await failure(response);
        const list = ((await response.json().catch(() => ({}))) as { data?: { id: string }[] }).data ?? [];
        const known = list.some((m) => m.id === settings.model);
        return { detail: list.length ? (known ? `Connected. The provider has the model ${settings.model}.` : `Connected, but the provider does not list a model called ${settings.model}: check its identifier.`) : 'Connected.' };
      } finally {
        done();
      }
    },
  };
}

/** A tool call's arguments as JSON; as the text they were, under `raw`, where they are not JSON (the tool then says so). */
export const parseArgs = (text: string): unknown => {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

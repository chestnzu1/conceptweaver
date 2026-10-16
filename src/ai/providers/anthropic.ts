import { AiError, type CallOptions, type ChatRequest, type ChatResult, type Message, type ProviderAdapter, type ProviderSettings, type ToolCall } from './contracts';
import { failure, readEvents, send } from './http';
import { parseArgs } from './openai';

/**
 * Anthropic's Messages API: the system prompt apart, tool uses and their results as content
 * blocks (results of one turn together in one user message), and an answer streamed as named
 * events, a tool use's input arriving as partial JSON.
 */

function messages(r: ChatRequest) {
  const out: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const m of r.messages as Message[]) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} });
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '…' }] });
    } else {
      const block = { type: 'tool_result', tool_use_id: m.callId, content: m.result };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) (last.content as unknown[]).push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export function anthropicAdapter(settings: ProviderSettings, fetchImpl?: typeof fetch): ProviderAdapter {
  return {
    async chat(request, options: CallOptions = {}): Promise<ChatResult> {
      const body = {
        model: settings.model,
        system: request.system,
        messages: messages(request),
        ...(request.tools.length ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
        max_tokens: request.maxTokens ?? 4096,
        stream: true,
      };
      const { response, touch, done } = await send(settings, { path: '/messages', method: 'POST', body }, { ...options, fetch: fetchImpl });
      try {
        if (!response.ok) throw await failure(response);
        let text = '';
        let stop: ChatResult['stop'] = 'other';
        const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
        await readEvents(
          response,
          (event, data) => {
            let e: { type?: string; index?: number; content_block?: { type: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }; error?: { message?: string } };
            try {
              e = JSON.parse(data);
            } catch {
              return;
            }
            const type = e.type ?? event;
            if (type === 'error') throw new AiError('server', `The provider stopped: ${e.error?.message ?? 'an error'}`);
            if (type === 'content_block_start' && e.content_block) blocks.set(e.index ?? 0, { type: e.content_block.type, id: e.content_block.id ?? '', name: e.content_block.name ?? '', json: '' });
            else if (type === 'content_block_delta') {
              if (e.delta?.type === 'text_delta' && e.delta.text) {
                text += e.delta.text;
                options.onEvent?.({ type: 'text', text: e.delta.text });
              } else if (e.delta?.type === 'input_json_delta') {
                const b = blocks.get(e.index ?? 0);
                if (b) b.json += e.delta.partial_json ?? '';
              }
            } else if (type === 'message_delta' && e.delta?.stop_reason) {
              const r = e.delta.stop_reason;
              stop = r === 'end_turn' || r === 'stop_sequence' ? 'end' : r === 'tool_use' ? 'tool' : r === 'max_tokens' ? 'length' : 'other';
            }
          },
          touch,
          options.signal,
        );
        const toolCalls: ToolCall[] = [...blocks.entries()]
          .sort((a, b) => a[0] - b[0])
          .filter(([, b]) => b.type === 'tool_use')
          .map(([, b]) => ({ id: b.id, name: b.name, arguments: parseArgs(b.json) }));
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
        return { detail: list.length && !known ? `Connected, but the provider does not list a model called ${settings.model}: check its identifier.` : `Connected${known ? `. The provider has the model ${settings.model}` : ''}.` };
      } finally {
        done();
      }
    },
  };
}

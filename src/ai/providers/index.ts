import { anthropicAdapter } from './anthropic';
import type { ProviderAdapter, ProviderSettings } from './contracts';
import { geminiAdapter } from './gemini';
import { openAiAdapter } from './openai';

/** The adapter for the provider the settings name. `fetchImpl` stands in for the browser's fetch in tests. */
export function adapterFor(settings: ProviderSettings, fetchImpl?: typeof fetch): ProviderAdapter {
  if (settings.provider === 'anthropic') return anthropicAdapter(settings, fetchImpl);
  if (settings.provider === 'gemini') return geminiAdapter(settings, fetchImpl);
  return openAiAdapter(settings, fetchImpl);
}

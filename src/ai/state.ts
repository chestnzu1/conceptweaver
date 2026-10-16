import { create } from 'zustand';
import { EditError } from '../editing/contracts';
import { ontologyIriOf } from '../model/prefixes';
import { currentReasoning, runIsStale, useStore } from '../model/store';
import { revisionOf, WORKING_COPY } from '../structure/local';
import { respond, type AssistantHost } from './conversation';
import { AiError, type Message, type ProviderSettings, type ToolCall } from './providers/contracts';
import { forgetKey, hasKey, holdKey, redact } from './providers/http';
import { adapterFor } from './providers/index';
import { review, type ProposalInput, type Review } from './proposals';
import type { OntologyContext } from './tools';

/**
 * The assistant's own state, beside the editor's (which it reads, and changes only by applying a
 * proposal the user accepts): its settings, without the key; a conversation for each ontology;
 * the proposals made in them; and the answer under way, which can be stopped.
 *
 * Settings are kept in localStorage without the key. The key is in memory only (providers/http.ts):
 * it is gone when the page is closed, and is in nothing that is saved or exported.
 */

/** A turn as the panel shows it. */
export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** The tools it used, each with what it found, in a line. */
  tools: { name: string; about: string; done?: string }[];
  proposals: string[];
  error?: string;
  streaming?: boolean;
}

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'stale';

export interface Proposal {
  id: string;
  input: ProposalInput;
  review: Review;
  status: ProposalStatus;
  /** The ontology and revision it was checked against. */
  ontology: string;
  revision: string;
  created: number;
}

interface Conversation {
  messages: Message[];
  turns: Turn[];
}

interface AssistantState {
  open: boolean;
  width: number;
  settings: ProviderSettings | null;
  /** Whether there is a key for the settings in this session (the key itself is not here). */
  keyed: boolean;
  conversations: Record<string, Conversation>;
  proposals: Record<string, Proposal>;
  busy: boolean;
  /** The proposal open for review. */
  reviewing: string | null;
  showSettings: boolean;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  configure: (settings: ProviderSettings, key?: string) => void;
  removeConfiguration: () => void;
  ask: (question: string) => Promise<void>;
  stop: () => void;
  clear: () => void;
  setReviewing: (id: string | null) => void;
  setShowSettings: (on: boolean) => void;
  /** Checks a proposal again, against the ontology as it is now, with its operations as edited. */
  recheck: (id: string, input?: ProposalInput) => Promise<void>;
  /** Says again whether there is a key for the settings, after one was given or tried elsewhere. */
  refreshKeyed: () => void;
  accept: (id: string) => Promise<string | undefined>;
  reject: (id: string) => void;
}

const SETTINGS = 'conceptweaver:assistant';
const WIDTH = 'conceptweaver:assistant-width';
export const ASSISTANT_WIDTH = { min: 300, max: 760, initial: 380 } as const;

function storedSettings(): ProviderSettings | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS) ?? 'null') as ProviderSettings | null;
    if (!raw || !['openai', 'anthropic', 'gemini', 'custom'].includes(raw.provider)) return null;
    // Only what is not secret was ever kept; anything else in the record is not taken.
    return { provider: raw.provider, model: String(raw.model ?? ''), transport: raw.transport === 'proxy' ? 'proxy' : 'direct', ...(raw.baseUrl ? { baseUrl: String(raw.baseUrl) } : {}), ...(raw.proxyUrl ? { proxyUrl: String(raw.proxyUrl) } : {}) };
  } catch {
    return null;
  }
}

/** What the tools are given: the editor's model, selection, reasoning and validation, now. */
export function ontologyContext(): OntologyContext {
  const s = useStore.getState();
  const selected = s.selProp ? s.model.props.find((p) => p.id === s.selProp)?.iri : s.sel.terms.length === 1 ? s.model.terms.find((t) => t.id === s.sel.terms[0])?.iri : undefined;
  return { model: s.model, ...(selected ? { selected } : {}), ...(currentReasoning(s) ? { reasoning: currentReasoning(s) } : {}), ...(s.validation.run ? { validation: { run: s.validation.run, stale: runIsStale(s) } } : {}), loadedImports: Object.keys(s.ext.loaded) };
}

/** The ontology a conversation is about: the one open, by its IRI. */
export const ontologyKey = (): string => ontologyIriOf(useStore.getState().model) || 'untitled';
const ontologyId = () => useStore.getState().doc.id ?? WORKING_COPY;

let stopper: AbortController | null = null;
let made = 0;
/** Proposals are numbered apart from turns, so the first one is P1. */
let proposed = 0;

export const useAssistant = create<AssistantState>((set, get) => {
  const conversation = (): Conversation => get().conversations[ontologyKey()] ?? { messages: [], turns: [] };
  const put = (c: Conversation) => set((s) => ({ conversations: { ...s.conversations, [ontologyKey()]: c } }));
  const updateTurn = (key: string, id: string, f: (t: Turn) => Turn) => set((s) => {
    const c = s.conversations[key];
    if (!c) return {};
    return { conversations: { ...s.conversations, [key]: { ...c, turns: c.turns.map((t) => (t.id === id ? f(t) : t)) } } };
  });
  const keep = (p: Proposal) => set((s) => ({ proposals: { ...s.proposals, [p.id]: p } }));

  const host: AssistantHost = {
    context: ontologyContext,
    async propose(input) {
      const model = useStore.getState().model;
      const r = await review(model, input, ontologyId());
      const id = `P${++proposed}`;
      keep({ id, input, review: r, status: 'pending', ontology: ontologyKey(), revision: revisionOf(model), created: Date.now() });
      return { id, review: r };
    },
  };

  return {
    open: (() => {
      try {
        return localStorage.getItem('conceptweaver:assistant-open') === 'on';
      } catch {
        return false;
      }
    })(),
    width: (() => {
      try {
        const w = Number(localStorage.getItem(WIDTH));
        return Number.isFinite(w) && w ? Math.min(ASSISTANT_WIDTH.max, Math.max(ASSISTANT_WIDTH.min, w)) : ASSISTANT_WIDTH.initial;
      } catch {
        return ASSISTANT_WIDTH.initial;
      }
    })(),
    settings: storedSettings(),
    keyed: false,
    conversations: {},
    proposals: {},
    busy: false,
    reviewing: null,
    showSettings: false,
    setOpen: (open) => {
      try {
        localStorage.setItem('conceptweaver:assistant-open', open ? 'on' : 'off');
      } catch {
        // Not remembered.
      }
      set({ open });
    },
    setWidth: (width) => {
      const w = Math.round(Math.min(ASSISTANT_WIDTH.max, Math.max(ASSISTANT_WIDTH.min, width)));
      try {
        localStorage.setItem(WIDTH, String(w));
      } catch {
        // Not remembered.
      }
      set({ width: w });
    },
    configure: (settings, key) => {
      if (key !== undefined) holdKey(key, settings);
      try {
        // Never the key: only what says which provider and model.
        const { provider, model, transport, baseUrl, proxyUrl } = settings;
        localStorage.setItem(SETTINGS, JSON.stringify({ provider, model, transport, ...(baseUrl ? { baseUrl } : {}), ...(proxyUrl ? { proxyUrl } : {}) }));
      } catch {
        // Kept for this session.
      }
      set({ settings, keyed: hasKey(settings) });
    },
    removeConfiguration: () => {
      forgetKey();
      try {
        localStorage.removeItem(SETTINGS);
      } catch {
        // Nothing kept.
      }
      set({ settings: null, keyed: false });
    },
    ask: async (question) => {
      const settings = get().settings;
      if (get().busy || !question.trim()) return;
      const key = ontologyKey();
      const before = conversation();
      const user: Turn = { id: `t${++made}`, role: 'user', text: question.trim(), tools: [], proposals: [] };
      const reply: Turn = { id: `t${++made}`, role: 'assistant', text: '', tools: [], proposals: [], streaming: true };
      put({ ...before, turns: [...before.turns, user, reply] });
      if (!settings || !hasKey(settings)) {
        updateTurn(key, reply.id, (t) => ({ ...t, streaming: false, error: 'The assistant is not set up: choose a provider and enter your API key in its settings.' }));
        return;
      }
      stopper = new AbortController();
      set({ busy: true });
      try {
        const messages = await respond(adapterFor(settings), before.messages, question.trim(), host, {
          signal: stopper.signal,
          onText: (delta) => updateTurn(key, reply.id, (t) => ({ ...t, text: t.text + delta })),
          onTool: (call: ToolCall, done?: string) =>
            updateTurn(key, reply.id, (t) => {
              const about = typeof call.arguments === 'object' && call.arguments ? String((call.arguments as Record<string, unknown>).iri ?? (call.arguments as Record<string, unknown>).query ?? (call.arguments as Record<string, unknown>).summary ?? '') : '';
              const tools = done === undefined ? [...t.tools, { name: call.name, about }] : t.tools.map((x, i) => (i === t.tools.length - 1 && x.name === call.name ? { ...x, done } : x));
              return { ...t, tools };
            }),
          onProposal: (id) => updateTurn(key, reply.id, (t) => ({ ...t, proposals: [...t.proposals, id] })),
        });
        const c = get().conversations[key] ?? before;
        set((s) => ({ conversations: { ...s.conversations, [key]: { ...c, messages } } }));
        updateTurn(key, reply.id, (t) => ({ ...t, streaming: false }));
      } catch (e) {
        const message = e instanceof AiError ? e.message : `The assistant failed: ${redact(e instanceof Error ? e.message : String(e))}`;
        updateTurn(key, reply.id, (t) => ({ ...t, streaming: false, error: e instanceof AiError && e.code === 'cancelled' ? 'Stopped.' : message }));
      } finally {
        stopper = null;
        set({ busy: false });
      }
    },
    stop: () => stopper?.abort(),
    clear: () => {
      stopper?.abort();
      put({ messages: [], turns: [] });
    },
    refreshKeyed: () => set((s) => ({ keyed: !!s.settings && hasKey(s.settings) })),
    setReviewing: (reviewing) => set({ reviewing }),
    setShowSettings: (showSettings) => set({ showSettings }),
    recheck: async (id, input) => {
      const p = get().proposals[id];
      // A proposal is about the ontology it was made for: never checked against another one.
      if (!p || p.ontology !== ontologyKey()) return;
      const model = useStore.getState().model;
      const next = input ?? p.input;
      keep({ ...p, input: next, review: await review(model, next, ontologyId()), status: 'pending', revision: revisionOf(model) });
    },
    accept: async (id) => {
      const p = get().proposals[id];
      if (!p || p.status !== 'pending' || !p.review.changeSet) return 'This proposal cannot be applied as it is: see what is wrong with it.';
      const st = useStore.getState();
      if (revisionOf(st.model) !== p.revision) {
        keep({ ...p, status: 'stale' });
        return 'The ontology has changed since this proposal was checked. Check it again against the ontology as it is now.';
      }
      try {
        // Through the edit service, as one edit: undone and redone like any other, kept with the model.
        await st.editService.apply({ ...p.review.changeSet, ontologyId: ontologyId() });
        keep({ ...p, status: 'applied' });
        const added = p.review.lines.filter((l) => l.op === 'add').map((l) => l.about.iri);
        const ids = useStore.getState().model.terms.filter((t) => t.iri && added.includes(t.iri)).map((t) => t.id);
        if (ids.length) useStore.getState().select(ids.slice(0, 50));
        useStore.getState().notify(`Applied ${p.id}: ${p.input.summary || 'the proposed change'}. Undo takes it back.`);
        return undefined;
      } catch (e) {
        if (e instanceof EditError && e.code === 'stale-revision') {
          keep({ ...p, status: 'stale' });
          return 'The ontology has changed since this proposal was checked. Check it again against the ontology as it is now.';
        }
        return `Not applied: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    reject: (id) => {
      const p = get().proposals[id];
      if (p) keep({ ...p, status: 'rejected' });
    },
  };
});

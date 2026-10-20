import type { StateCreator } from 'zustand';
import type { DiagramsSlice } from './diagrams';
import type { DocumentSlice } from './document';
import type { EditsSlice } from './edits';
import type { ExternalsSlice } from './externals';
import type { LayoutSlice } from './layout';
import type { ReasoningSlice } from './reasoning';
import type { SessionSlice } from './session';
import type { SubgraphSlice } from './subgraph';
import type { ValidationSlice } from './validation';

/** The whole of the store: the document, the session and the jobs, each a slice of its own (see store.ts). */
export type State = DocumentSlice & EditsSlice & DiagramsSlice & SessionSlice & SubgraphSlice & ValidationSlice & ReasoningSlice & ExternalsSlice & LayoutSlice;

/** A slice: its part of the state and actions, made with the whole store at hand. */
export type Slice<T> = StateCreator<State, [], [], T>;

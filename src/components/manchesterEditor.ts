import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import { linter, type Diagnostic } from '@codemirror/lint';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { checkExpression } from '../model/expressionCheck';
import { completionsAt, parseClass, parseDataRange, readText, type Expected, type Naming } from '../model/manchester';

/**
 * The text editor of a class expression or a data range in Manchester syntax, on CodeMirror. It
 * knows nothing of React or of the model beyond what it is given: the names (`naming`), which it
 * asks for each time, so that it follows the model as it changes. What it reads it reads with
 * the app's own reader (src/model/manchester.ts), so that what is highlighted, completed and
 * marked as wrong is exactly what will be read when the text is saved.
 */
export interface ManchesterEditorOptions {
  parent: HTMLElement;
  text: string;
  as: 'class' | 'data';
  naming: () => Naming;
  onChange: (text: string) => void;
  /** Ctrl+Enter (Cmd+Enter): save. */
  onSubmit?: () => void;
  label: string;
  placeholder?: string;
}

export interface ManchesterEditor {
  /** Puts other text in, as a change of its own (undo takes it back). */
  setText(text: string): void;
  focus(): void;
  destroy(): void;
}

/** The class each kind of token is highlighted with. */
const CLASS_OF: Record<string, string> = { keyword: 'mx-keyword', string: 'mx-literal', number: 'mx-literal', punct: 'mx-punct', class: 'mx-class', object: 'mx-object', data: 'mx-data', individual: 'mx-individual', datatype: 'mx-datatype', enum: 'mx-datatype', unknown: 'mx-unknown' };
const COMPLETION_TYPE: Partial<Record<Expected, string>> = { class: 'class', object: 'property', data: 'property', individual: 'variable', datatype: 'type', enum: 'type', facet: 'keyword' };

export function createManchesterEditor(o: ManchesterEditorOptions): ManchesterEditor {
  const highlight = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const b = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;
        for (const t of readText(doc.toString(), o.naming(), o.as).tokens) {
          const cls = CLASS_OF[t.entity ?? t.kind];
          if (cls && t.to > t.from && t.to <= doc.length) b.add(t.from, t.to, Decoration.mark({ class: cls }));
        }
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
  // A problem of the text: where it is not read (an error), and, once it is, what OWL 2 DL does not allow of its entities.
  const lint = linter(
    (view) => {
      const text = view.state.doc.toString();
      if (!text.trim()) return [];
      const r = readText(text, o.naming(), o.as);
      if (r.error) {
        const at = Math.min(r.error.at, text.length);
        const token = r.tokens.find((t) => t.from === at);
        return [{ from: at, to: Math.max(at, Math.min(token?.to ?? at + 1, text.length)), severity: 'error', message: r.error.message } satisfies Diagnostic];
      }
      const e = o.as === 'class' ? parseClass(text, o.naming()) : parseDataRange(text, o.naming());
      return checkExpression(e, o.naming()).map((x): Diagnostic => ({ from: 0, to: text.length, severity: x.severity, message: x.message }));
    },
    { delay: 250 },
  );
  const complete = (ctx: CompletionContext): CompletionResult | null => {
    const text = ctx.state.doc.toString();
    const r = completionsAt(text, ctx.pos, o.naming(), o.as);
    // Offered as one types, or when asked for (Ctrl+Space); not on an empty place unless asked.
    if (!r.options.length || (!ctx.explicit && r.from === ctx.pos && !/[\s([{,]$/.test(text.slice(0, ctx.pos)))) return null;
    return { from: r.from, options: r.options.map((x) => ({ label: x.text, detail: x.detail, type: COMPLETION_TYPE[x.kind] ?? 'keyword' })), validFor: /^'?[\p{L}\p{N}_:\-. ]*$/u };
  };
  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.text,
      extensions: [
        history(),
        closeBrackets(),
        bracketMatching(),
        autocompletion({ override: [complete], activateOnTyping: true, icons: false }),
        highlight,
        lint,
        EditorView.lineWrapping,
        placeholder(o.placeholder ?? ''),
        EditorView.contentAttributes.of({ 'aria-label': o.label, 'aria-multiline': 'true', spellcheck: 'false' }),
        keymap.of([{ key: 'Mod-Enter', run: () => (o.onSubmit?.(), true) }, ...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) o.onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    setText(text) {
      if (text === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

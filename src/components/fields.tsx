import { useEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/**
 * Keeps keystrokes local and reports the value once, on blur or Enter, so that each edit is a
 * single undo step. An edit still pending when the field unmounts is committed too.
 */
function useCommit(value: string, onCommit: (v: string) => void) {
  const [draft, setDraftState] = useState(value);
  // Only text the user actually typed is ever committed. Without this, a field that unmounts
  // before it has caught up with a new `value` would write its stale draft back.
  const dirty = useRef(false);
  const latest = useRef({ draft, value, onCommit });
  latest.current = { draft, value, onCommit };
  useEffect(() => {
    dirty.current = false;
    setDraftState(value);
  }, [value]);
  useEffect(
    () => () => {
      const l = latest.current;
      if (dirty.current && l.draft !== l.value) l.onCommit(l.draft);
    },
    [],
  );
  const setDraft = (v: string) => {
    dirty.current = true;
    setDraftState(v);
  };
  const commit = () => {
    if (dirty.current && draft !== value) onCommit(draft);
    dirty.current = false;
  };
  const reset = () => {
    dirty.current = false;
    setDraftState(value);
  };
  return { draft, setDraft, commit, reset };
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onCommit: (v: string) => void };

export function CommitInput({ value, onCommit, ...rest }: InputProps) {
  const { draft, setDraft, commit, reset } = useCommit(value, onCommit);
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          reset();
          e.stopPropagation();
        }
      }}
    />
  );
}

type AreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onCommit: (v: string) => void };

export function CommitTextarea({ value, onCommit, ...rest }: AreaProps) {
  const { draft, setDraft, commit } = useCommit(value, onCommit);
  return <textarea {...rest} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
}

/**
 * For a dropdown listing every term: with hundreds of terms and a dropdown on every row, building
 * all the options up front makes a table unusable. The options are added when the pointer or
 * the keyboard reaches the dropdown, which is before it can be opened.
 */
export function useLazyOptions() {
  const [ready, setReady] = useState(false);
  const wake = () => setReady(true);
  return { ready, lazy: { onMouseEnter: wake, onFocus: wake, onTouchStart: wake, onPointerDown: wake } };
}

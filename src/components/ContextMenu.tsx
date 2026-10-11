import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { COLORS } from '../model/types';

export type MenuItem =
  | 'sep'
  | { heading: string }
  | { swatches: (color: string) => void; current?: string }
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: string };

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ContextMenu({ x, y, items, onClose }: MenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
  }, [x, y, items]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => {
        if (it === 'sep') return <div key={i} className="menu-sep" />;
        if ('heading' in it) {
          return (
            <div key={i} className="menu-heading">
              {it.heading}
            </div>
          );
        }
        if ('swatches' in it) {
          return (
            <div key={i} className="menu-swatches">
              <Swatches
                value={it.current}
                onPick={(c) => {
                  it.swatches(c);
                  onClose();
                }}
              />
            </div>
          );
        }
        return (
          <button
            key={i}
            role="menuitem"
            className={'menu-item' + (it.danger ? ' danger' : '')}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span className="menu-check">{it.checked ? '✓' : ''}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Swatches({ value, onPick }: { value?: string; onPick: (color: string) => void }) {
  return (
    <div className="swatches">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={c || 'Default'}
          aria-label={c || 'Default colour'}
          aria-pressed={value === c}
          className={'swatch' + (value === c ? ' on' : '')}
          style={{ background: `var(--nc-${c || 'default'}-fill)`, borderColor: `var(--nc-${c || 'default'}-stroke)` }}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

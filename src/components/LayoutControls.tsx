import { useEffect, useState } from 'react';
import { DIRECTION_LABEL, DIRECTIONS, LAYOUT_KINDS, LAYOUTS, ROUTING_LABEL, ROUTINGS, routingOf, SPACING, type EdgeRouting, type LayoutDirection, type LayoutKind } from '../layout/types';
import { layoutOf, useStore, viewOf } from '../model/store';

/**
 * The layout of the graph on the canvas, in the bar above it: which one, a button to run it
 * again, and one that opens its settings. All of it arranges the picture and nothing else: no
 * statement of the model is changed by any of it.
 */
export function LayoutBar({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const layout = useStore(layoutOf);
  const busy = useStore((s) => s.layoutBusy);
  const st = useStore.getState;
  return (
    <>
      <select className="layout-select" aria-label="Graph layout" title={`Graph layout: ${LAYOUTS[layout.kind].about}`} value={layout.kind} onChange={(e) => st().arrange(e.target.value as LayoutKind)}>
        {LAYOUT_KINDS.map((k) => (
          <option key={k} value={k}>
            {LAYOUTS[k].label}
          </option>
        ))}
      </select>
      {busy ? (
        <button className="btn small layout-busy" title="Stop working the layout out. The graph stays as it is." onClick={() => st().cancelLayout()}>
          <span className="spinner" aria-hidden="true" />
          Cancel
        </button>
      ) : (
        <button
          className="btn small"
          disabled={layout.kind === 'manual'}
          title={layout.kind === 'manual' ? 'A manual arrangement is not rearranged. Choose a layout to arrange the graph.' : `Run the ${LAYOUTS[layout.kind].label} layout again, over whatever was moved by hand since`}
          onClick={() => st().rearrange()}
        >
          Rearrange
        </button>
      )}
      <button className="btn small" aria-expanded={open} title="Spacing, direction, how lines run, and the arrangement made by hand" onClick={onToggle}>
        {open ? 'Hide layout options' : 'Layout options'}
      </button>
      <span className="sr-only" role="status">
        {busy ? `Working out the ${LAYOUTS[busy].label} layout…` : ''}
      </span>
    </>
  );
}

/** A slider that says what it is at while it is dragged, and asks for the layout only when it is let go. */
function Slider({ label, value, min, max, step, unit, onCommit }: { label: string; value: number; min: number; max: number; step: number; unit: string; onCommit: (v: number) => void }) {
  const [at, setAt] = useState(value);
  useEffect(() => setAt(value), [value]);
  const commit = () => at !== value && onCommit(at);
  return (
    <label className="layout-slider">
      <span>
        {label} <output>{unit === '×' ? `${at.toFixed(2).replace(/\.?0+$/, '')}×` : `${at}${unit}`}</output>
      </span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={at} onChange={(e) => setAt(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
    </label>
  );
}

/** The settings of the chosen layout: only what that layout has. */
export function LayoutOptions() {
  const layout = useStore(layoutOf);
  const selected = useStore((s) => s.sel.terms);
  const terms = useStore(viewOf).terms;
  const st = useStore.getState;
  const info = LAYOUTS[layout.kind];
  const root = terms.find((t) => t.id === layout.root);
  const picked = selected.length === 1 ? terms.find((t) => t.id === selected[0]) : undefined;
  const manual = layout.kind === 'manual';
  const saved = layout.saved ? Object.keys(layout.saved).length : 0;
  return (
    <div className="subgraph-body layout-options">
      <p className="muted">{info.about}</p>
      {info.direction && (
        <label className="field">
          <span>Direction</span>
          <select aria-label="Layout direction" value={layout.direction} onChange={(e) => st().setLayout({ direction: e.target.value as LayoutDirection })}>
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {DIRECTION_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
      )}
      {info.nodeSpacing && <Slider label={layout.kind === 'force' ? 'Line length' : 'Node spacing'} value={layout.nodeSpacing} min={SPACING.node.min} max={SPACING.node.max} step={4} unit=" px" onCommit={(nodeSpacing) => st().setLayout({ nodeSpacing })} />}
      {info.layerSpacing && <Slider label={layout.kind === 'radial' ? 'Ring spacing' : 'Layer spacing'} value={layout.layerSpacing} min={SPACING.layer.min} max={SPACING.layer.max} step={10} unit=" px" onCommit={(layerSpacing) => st().setLayout({ layerSpacing })} />}
      {info.repulsion && <Slider label="Repulsion" value={layout.repulsion} min={SPACING.repulsion.min} max={SPACING.repulsion.max} step={0.25} unit="×" onCommit={(repulsion) => st().setLayout({ repulsion })} />}
      {info.root && (
        <div className="field">
          <span>Root</span>
          <p className="layout-root">{root ? <strong>{root.name || 'Unnamed'}</strong> : 'The selected term, or else the term in the middle of the graph.'}</p>
          <div className="row">
            <button className="btn small" disabled={!picked || picked.id === layout.root} title={picked ? '' : 'Select one term on the canvas first'} onClick={() => picked && st().setLayout({ root: picked.id })}>
              {picked && picked.id !== layout.root ? `Use “${picked.name || 'Unnamed'}”` : 'Use the selected term'}
            </button>
            <button className="btn small" disabled={!layout.root} onClick={() => st().setLayout({ root: '' })}>
              Automatic
            </button>
          </div>
        </div>
      )}
      <label className="field">
        <span>Lines</span>
        <select aria-label="Edge routing" value={layout.routing} onChange={(e) => st().setLayout({ routing: e.target.value as EdgeRouting })}>
          {ROUTINGS.map((r) => (
            <option key={r} value={r}>
              {r === 'auto' ? `Automatic (${ROUTING_LABEL[routingOf({ kind: layout.kind, routing: 'auto' })].toLowerCase()})` : ROUTING_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Arrangement made by hand</span>
        {manual ? (
          <>
            <p className="muted">Terms stay where you put them. {saved ? 'A remembered arrangement can be brought back.' : 'Nothing is remembered yet beyond where the terms are now.'}</p>
            <div className="row">
              <button className="btn small" onClick={() => st().savePositions()}>
                Save positions
              </button>
              <button className="btn small" disabled={!saved} onClick={() => st().restorePositions()}>
                Restore saved positions
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">{saved ? 'Your manual arrangement is remembered: choosing Manual brings it back.' : 'Terms can still be dragged. Rearrange puts them back where the layout has them.'}</p>
            <div className="row">
              <button className="btn small" title="Stop arranging automatically, and keep the terms where they are now as the manual arrangement" onClick={() => st().keepAsManual()}>
                Keep this as manual
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useMemo } from 'react';
import { useStore } from '../model/store';
import type { Relation } from '../model/types';
import { activeProps, labelKey, resolveModel, suggestFor } from '../model/vocab';
import { MODEL_TYPES } from '../model/modelTypes';

const types = (ts: string[]) => (ts.length ? ts.join(' / ') : 'any term');

export function VocabView() {
  const model = useStore((s) => s.model);
  const st = useStore.getState;
  const skos = model.mode === 'skos';
  const props = useMemo(() => activeProps(model), [model]);
  const on = props.length > 0;
  const name = useMemo(() => new Map(model.terms.map((t) => [t.id, t.name || 'Unnamed'])), [model.terms]);

  // Your own relationships, one row per distinct label.
  const groups = useMemo(() => {
    const out = new Map<string, { label: string; rels: Relation[]; own: number }>();
    for (const r of model.relations) {
      if (r.kind !== 'association') continue;
      const key = labelKey(r.label);
      const g = out.get(key) ?? out.set(key, { label: r.label.trim(), rels: [], own: 0 }).get(key)!;
      g.rels.push(r);
      if (r.predicate && props.some((p) => p.id === r.predicate)) g.own++;
    }
    return [...out].sort((a, b) => b[1].rels.length - a[1].rels.length || a[0].localeCompare(b[0]));
  }, [model.relations, props]);

  const builtIn = (kind: Relation['kind']) => model.relations.filter((r) => r.kind === kind && !(r.predicate && props.some((p) => p.id === r.predicate))).length;
  const usage = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of resolveModel(model).relations) {
      const p = r.predicate ?? (skos && r.kind === 'generalization' ? 'skos:broader' : skos && !r.label.trim() ? 'skos:related' : undefined);
      if (p) n.set(p, (n.get(p) ?? 0) + 1);
    }
    return n;
  }, [model, skos]);
  const example = (r: Relation) => `${name.get(r.from)} → ${name.get(r.to)}`;
  const convert = (to: 'skos' | 'ontology') => {
    // The type of a model decides what the app offers for it, so it is changed only when that is confirmed.
    const type = MODEL_TYPES[to].label;
    if (!window.confirm(`Convert “${model.name}” to a ${type}?\n\nIts terms and relationships are restated in that type's terms, and the app then offers that type's functions. Undo brings it back.`)) return;
    st().convertTo(to);
    st().notify(to === 'ontology' ? 'Converted to an ontology. Undo brings the concept scheme back.' : 'Converted to a SKOS concept scheme. Undo brings the ontology back.');
  };

  return (
    <div className="view">
      <div className="view-head">
        <div className="row">
          <strong>This model is</strong>
          <div className="tabs" role="group" aria-label="Model type">
            <button className={skos ? 'on' : ''} aria-pressed={skos} onClick={() => convert('skos')}>
              a concept scheme (SKOS)
            </button>
            <button className={skos ? '' : 'on'} aria-pressed={!skos} onClick={() => convert('ontology')}>
              an ontology (OWL)
            </button>
          </div>
        </div>
        {!skos && (
          <label className="check">
            <input type="checkbox" checked={model.vocab.enabled} onChange={(e) => st().setVocabEnabled(e.target.checked)} />
            <span>Use RDFS &amp; OWL properties</span>
          </label>
        )}
      </div>
      <div className="vocab">
        {skos ? (
          <p className="muted">
            Every term is a <code>skos:Concept</code> in one concept scheme; its name is the preferred label, synonyms are alternative labels, and “is a” means{' '}
            <code>skos:broader</code>. Terms with nothing broader are the top concepts. Switching to <strong>an ontology</strong> converts the model: concepts become
            classes, broader becomes <code>rdfs:subClassOf</code>, exact matches become <code>owl:equivalentClass</code>, close matches become{' '}
            <code>rdfs:seeAlso</code>, and related becomes a “related to” property of your own. Labels and metadata are kept. You can also export either form
            from the File menu without converting.
          </p>
        ) : (
          <p className="muted">
            Terms are classes, properties and individuals. Switching to <strong>a concept scheme</strong> converts the model to SKOS: “is a” becomes{' '}
            <code>skos:broader</code>, equivalences become <code>skos:exactMatch</code>, and statements SKOS cannot express (such as disjointness) stay as
            plainly labelled relationships.
            {!on && ' Turn on RDFS & OWL properties to give relationships a standard meaning, such as rdfs:subClassOf or owl:equivalentClass.'}
          </p>
        )}
        {on && (
          <>
            <h3>Map your relationships</h3>
            <p className="muted">
              Each row is a relationship label used in the model. Choose the standard property it means and every relation with that label, now and later,
              exports as that property. A property set on a single relation (in its side panel) wins over this mapping.
            </p>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '24%' }}>Your relationship</th>
                  <th style={{ width: '26%' }}>Used</th>
                  <th style={{ width: 230 }}>Standard property</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {builtIn('generalization') > 0 && (
                  <tr>
                    <td>
                      <em>{skos ? 'broader' : 'is a'}</em>
                    </td>
                    <td>{builtIn('generalization')} relations</td>
                    <td>
                      <code>{skos ? 'skos:broader' : 'rdfs:subClassOf'}</code>
                    </td>
                    <td className="eg">{skos ? 'Built in. From the narrower concept to the broader one.' : 'Built in. Becomes rdf:type for an instance and rdfs:subPropertyOf between properties.'}</td>
                  </tr>
                )}
                {builtIn('property') > 0 && (
                  <tr>
                    <td>
                      <em>has property</em>
                    </td>
                    <td>{builtIn('property')} relations</td>
                    <td>
                      <code>{skos ? 'skos:related' : 'rdfs:domain'}</code>
                    </td>
                    <td className="eg">{skos ? 'SKOS has no properties of concepts, so these export as related.' : 'Built in. Written from the property to the term that owns it.'}</td>
                  </tr>
                )}
                {groups.map(([key, g]) => {
                  const mapped = props.some((p) => p.id === model.vocab.map[key]) ? model.vocab.map[key] : '';
                  const hint = !mapped ? suggestFor(model, g.label) : undefined;
                  return (
                    <tr key={key}>
                      <td>{g.label || <em>(no label)</em>}</td>
                      <td>
                        {g.rels.length} {g.rels.length === 1 ? 'relation' : 'relations'}
                        <div className="eg">
                          {example(g.rels[0])}
                          {g.rels.length > 1 ? ', …' : ''}
                        </div>
                      </td>
                      <td>
                        <select aria-label={`Standard property for ${g.label || 'unlabelled relations'}`} value={mapped} onChange={(e) => st().mapLabel(key, e.target.value)}>
                          <option value="">{skos ? (g.label ? 'None (own relation)' : 'skos:related (default)') : 'None (own property)'}</option>
                          {props.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.id}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {hint && (
                          <span className="suggest">
                            Looks like <code>{hint.id}</code>
                            <button className="btn small" onClick={() => st().mapLabel(key, hint.id)}>
                              Use it
                            </button>
                          </span>
                        )}
                        {skos && g.label && !mapped && !hint && <span className="eg">Exports as a relation of your own, declared as a kind of skos:related.</span>}
                        {g.own > 0 && (
                          <span className="eg">
                            {g.own} of these {g.own === 1 ? 'has' : 'have'} a property set individually.
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!groups.length && !builtIn('generalization') && <p className="muted">No relationships yet. Draw some on the canvas and they will be listed here.</p>}

            <h3>{skos ? 'SKOS relations' : 'Standard properties'}</h3>
            <p className="muted">These are also offered when you label a new relation on the canvas, and under “Standard property” in a relation's side panel.</p>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '24%' }}>Property</th>
                  <th style={{ width: '26%' }}>Connects</th>
                  <th>Meaning</th>
                  <th style={{ width: 70 }} className="num">
                    Used
                  </th>
                </tr>
              </thead>
              <tbody>
                {props.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <code>{p.id}</code>
                    </td>
                    <td>{skos ? `concept ${p.symmetric ? '↔' : '→'} concept` : `${types(p.from)} ${p.symmetric ? '↔' : '→'} ${types(p.to)}`}</td>
                    <td>{p.about}</td>
                    <td className="num">{usage.get(p.id) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

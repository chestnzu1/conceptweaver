import { describe, expect, it } from 'vitest';
import { withIris } from './iri';
import { stressModel } from './stress';
import { ancestorsOf, classTree, defaultOpen, matchingClasses, ROOT, treeRows } from './tree';
import { emptyModel, newRelation, newTerm, type Model } from './types';

function build(spec: string, extra: (m: Model, id: Record<string, string>) => void = () => {}) {
  const m = emptyModel('Cast');
  m.baseIri = 'http://example.org/o#';
  const id: Record<string, string> = {};
  const term = (name: string) => {
    if (!id[name]) {
      const t = newTerm({ name });
      id[name] = t.id;
      m.terms.push(t);
    }
    return id[name];
  };
  for (const line of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [child, parents] = line.split('<').map((s) => s.trim());
    term(child);
    for (const p of (parents ?? '').split(',').map((s) => s.trim()).filter(Boolean)) m.relations.push(newRelation({ from: term(child), to: term(p), kind: 'generalization' }));
  }
  extra(m, id);
  return { m: withIris(m), id };
}
const CAST = 'Person; Actor < Person; Employee < Person; WorkingActor < Actor, Employee; Director < Person; Film; Documentary < Film; Organization';
const names = (m: Model, ids: Iterable<string>) => [...ids].map((x) => (x === ROOT ? 'owl:Thing' : m.terms.find((t) => t.id === x)!.name));
const outline = (m: Model, rows: ReturnType<typeof treeRows>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.hasChildren ? (r.open ? '▼ ' : '▶ ') : '  '}${names(m, [r.id])[0]}${r.cycle ? ' (cycle)' : ''}`).join('\n');

describe('class hierarchy tree', () => {
  it('puts classes under owl:Thing by their stated superclasses, sorted by name', () => {
    const { m } = build(CAST);
    const tree = classTree(m);
    expect(tree.size).toBe(8);
    expect(names(m, tree.children.get(ROOT)!)).toEqual(['Film', 'Organization', 'Person']);
    expect(outline(m, treeRows(tree, defaultOpen(tree)))).toBe(
      ['▼ owl:Thing', '  ▼ Film', '      Documentary', '    Organization', '  ▼ Person', '    ▼ Actor', '        WorkingActor', '      Director', '    ▼ Employee', '        WorkingActor'].join('\n'),
    );
  });

  it('shows a class with two superclasses under both, as one and the same class', () => {
    const { m, id } = build(CAST);
    const rows = treeRows(classTree(m), defaultOpen(classTree(m))).filter((r) => r.id === id.WorkingActor);
    expect(rows).toHaveLength(2);
    // Two places in the tree, so two keys; one entity, so one id.
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(m.terms.filter((t) => t.name === 'WorkingActor')).toHaveLength(1);
    expect(names(m, classTree(m).parents.get(id.WorkingActor)!)).toEqual(['Actor', 'Employee']);
  });

  it('uses stated superclasses only, including a redundant one, and ignores non-class relations', () => {
    const { m, id } = build('Person; Actor < Person; Actress < Actor', (model, ids) => {
      const film = newTerm({ name: 'Film' });
      const rex = newTerm({ name: 'Rex', type: 'instance' });
      model.terms.push(film, rex);
      model.relations.push(newRelation({ from: ids.Actress, to: film.id, label: 'acts in' }), newRelation({ from: rex.id, to: ids.Actor, kind: 'generalization' }));
    });
    // Actress is under Actor only: Person follows from that but is not stated.
    expect(names(m, classTree(m).parents.get(id.Actress)!)).toEqual(['Actor']);
    expect(names(m, classTree(m).children.get(id.Person)!)).toEqual(['Actor']);
    expect(names(m, classTree(m).children.get(id.Actor)!)).toEqual(['Actress']);
    // Stated as well, it shows there too, redundant or not.
    const both = { ...m, relations: [...m.relations, newRelation({ from: id.Actress, to: id.Person, kind: 'generalization' })] };
    expect(names(both, classTree(both).children.get(id.Person)!)).toEqual(['Actor', 'Actress']);
    expect(classTree(both)).not.toBe(classTree(m));
    expect(m.relations).toHaveLength(4);
  });

  it('follows only open classes, and does not build what is collapsed', () => {
    const { m, id } = build(CAST);
    const tree = classTree(m);
    expect(outline(m, treeRows(tree, new Set()))).toBe('▶ owl:Thing');
    expect(outline(m, treeRows(tree, new Set([ROOT, id.Person])))).toBe(['▼ owl:Thing', '  ▶ Film', '    Organization', '  ▼ Person', '    ▶ Actor', '      Director', '    ▶ Employee'].join('\n'));
  });

  it('survives cycles: every class is reachable and no branch repeats for ever', () => {
    const { m } = build('A < C; B < A; C < B; D < A; Solo');
    const tree = classTree(m);
    const all = new Set([ROOT, ...tree.children.keys()]);
    const rows = treeRows(tree, all);
    expect(outline(m, rows)).toBe(['▼ owl:Thing', '  ▼ A', '    ▼ B', '      ▼ C', '          A (cycle)', '      D', '    Solo'].join('\n'));
    expect(new Set(rows.map((r) => r.id)).size).toBe(6);
    // A class that is its own superclass is simply at the top.
    const self = build('X', (model, ids) => model.relations.push(newRelation({ from: ids.X, to: ids.X, kind: 'generalization' })));
    expect(outline(self.m, treeRows(classTree(self.m), new Set([ROOT])))).toBe('▼ owl:Thing\n    X');
  });

  it('finds classes by name, synonym or IRI, and shows the way to each match in every branch', () => {
    const { m } = build(CAST, (model, ids) => {
      model.terms.find((t) => t.id === ids.Documentary)!.synonyms = 'Factual film';
      model.prefixes = [{ prefix: 'ex', iri: 'http://example.org/o#' }];
    });
    expect(names(m, matchingClasses(m, 'working'))).toEqual(['WorkingActor']);
    expect(names(m, matchingClasses(m, 'factual'))).toEqual(['Documentary']);
    expect(names(m, matchingClasses(m, 'ex:dir'))).toEqual(['Director']);
    expect(names(m, matchingClasses(m, 'o#organ'))).toEqual(['Organization']);
    expect(matchingClasses(m, '  ').size).toBe(0);
    const tree = classTree(m);
    const hits = matchingClasses(m, 'working');
    expect(names(m, ancestorsOf(tree, hits)).sort()).toEqual(['Actor', 'Employee', 'Person']);
    // Nothing is expanded, yet the search opens the way: once through Actor, once through Employee.
    const rows = treeRows(tree, new Set(), new Set([...hits, ...ancestorsOf(tree, hits)]));
    expect(outline(m, rows)).toBe(['▼ owl:Thing', '  ▼ Person', '    ▼ Actor', '        WorkingActor', '    ▼ Employee', '        WorkingActor'].join('\n'));
  });

  it('opens a large hierarchy two levels deep and stays quick', () => {
    const big = withIris(stressModel(1300));
    const t0 = performance.now();
    const tree = classTree(big);
    const open = defaultOpen(tree);
    const rows = treeRows(tree, open);
    expect(tree.size).toBe(1300);
    expect(open.size).toBeLessThan(40);
    expect(rows.length).toBeLessThan(200);
    // Everything open: every class is somewhere, some more than once, and it is still fast.
    const all = treeRows(tree, new Set([ROOT, ...tree.children.keys()]));
    expect(new Set(all.map((r) => r.id)).size).toBe(1301);
    expect(all.length).toBeGreaterThan(1300);
    expect(performance.now() - t0).toBeLessThan(1000);
    // The same model gives the same tree object back, so nothing is rebuilt while it is unchanged.
    expect(classTree(big)).toBe(tree);
  });
});

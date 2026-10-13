// The script of an exported model page. It goes into the file as it is, so it is plain script
// that depends on nothing outside the page: the model is in the page as data (#model-data) and
// the graph as an SVG whose shapes say which term or relationship they are.
//
// Everything from the model is put on the page as text, never as markup.
(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('model-data').textContent);
  const words = data.words;
  const terms = new Map(data.terms.map((t) => [t.id, t]));
  const rels = new Map(data.rels.map((r) => [r.id, r]));
  const props = new Map(data.props.map((p) => [p.id, p]));
  const outOf = new Map();
  const into = new Map();
  for (const r of data.rels) {
    outOf.set(r.from, [...(outOf.get(r.from) || []), r]);
    into.set(r.to, [...(into.get(r.to) || []), r]);
  }
  const nameOf = (id) => (terms.get(id) ? terms.get(id).name : 'Unnamed');
  const byName = (a, b) => a.name.localeCompare(b.name);

  /** Makes an element. Children that are text become text nodes, so nothing is ever read as markup. */
  const el = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    // Children may come as lists of lists (a row of a list is a term and its value): they are taken apart all the way.
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return node;
  };
  const nav = document.getElementById('nav');
  const detail = document.getElementById('detail');
  const search = document.getElementById('q');
  const svg = document.querySelector('#graph svg');

  document.getElementById('title').textContent = data.model.name;
  document.getElementById('type').textContent = data.model.type;

  // ------------------------------------------------------------ what is chosen

  /** { kind: 'term' | 'prop' | 'rel', id } or null. */
  let chosen = null;
  let query = '';
  // Which branches of the hierarchy are open: all of a small one, the top of a large one.
  const open = new Set(data.terms.length <= 80 ? Object.keys(data.tree.children) : data.tree.roots);

  function choose(next, opts) {
    chosen = next && ((next.kind === 'term' && terms.has(next.id)) || (next.kind === 'prop' && props.has(next.id)) || (next.kind === 'rel' && rels.has(next.id))) ? next : null;
    if (chosen && chosen.kind === 'term') reveal(chosen.id);
    renderNav();
    renderDetail();
    paint();
    if (chosen && opts && opts.centre) centreOn(chosen);
    const hash = chosen ? '#' + chosen.kind + '=' + encodeURIComponent(chosen.id) : '';
    if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname + location.search);
  }

  /** Opens the hierarchy down to a term, so that it can be seen in the list. */
  function reveal(id) {
    const parents = new Map();
    for (const [parent, kids] of Object.entries(data.tree.children)) for (const k of kids) parents.set(k, [...(parents.get(k) || []), parent]);
    const seen = new Set();
    const up = (x) => {
      for (const p of parents.get(x) || []) {
        if (seen.has(p)) continue;
        seen.add(p);
        open.add(p);
        up(p);
      }
    };
    up(id);
  }

  // ------------------------------------------------------------ the list

  const item = (label, sel, small) =>
    el('button', { type: 'button', class: 'item' + (chosen && chosen.kind === sel.kind && chosen.id === sel.id ? ' on' : ''), title: label, onclick: () => choose(sel, { centre: true }) }, label, small ? [' ', el('small', null, small)] : null);

  function branch(id, path) {
    const t = terms.get(id);
    if (!t) return null;
    // A term met again on the way down is a ring: it is listed, and not gone into a second time.
    const kids = path.includes(id) ? [] : data.tree.children[id] || [];
    const isOpen = open.has(id);
    const toggle = kids.length
      ? el(
          'button',
          {
            type: 'button',
            class: 'twisty',
            'aria-expanded': String(isOpen),
            'aria-label': (isOpen ? 'Collapse ' : 'Expand ') + t.name,
            onclick: () => {
              if (!open.delete(id)) open.add(id);
              renderNav();
            },
          },
          isOpen ? '▾' : '▸',
        )
      : el('span', { class: 'twisty none' });
    return el('li', null, el('div', { class: 'row' }, toggle, item(t.name, { kind: 'term', id })), kids.length && isOpen ? el('ul', null, kids.map((k) => branch(k, [...path, id]))) : null);
  }

  function renderNav() {
    nav.textContent = '';
    const q = query.trim().toLowerCase();
    if (q) {
      const hit = (x) => [x.name, x.iri, x.curie, x.description, ...(x.synonyms || [])].some((s) => s && s.toLowerCase().includes(q));
      const found = [...data.terms.filter(hit).map((t) => [t, { kind: 'term', id: t.id }, t.kind]), ...data.props.filter(hit).map((p) => [p, { kind: 'prop', id: p.id }, 'Object property'])].sort((a, b) => byName(a[0], b[0]));
      nav.append(el('h2', null, found.length + ' found'));
      if (!found.length) nav.append(el('p', { class: 'none-found' }, 'Nothing matches “' + query.trim() + '”.'));
      nav.append(el('ul', null, found.slice(0, 300).map(([x, sel, kind]) => el('li', null, el('div', { class: 'row' }, item(x.name, sel, kind))))));
      return;
    }
    const inTree = data.terms.filter((t) => t.type === 'concept');
    nav.append(el('h2', null, words.terms + ' (' + inTree.length + ')'));
    nav.append(el('ul', null, data.tree.roots.map((id) => branch(id, []))));
    for (const type of ['property', 'instance']) {
      const list = data.terms.filter((t) => t.type === type).sort(byName);
      if (!list.length) continue;
      nav.append(el('h2', null, words.kinds[type].plural + ' (' + list.length + ')'));
      nav.append(el('ul', null, list.map((t) => el('li', null, el('div', { class: 'row' }, el('span', { class: 'twisty none' }), item(t.name, { kind: 'term', id: t.id }))))));
    }
    if (data.props.length) {
      nav.append(el('h2', null, 'Object properties (' + data.props.length + ')'));
      nav.append(el('ul', null, [...data.props].sort(byName).map((p) => el('li', null, el('div', { class: 'row' }, el('span', { class: 'twisty none' }), item(p.name, { kind: 'prop', id: p.id }))))));
    }
  }

  // ------------------------------------------------------------ the details

  const termLink = (id) => el('button', { type: 'button', class: 'link', onclick: () => choose({ kind: 'term', id }, { centre: true }) }, nameOf(id));
  const section = (title, ...kids) => (kids.flat(Infinity).some(Boolean) ? [el('h3', null, title), ...kids.flat(Infinity)] : []);

  function iriRow(x) {
    if (!x.iri) return null;
    const button = el('button', { type: 'button', class: 'copy', title: 'Copy the full IRI', 'aria-label': 'Copy the IRI of ' + x.name }, 'Copy');
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(x.iri);
        button.textContent = 'Copied';
      } catch (e) {
        button.textContent = 'Select it';
      }
      setTimeout(() => (button.textContent = 'Copy'), 1500);
    });
    return el('div', { class: 'iri' }, el('code', { title: x.curie && x.curie !== x.iri ? x.curie : null }, x.iri), button);
  }

  const metaList = (meta) =>
    meta.length
      ? el(
          'dl',
          null,
          meta.map((m) => [
            el('dt', null, m.label),
            el(
              'dd',
              null,
              m.values.map((v, i) => [
                i ? ', ' : null,
                v.ref ? termLink(v.ref) : v.href ? el('a', { href: v.href, rel: 'noopener noreferrer', target: '_blank' }, v.text) : v.text,
                v.lang ? el('span', { class: 'lang' }, '@' + v.lang) : null,
              ]),
            ),
          ]),
        )
      : null;

  const relLine = (r, other, outgoing) =>
    el('li', null, outgoing ? [el('em', null, r.label + ' '), termLink(other)] : [termLink(other), el('em', null, ' ' + r.label)], ' ', el('button', { type: 'button', class: 'link muted', title: 'Show this relationship', onclick: () => choose({ kind: 'rel', id: r.id }, { centre: true }) }, '(' + r.kind + ')'));

  /** Puts the parts of a description on the page, leaving out the ones there are none of. */
  const show = (...parts) => {
    for (const part of parts.flat(Infinity)) if (part != null && part !== false) detail.append(part);
  };

  function renderDetail() {
    detail.textContent = '';
    if (!chosen) return renderOverview();
    if (chosen.kind === 'term') return renderTerm(terms.get(chosen.id));
    if (chosen.kind === 'prop') return renderProp(props.get(chosen.id));
    return renderRel(rels.get(chosen.id));
  }

  function renderOverview() {
    const m = data.model;
    const count = (type) => data.terms.filter((t) => t.type === type).length;
    show(
      el('h2', null, m.name),
      el('p', null, el('span', { class: 'chip' }, m.type)),
      m.description ? el('p', null, m.description) : null,
      ...section(
        'Contents',
        el(
          'dl',
          null,
          [
            [words.terms, count('concept')],
            [words.kinds.property.plural, words.kinds.property.plural === words.terms ? 0 : count('property')],
            [words.kinds.instance.plural, words.kinds.instance.plural === words.terms ? 0 : count('instance')],
            ['Object properties', data.props.length],
            ['Relationships', data.rels.length],
          ]
            .filter(([, n]) => n)
            .map(([label, n]) => [el('dt', null, label), el('dd', null, n)]),
        ),
      ),
      ...section('Namespace', el('div', { class: 'iri' }, el('code', null, m.namespace))),
      ...section('How to read it', el('p', { class: 'muted' }, 'Click a term in the graph or in the list to see what is known about it. Drag a term to move it, a relationship to bend its line, and the background to move the whole graph; scroll to zoom. With a term chosen, Shift and an arrow key move it too. The search finds terms by name or IRI.')),
      m.partial ? el('p', { class: 'muted' }, 'The graph shows the part of the model that was on the canvas when it was exported. The list has all of it.') : null,
      el('p', { class: 'foot' }, 'Exported from ConceptWeaver on ' + new Date(m.exported).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) + '. A read-only copy: moving things about rearranges the picture in this browser, and changes nothing in the model.'),
    );
  }

  function renderTerm(t) {
    const out = outOf.get(t.id) || [];
    const inc = into.get(t.id) || [];
    const up = out.filter((r) => r.hier === 'isa');
    const down = inc.filter((r) => r.hier === 'isa');
    const typesOf = out.filter((r) => r.hier === 'type');
    const members = inc.filter((r) => r.hier === 'type');
    // A class that is an enumeration is exactly the individuals it lists; that is not the same as their being of its type.
    const lists = out.filter((r) => r.hier === 'oneOf');
    const listedBy = inc.filter((r) => r.hier === 'oneOf');
    const others = [...out.filter((r) => !r.hier).map((r) => relLine(r, r.to, true)), ...inc.filter((r) => !r.hier).map((r) => relLine(r, r.from, false))];
    const list = (rs, end) => (rs.length ? el('ul', { class: 'links' }, rs.map((r) => el('li', null, termLink(r[end])))) : null);
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    show(
      el('h2', null, t.name),
      el('p', null, el('span', { class: 'chip' }, (t.external ? 'External ' : '') + t.kind)),
      iriRow(t),
      t.description ? el('p', null, t.description) : null,
      t.synonyms.length ? el('p', { class: 'muted' }, 'Also: ' + t.synonyms.join(', ')) : null,
      ...section(cap(words.parent) + (up.length === 1 ? '' : 's'), list(up, 'to')),
      ...section(cap(words.child) + (down.length === 1 ? '' : 's'), list(down, 'from')),
      ...section('Is an instance of', list(typesOf, 'to')),
      ...section('Instances', list(members, 'from')),
      ...section('Enumeration: exactly these individuals', list(lists, 'to')),
      ...section('Listed by the enumeration', list(listedBy, 'from')),
      ...section('Relationships', others.length ? el('ul', { class: 'links' }, others) : null),
      ...section('Datatype', t.datatype ? el('p', null, t.datatype) : null),
      ...section('Values', t.values.length ? el('dl', null, t.values.map((v) => [el('dt', null, v.prop), el('dd', null, v.value)])) : null),
      ...section('Metadata', metaList(t.meta)),
    );
  }

  function renderProp(p) {
    const uses = p.uses.map((id) => rels.get(id)).filter(Boolean);
    show(
      el('h2', null, p.name),
      el('p', null, el('span', { class: 'chip' }, 'Object property')),
      iriRow(p),
      p.description ? el('p', null, p.description) : null,
      ...section(
        'Declared',
        el('dl', null, [el('dt', null, 'Domain'), el('dd', null, p.domain.join(', ') || 'anything'), el('dt', null, 'Range'), el('dd', null, p.range.join(', ') || 'anything'), p.characteristics.length ? [el('dt', null, 'Characteristics'), el('dd', null, p.characteristics.join(', '))] : null]),
      ),
      ...section('Used in', uses.length ? el('ul', { class: 'links' }, uses.map((r) => el('li', null, termLink(r.from), el('em', null, ' ' + r.label + ' '), termLink(r.to)))) : el('p', { class: 'muted' }, 'Not used between any two terms yet.')),
      ...section('Metadata', metaList(p.meta)),
    );
  }

  function renderRel(r) {
    show(
      el('h2', null, r.label),
      el('p', null, el('span', { class: 'chip' }, r.kind)),
      el('ul', { class: 'links' }, el('li', null, 'From ', termLink(r.from)), el('li', null, 'To ', termLink(r.to))),
      r.description ? el('p', null, r.description) : null,
      r.cards ? el('p', { class: 'muted' }, 'Cardinality: ' + r.cards) : null,
    );
  }

  // ------------------------------------------------------------ the picture

  /** Marks in the picture what is chosen and what it touches; the rest is faded. */
  function paint() {
    if (!svg) return;
    const sel = new Set();
    const near = new Set();
    if (chosen && chosen.kind === 'term') {
      sel.add('t:' + chosen.id);
      for (const r of [...(outOf.get(chosen.id) || []), ...(into.get(chosen.id) || [])]) {
        near.add('r:' + r.id);
        near.add('t:' + r.from);
        near.add('t:' + r.to);
      }
    } else if (chosen && chosen.kind === 'rel') {
      const r = rels.get(chosen.id);
      sel.add('r:' + r.id);
      near.add('t:' + r.from);
      near.add('t:' + r.to);
    } else if (chosen) {
      for (const id of props.get(chosen.id).uses) {
        const r = rels.get(id);
        if (!r) continue;
        sel.add('r:' + id);
        near.add('t:' + r.from);
        near.add('t:' + r.to);
      }
    }
    svg.classList.toggle('focused', !!chosen);
    for (const g of svg.querySelectorAll('[data-term], [data-rel]')) {
      const key = g.hasAttribute('data-term') ? 't:' + g.getAttribute('data-term') : 'r:' + g.getAttribute('data-rel');
      g.classList.toggle('sel', sel.has(key));
      g.classList.toggle('near', near.has(key));
    }
  }

  // ---- drawing a line between two terms, the way the app draws it (geometry.ts there)

  const round = (n) => Math.round(n * 10) / 10;
  const pt = (p) => round(p.x) + ',' + round(p.y);
  const unit = (x, y) => {
    const l = Math.hypot(x, y) || 1;
    return { x: x / l, y: y / l };
  };
  const hexInset = (w, h) => Math.min(h * 0.32, w * 0.25);

  /** Where the ray from a term's centre towards a point leaves its outline, whatever its shape. */
  function leave(t, tx, ty) {
    const dx = tx - t.x;
    const dy = ty - t.y;
    if (!dx && !dy) return { x: t.x, y: t.y };
    const a = t.w / 2 + 3;
    const b = t.h / 2 + 3;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const box = Math.min(dx === 0 ? Infinity : a / ax, dy === 0 ? Infinity : b / ay);
    let s = box;
    if (t.shape === 'ellipse') s = 1 / Math.hypot(dx / a, dy / b);
    else if (t.shape === 'diamond') s = 1 / (ax / a + ay / b);
    else if (t.shape === 'hexagon') s = Math.min(box, a / (ax + (hexInset(t.w, t.h) / (t.h / 2)) * ay));
    return { x: t.x + dx * s, y: t.y + dy * s };
  }

  function arrowHead(tip, d, head) {
    const big = head === 'hollow' || head === 'open';
    const len = big ? 13 : 9;
    const half = big ? 6.5 : 4;
    const bx = tip.x - d.x * len;
    const by = tip.y - d.y * len;
    // The line stops at the back of a hollow head, and runs to the tip where there is nothing to run into.
    return { tip, a: { x: bx - d.y * half, y: by + d.x * half }, b: { x: bx + d.y * half, y: by - d.x * half }, inset: head === 'hollow' ? len : head === 'filled' ? len - 3 : 0 };
  }

  /** The point on one side of a term's outline, `shift` along that side from its middle, whatever its shape. */
  function sideExit(t, side, shift) {
    const upright = side === 'top' || side === 'bottom';
    const half = upright ? t.w / 2 : t.h / 2;
    const out = upright ? t.h / 2 : t.w / 2;
    const s = Math.max(-half * 0.7, Math.min(half * 0.7, shift));
    let reach = out;
    if (t.shape === 'ellipse') reach = out * Math.sqrt(1 - (s / half) * (s / half));
    else if (t.shape === 'diamond') reach = out * (1 - Math.abs(s) / half);
    else if (t.shape === 'hexagon') {
      const inset = hexInset(t.w, t.h);
      reach = upright ? (Math.abs(s) <= half - inset ? out : (out * (half - Math.abs(s))) / inset) : out - (inset * Math.abs(s)) / half;
    }
    const sign = side === 'bottom' || side === 'right' ? 1 : -1;
    return upright ? { x: t.x + s, y: t.y + sign * (reach + 3) } : { x: t.x + sign * (reach + 3), y: t.y + s };
  }

  /**
   * A line that leaves its terms square to their sides, with right angles or as an S-shaped curve,
   * as the canvas draws it under the layout the picture was made with. Nothing where the two terms
   * are too close for it: then the line runs straight.
   */
  function routedLine(r, a, b) {
    const ROOM = 18;
    const roomV = Math.abs(b.y - a.y) - (a.h + b.h) / 2;
    const roomH = Math.abs(b.x - a.x) - (a.w + b.w) / 2;
    const dir = data.route.dir;
    const layersDown = dir === 'TB' || dir === 'BT';
    const upright = layersDown ? roomV >= ROOM || roomH < ROOM : !(roomH >= ROOM || roomV < ROOM);
    if ((upright ? roomV : roomH) < ROOM) return null;
    const at = (u, v) => (upright ? { x: v, y: u } : { x: u, y: v });
    const uOf = (p) => (upright ? p.y : p.x);
    const vOf = (p) => (upright ? p.x : p.y);
    const su = Math.sign(uOf(b) - uOf(a)) || 1;
    const shift = r.bend * (r.from > r.to ? -1 : 1) * 0.3;
    const forward = dir === 'TB' || dir === 'LR' ? su > 0 : su < 0;
    const port = r.port || 0;
    const p0 = sideExit(a, upright ? (su > 0 ? 'bottom' : 'top') : su > 0 ? 'right' : 'left', shift + (forward ? 0 : port));
    const p1 = sideExit(b, upright ? (su > 0 ? 'top' : 'bottom') : su > 0 ? 'left' : 'right', shift + (forward ? port : 0));
    const u0 = uOf(p0);
    const u1 = uOf(p1);
    const v0 = vOf(p0);
    const v1 = vOf(p1);
    const sv = Math.sign(v1 - v0);
    const mid = Math.max(Math.min(u0, u1) + 7, Math.min(Math.max(u0, u1) - 7, (u0 + u1) / 2 - shift * sv * su * 0.6));
    const head = arrowHead(p1, at(su, 0), r.head);
    const end = at(u1 - su * head.inset, v1);
    const atEnd = forward !== !!r.labelUp;
    const ua = atEnd ? mid : u0;
    const ub = atEnd ? u1 : mid;
    const vl = atEnd ? v1 : v0;
    const beside = sv || 1;
    const cards = { fromCard: at(u0 + su * 14, v0 - beside * 12), toCard: at(u1 - su * 22, v1 + beside * 12) };
    if (data.route.how === 'curved') {
      const d = 'M' + pt(p0) + ' C' + pt(at((u0 + u1) / 2, v0)) + ' ' + pt(at((u0 + u1) / 2, v1)) + ' ' + pt(end);
      return Object.assign({ d, head, at: (t) => ({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t }) }, cards);
    }
    const q = Math.min(6, Math.abs(v1 - v0) / 2, Math.abs(mid - u0), Math.abs(u1 - mid));
    const d =
      q < 0.5
        ? 'M' + pt(p0) + ' L' + pt(at(mid, v0)) + ' L' + pt(at(mid, v1)) + ' L' + pt(end)
        : 'M' + pt(p0) + ' L' + pt(at(mid - su * q, v0)) + ' Q' + pt(at(mid, v0)) + ' ' + pt(at(mid, v0 + sv * q)) + ' L' + pt(at(mid, v1 - sv * q)) + ' Q' + pt(at(mid, v1)) + ' ' + pt(at(mid + su * q, v1)) + ' L' + pt(end);
    return Object.assign({ d, head, at: (t) => at(ua + (ub - ua) * t, vl) }, cards);
  }

  /** The line of a relationship as it runs now: its path, its head, and where its words go. */
  function route(r) {
    const a = terms.get(r.from);
    const b = terms.get(r.to);
    if (a === b) {
      // A relationship from a term to itself is a loop at its corner.
      const size = 34 + Math.abs(r.bend) * 0.45;
      const p0 = { x: a.x + a.w / 2 - 26, y: a.y - a.h / 2 - 3 };
      const p1 = { x: a.x + a.w / 2 + 3, y: a.y - a.h / 2 + 12 };
      const head = arrowHead(p1, { x: -1, y: 0 }, r.head);
      const end = { x: p1.x + head.inset, y: p1.y };
      const label = { x: a.x + a.w / 2 + size * 0.35, y: a.y - a.h / 2 - size * 0.62 };
      return { d: 'M' + pt(p0) + ' C' + pt({ x: p0.x, y: p0.y - size }) + ' ' + pt({ x: end.x + size, y: end.y }) + ' ' + pt(end), head, at: () => label, fromCard: { x: p0.x - 10, y: p0.y - 10 }, toCard: { x: p1.x + 14, y: p1.y + 14 } };
    }
    const routed = data.route && data.route.how !== 'direct' ? routedLine(r, a, b) : null;
    if (routed) return routed;
    // Which way a line bows does not depend on which way the relationship points.
    const flip = r.from > r.to ? -1 : 1;
    const dir = unit(b.x - a.x, b.y - a.y);
    const n = { x: -dir.y * flip, y: dir.x * flip };
    const c = { x: (a.x + b.x) / 2 + n.x * r.bend, y: (a.y + b.y) / 2 + n.y * r.bend };
    const p0 = leave(a, c.x, c.y);
    const p1 = leave(b, c.x, c.y);
    const dEnd = unit(p1.x - c.x, p1.y - c.y);
    const dStart = unit(c.x - p0.x, c.y - p0.y);
    const head = arrowHead(p1, dEnd, r.head);
    const end = { x: p1.x - dEnd.x * head.inset, y: p1.y - dEnd.y * head.inset };
    return {
      d: 'M' + pt(p0) + ' Q' + pt(c) + ' ' + pt(end),
      head,
      at: (t) => ({ x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * c.x + t * t * p1.x, y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * c.y + t * t * p1.y }),
      fromCard: { x: p0.x + dStart.x * 16 - dStart.y * 11, y: p0.y + dStart.y * 16 + dStart.x * 11 },
      toCard: { x: p1.x - dEnd.x * 24 - dEnd.y * 11, y: p1.y - dEnd.y * 24 + dEnd.x * 11 },
    };
  }

  // ---- the shapes of the picture, and moving them

  const nodeEl = new Map();
  const edgeEl = new Map();
  /** How far along its line a relationship's words sit: the app moves them off the middle where two would overlap. */
  const ALONG = [0.5, 0.36, 0.64, 0.25, 0.75];

  /** How wide and how high the outline of a term is drawn. */
  function sizeOf(shape) {
    if (!shape) return null;
    const tag = shape.tagName.toLowerCase();
    if (tag === 'rect') return { w: shape.width.baseVal.value, h: shape.height.baseVal.value };
    if (tag === 'ellipse') return { w: shape.rx.baseVal.value * 2, h: shape.ry.baseVal.value * 2 };
    if (tag !== 'polygon') return null;
    const nums = (shape.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    return xs.length && ys.length ? { w: Math.max(...xs), h: Math.max(...ys) } : null;
  }

  /** Finds the shapes of the picture, and gives each line a wide unseen twin, since a thin line is hard to hit. */
  function prepare() {
    nodeEl.clear();
    edgeEl.clear();
    for (const g of svg.querySelectorAll('[data-term]')) {
      const t = terms.get(g.getAttribute('data-term'));
      if (!t) continue;
      nodeEl.set(t.id, g);
      // The picture is the measure of where a term is and how big it is: it may be of a part of
      // the model laid out by itself, which the data, being of the whole model, does not know.
      const size = sizeOf(g.firstElementChild);
      if (size) [t.w, t.h] = [size.w, size.h];
      const at = /translate\(\s*(-?[\d.eE+-]+)[\s,]+(-?[\d.eE+-]+)/.exec(g.getAttribute('transform') || '');
      if (at) [t.x, t.y] = [Number(at[1]) + t.w / 2, Number(at[2]) + t.h / 2];
    }
    for (const g of svg.querySelectorAll('[data-rel]')) {
      const r = rels.get(g.getAttribute('data-rel'));
      const line = g.querySelector('[data-part="line"]') || g.querySelector('path');
      if (!r || !line) continue;
      line.classList.add('line');
      const head = g.querySelector('[data-part="head"]');
      if (head) head.classList.add('head');
      const hit = line.cloneNode(false);
      hit.removeAttribute('style');
      hit.removeAttribute('data-part');
      hit.setAttribute('class', 'hit');
      g.insertBefore(hit, line);
      const label = g.querySelector('[data-part="label"]');
      edgeEl.set(r.id, { g, line, hit, head, label, bg: g.querySelector('[data-part="label-bg"]'), fromCard: g.querySelector('[data-part="from-card"]'), toCard: g.querySelector('[data-part="to-card"]') });
      // Where its words are now says how far along the line they belong.
      if (label && r.t === undefined) {
        const geo = route(r);
        const at = { x: Number(label.getAttribute('x')), y: Number(label.getAttribute('y')) };
        r.t = ALONG.reduce((best, t) => (Math.hypot(geo.at(t).x - at.x, geo.at(t).y - at.y) < Math.hypot(geo.at(best).x - at.x, geo.at(best).y - at.y) ? t : best), 0.5);
      }
    }
  }

  /** Draws a relationship's line again from where its two terms are now. */
  function redraw(r) {
    const e = edgeEl.get(r.id);
    if (!e) return;
    const geo = route(r);
    e.line.setAttribute('d', geo.d);
    e.hit.setAttribute('d', geo.d);
    if (e.head) e.head.setAttribute('points', e.head.tagName.toLowerCase() === 'polyline' ? pt(geo.head.a) + ' ' + pt(geo.head.tip) + ' ' + pt(geo.head.b) : pt(geo.head.tip) + ' ' + pt(geo.head.a) + ' ' + pt(geo.head.b));
    const place = (node, p) => {
      if (!node) return;
      node.setAttribute('x', round(p.x));
      node.setAttribute('y', round(p.y));
    };
    const words = geo.at(r.t === undefined ? 0.5 : r.t);
    place(e.label, words);
    if (e.bg) place(e.bg, { x: words.x - e.bg.width.baseVal.value / 2, y: words.y - e.bg.height.baseVal.value / 2 });
    place(e.fromCard, geo.fromCard);
    place(e.toCard, geo.toCard);
  }

  /** Puts a term somewhere else. Every line that ends at it follows. */
  function moveTerm(id, x, y) {
    const t = terms.get(id);
    const g = nodeEl.get(id);
    if (!t || !g) return;
    t.x = round(x);
    t.y = round(y);
    g.setAttribute('transform', 'translate(' + round(t.x - t.w / 2) + ',' + round(t.y - t.h / 2) + ')');
    for (const r of [...(outOf.get(id) || []), ...(into.get(id) || [])]) redraw(r);
    layout.pos[id] = [t.x, t.y];
  }

  /** Bows a relationship's line so that it passes where the pointer is; near straight, it snaps straight. */
  function bendTo(r, p) {
    const a = terms.get(r.from);
    const b = terms.get(r.to);
    if (a === b) return;
    const flip = r.from > r.to ? -1 : 1;
    const dir = unit(b.x - a.x, b.y - a.y);
    const off = 2 * ((p.x - (a.x + b.x) / 2) * -dir.y * flip + (p.y - (a.y + b.y) / 2) * dir.x * flip);
    r.bend = Math.abs(off) < 12 ? 0 : Math.max(-500, Math.min(500, round(off)));
    redraw(r);
    layout.bend[r.id] = r.bend;
  }

  // What was moved is remembered in this browser, for this file, so that it is still there after a reload.
  // It is an arrangement of the picture only: the model in the file is as it was exported.
  const KEY = 'conceptweaver-layout:' + data.model.iri + ':' + data.model.exported;
  const exportedBend = new Map(data.rels.map((r) => [r.id, r.bend]));
  let layout = { pos: {}, bend: {} };
  let pristine = '';
  const resetButton = document.getElementById('layout-reset');
  const remember = () => {
    const changed = Object.keys(layout.pos).length + Object.keys(layout.bend).length > 0;
    resetButton.hidden = !changed;
    try {
      if (changed) localStorage.setItem(KEY, JSON.stringify(layout));
      else localStorage.removeItem(KEY);
    } catch (e) {
      // Kept for as long as the page is open, then.
    }
  };
  function restore() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (e) {
      saved = null;
    }
    if (!saved) return;
    for (const [id, bend] of Object.entries(saved.bend || {})) {
      const r = rels.get(id);
      if (r && edgeEl.has(id) && Number.isFinite(bend)) {
        r.bend = bend;
        layout.bend[id] = bend;
        redraw(r);
      }
    }
    for (const [id, at] of Object.entries(saved.pos || {})) if (nodeEl.has(id) && Array.isArray(at) && at.every(Number.isFinite)) moveTerm(id, at[0], at[1]);
    remember();
  }
  /** Back to the picture as it was exported. */
  function resetLayout() {
    for (const r of data.rels) {
      r.bend = exportedBend.get(r.id);
      delete r.t;
    }
    layout = { pos: {}, bend: {} };
    // The picture as it came, which also says again where every term is.
    svg.innerHTML = pristine;
    prepare();
    paint();
    remember();
    fit();
  }

  // The view of the picture is its viewBox: moving about and zooming change that and nothing else.
  let box = null;
  let whole = null;
  const setBox = () => svg.setAttribute('viewBox', box.x + ' ' + box.y + ' ' + box.w + ' ' + box.h);
  const toWorld = (cx, cy) => {
    const p = svg.createSVGPoint();
    p.x = cx;
    p.y = cy;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  };
  /** The room the terms take up where they are now, with a margin. */
  function extent() {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const id of nodeEl.keys()) {
      const t = terms.get(id);
      x0 = Math.min(x0, t.x - t.w / 2);
      y0 = Math.min(y0, t.y - t.h / 2);
      x1 = Math.max(x1, t.x + t.w / 2);
      y1 = Math.max(y1, t.y + t.h / 2);
    }
    return Number.isFinite(x0) ? { x: x0 - 70, y: y0 - 70, w: x1 - x0 + 140, h: y1 - y0 + 140 } : whole;
  }
  function fit() {
    // With nothing moved, exactly the view the page opened with.
    box = { ...(Object.keys(layout.pos).length ? extent() : whole) };
    setBox();
  }
  function zoom(factor, at) {
    const all = extent();
    const w = Math.min(all.w * 4, Math.max(all.w / 16, box.w * factor));
    const k = w / box.w;
    const c = at || { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    box = { x: c.x - (c.x - box.x) * k, y: c.y - (c.y - box.y) * k, w, h: box.h * k };
    setBox();
  }
  function centreOn(sel) {
    if (!svg) return;
    let at = null;
    if (sel.kind === 'term') at = terms.get(sel.id);
    else if (sel.kind === 'rel') {
      const r = rels.get(sel.id);
      at = { x: (terms.get(r.from).x + terms.get(r.to).x) / 2, y: (terms.get(r.from).y + terms.get(r.to).y) / 2 };
    }
    // Only what is in the picture can be gone to: a subgraph has part of the model.
    if (!at || (sel.kind === 'term' && !nodeEl.has(sel.id))) return;
    // Left alone if it is comfortably in view already; brought to the middle otherwise.
    const mx = box.w * 0.12;
    const my = box.h * 0.12;
    if (at.x > box.x + mx && at.x < box.x + box.w - mx && at.y > box.y + my && at.y < box.y + box.h - my) return;
    box = { ...box, x: at.x - box.w / 2, y: at.y - box.h / 2 };
    setBox();
  }

  if (svg) {
    const [x, y, w, h] = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
    whole = { x, y, w, h };
    box = { ...whole };
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Graph of ' + data.model.name + '. The same terms are in the list beside it.');
    pristine = svg.innerHTML;
    prepare();
    restore();
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        zoom(e.deltaY < 0 ? 0.85 : 1 / 0.85, toWorld(e.clientX, e.clientY));
      },
      { passive: false },
    );
    // A press that moves is a drag: of a term, of a relationship's line, or else of the whole picture.
    // One that does not move is a click on what is under it.
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const g = e.target.closest ? e.target.closest('[data-term], [data-rel]') : null;
      const what = !g ? null : g.hasAttribute('data-term') ? { kind: 'term', id: g.getAttribute('data-term') } : { kind: 'rel', id: g.getAttribute('data-rel') };
      drag = { x: e.clientX, y: e.clientY, moved: false, what, world: toWorld(e.clientX, e.clientY) };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      svg.classList.add('dragging');
      const p = toWorld(e.clientX, e.clientY);
      if (drag.what && drag.what.kind === 'term' && nodeEl.has(drag.what.id)) {
        const t = terms.get(drag.what.id);
        moveTerm(t.id, t.x + p.x - drag.world.x, t.y + p.y - drag.world.y);
        drag.world = p;
      } else if (drag.what && drag.what.kind === 'rel' && edgeEl.has(drag.what.id)) {
        bendTo(rels.get(drag.what.id), p);
      } else {
        const scale = svg.getScreenCTM().a;
        box = { ...box, x: box.x - dx / scale, y: box.y - dy / scale };
        setBox();
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
    });
    const drop = (e) => {
      if (!drag) return;
      const { moved, what } = drag;
      drag = null;
      svg.classList.remove('dragging');
      if (moved) return what ? remember() : undefined;
      if (e.type !== 'pointercancel') choose(what);
    };
    svg.addEventListener('pointerup', drop);
    svg.addEventListener('pointercancel', drop);
    document.getElementById('zoom-in').addEventListener('click', () => zoom(0.8));
    document.getElementById('zoom-out').addEventListener('click', () => zoom(1.25));
    document.getElementById('zoom-fit').addEventListener('click', fit);
    resetButton.addEventListener('click', resetLayout);
  } else {
    document.querySelector('.zoom').hidden = true;
  }

  // ------------------------------------------------------------ the rest

  search.addEventListener('input', () => {
    query = search.value;
    renderNav();
  });
  document.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === '/' && !typing) {
      e.preventDefault();
      search.focus();
    } else if (e.shiftKey && !typing && chosen && chosen.kind === 'term' && svg && nodeEl.has(chosen.id) && /^Arrow/.test(e.key)) {
      // What a drag does with the pointer, the keyboard does a step at a time.
      e.preventDefault();
      const t = terms.get(chosen.id);
      const step = 12;
      moveTerm(t.id, t.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0), t.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0));
      remember();
    } else if (e.key === 'Escape') {
      if (typing && search.value) {
        search.value = query = '';
        renderNav();
      } else choose(null);
    }
  });
  // A link to the page can name what to show: #term=…, #prop=… or #rel=….
  const fromHash = () => {
    const m = /^#(term|prop|rel)=(.+)$/.exec(location.hash);
    choose(m ? { kind: m[1], id: decodeURIComponent(m[2]) } : null, { centre: true });
  };
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();

# ConceptWeaver

A browser-based visual editor for knowledge graphs, glossaries and small ontologies, in the
spirit of [Termboard](https://termboard.com). Draw terms as boxes, connect them with labelled
relations, and export a standards-compliant model. Everything stays in the browser: no
account, no server.

```bash
pnpm install
pnpm dev        # http://localhost:5180
pnpm test       # model-layer unit tests
pnpm build      # static site in dist/
```

## What it does

- **Two model types** – a SKOS concept scheme (thesaurus, taxonomy, glossary) or an OWL ontology,
  switchable at any time: the model is converted (broader ↔ is-a, exactMatch ↔ equivalentClass, …)
  and either form can be exported without converting. SKOS models get the SKOS relations, labels
  per language, the SKOS integrity checks, tree entry in the Hierarchy view and an indented-outline
  bulk import.

- **Canvas** – double-click to add a term, drag a term's ⊕ handle onto another term to relate
  them (or onto empty space to create the other term), right-click anything for its menu.
  Pan by dragging, zoom with the wheel, Ctrl+drag to box-select. Full undo/redo.
- **My Models** – save models in this browser (IndexedDB) and reopen them later: Save, Save as,
  and a list to open, rename, duplicate and delete. The header shows whether the model in the
  editor has unsaved changes. Browser storage is local and can be cleared, so export files too.
- **Ontology settings** – File → Ontology settings: the ontology IRI, the default namespace new
  IRIs are made in, and namespace prefixes. Prefixes only change how an IRI is written (`ex:Actor`
  in tables, Turtle, SPARQL and search); they are kept on import and written on export.
- **IRIs** – every entity has a full IRI, made once in the model's base namespace when it is first
  named (or kept from an import) and unchanged by renaming. Shown read-only with a copy button.
- **Asserted superclasses** – a class lists every superclass explicitly stated for it (not the
  inferred ones) and they can be added and removed one at a time. Anonymous class expressions from
  an imported ontology that the app cannot draw are kept word for word and exported again.
- **Entities view** – classes, object properties, data properties and individuals each in their
  own tab, with the side panel as the editor, in the manner of Protégé.
- **Object properties** – only the ones you declare (domain, range, characteristics, inverse,
  parent). A relationship whose label names one is a use of it: between two classes it is a
  restriction on the class (`some`, `only`, `min`/`max`/`exactly` N), between individuals a fact.
  Any other labelled relationship stays a plain relationship until you make it a property.
- **Class restrictions** – a class lists what its object and data properties require of it,
  Protégé-style, and exports them as OWL restrictions.
- **Examples** – File menu: a small film ontology, a SKOS thesaurus, and a large university
  ontology (130 terms, 26 object properties, 195 relationships) for testing at scale.
- **Terms** – class, data property (with a domain and a datatype) or individual; description, synonyms, colour, and metadata fields
  (Protégé-style annotation properties such as `rdfs:comment`, or your own) that are confirmed
  before they are saved and read-only afterwards.
- **Relations** – association, "is a" (generalization) or "has property"; label, cardinalities,
  description; several relations between the same two terms fan out.
- **Views** – graph, editable table, hierarchy tree, and model checks.
- **Model checks** – unnamed and duplicate terms, circular or redundant hierarchies, isolated
  terms, unlabelled or duplicate relations, malformed cardinalities, missing descriptions and more.
- **Arrange** – layered hierarchy layout or force-directed network layout.
- **Subgraph mode** – on the canvas, switch from Full graph to Subgraph to see only chosen terms
  and their neighbours: search or select the starting terms, set the depth and direction, pick
  which relationship types to follow, expand or fold single terms. It is a view with its own
  layout; the model is not changed by it.
- **Find path** – select two terms to spotlight the shortest path between them.
- **Bulk add** – two steps: terms with their metadata (`Name | Type | Description | Synonyms`,
  or spreadsheet rows with a header), then relationships (`Customer -> places -> Order`).
- **RDFS & OWL (optional)** – switch it on in the Vocabulary view to use standard properties
  (`rdfs:subClassOf`, `owl:equivalentClass`, `owl:sameAs`, …): pick one per relation, or map a
  relationship label to one so every relation with that label exports as it.
- **Reasoner** – in the Checks view: a built-in RDFS / OWL RL rule reasoner that reports
  contradictions and unsatisfiable classes, and lists what follows from the model (with the
  reason, and a button to state it explicitly).
- **SPARQL view** – write SELECT / ASK / CONSTRUCT / DESCRIBE queries against the model's RDF
  and see the results as a table (Oxigraph compiled to WebAssembly, loaded on first use).
- **RDF view** – the live model as Turtle, JSON-LD or a triples table.
- **Files** – save/open JSON; import Turtle / N-Triples (OWL, RDFS, SKOS); export OWL (Turtle),
  JSON-LD, CSV, SVG and PNG. Drag a file onto the window to open it.
- Whatever is in the editor is also kept as a working copy in the browser, so a reload loses nothing.

## Size

Tested with generated ontologies (File → Generate a stress-test model; `src/model/stress.ts`).
Up to about 2,000 terms and 5,000 relationships everything stays responsive. At about 4,000
terms the tables, checks, reasoner, RDF and SPARQL still work but the canvas becomes slow.
Long tables and result lists are shown a page at a time; the search box narrows them.
`BENCH_OUT=/tmp/bench.txt pnpm exec vitest run src/model/bench.test.ts` times the model layer.

## Layout of the code

- `src/model` – everything that isn't UI: types, the zustand store (state, history, autosave),
  layout algorithms, checks, RDF import/export, file handling.
- `src/components` – the SVG canvas, side panels, views and menus.

## Not there yet

RDF/XML and JSON-LD import, Excel/PowerPoint/PDF export, AI assistance, multiple saved models.
Colours, positions and cardinalities live only in the JSON format; the Turtle export carries the
terms, descriptions, synonyms and relations.

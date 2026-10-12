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
node e2e/sidebar-tree.mjs   # browser checks (also e2e/inferred-restrictions.mjs, e2e/instance-of.mjs, e2e/restrictions.mjs, e2e/governance.mjs); need `pnpm exec vite preview --port 5181` running
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
- **IRIs and labels are separate** – the entity editor has an *IRI suffix* field: the last part
  of the IRI can be anything (`C0001`, `Film_v2`) whatever the name (`rdfs:label`) is, and renaming
  never changes it. A suffix that is taken or cannot be part of an IRI is refused; shapes, kept
  class expressions and mapping records that mention the IRI follow the change.
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
- **Inferred restrictions** – a class also shows, read-only, the restrictions it inherits from
  the superclasses and equivalent classes the reasoner entails for it, each with its source.
- **Class restrictions** – a class lists what its object and data properties require of it,
  Protégé-style, and exports them as OWL restrictions.
- **Examples** – File menu: a small film ontology, a SKOS thesaurus, and a large university
  ontology (130 terms, 26 object properties, 195 relationships) for testing at scale.
- **Terms** – class, data property (with a domain and a datatype) or individual; description, synonyms, colour, and metadata fields
  (Protégé-style annotation properties such as `rdfs:comment`, or your own) that are confirmed
  before they are saved and read-only afterwards.
- **Relations** – association, "is a" (generalization), "Is Instance Of" or "has property"; label,
  description; several relations between the same two terms fan out. Cardinalities at the two
  ends are for plain relationships only: an object or data property says "how many" with
  restrictions, and "is a" and "Is Instance Of" do not say it at all.
- **Kinds follow what a line connects** – an individual and a class: *Is Instance Of* or plain;
  two classes: object property, *is a* or plain; a class and a data property: *has data property*
  or plain. Other kinds are not listed.
- **Governance & Metadata** – a tab under *Entities* lists every entity with its kind, lifecycle
  status, owner and whether its required metadata is complete; selecting one shows its metadata
  in collapsible groups (general, governance, technical, operational, data quality). The values
  are the entity's annotations, the same ones the side panel lists, stored with a standard
  property where one exists (Dublin Core, SKOS, DCAT, PROV-O, ADMS; quality scores as DQV
  measurements) and typed: dates as `xsd:date`, numbers as numbers, an owner chosen from the model
  as a reference to that entity. Which fields a kind of entity has comes from a registry
  (`src/model/governance.ts`), editable per model under *Configure fields*: add fields of your
  own, choose where each applies, mark fields required. A missing required field is reported
  under *Validation* as a governance rule that can be switched off; it is never an OWL axiom.
  An entity can be given the profile of a business or technical data asset (`dcterms:type`),
  which changes its fields, not what it is in the ontology.
- **Several restrictions on one relationship** – a relationship that uses an object property, or
  attaches a data property, can state more than one restriction (`directs some Film` and
  `directs max 3 Film`; `min 1` with `max 2`). *Add another restriction* in the relation panel,
  or add the same property and class again in the class editor. Each is exported as its own
  `owl:Restriction`, and they come back from RDF as one relationship.
- **Is Instance Of** – the class membership of an individual, exported as `rdf:type` (never as a
  predicate of its own). It is offered only between an individual and a class, always points
  from the individual to the class (drawn the other way, it is turned around), and is not
  stated twice. An individual can be an instance of any number of classes. Pick it as the kind
  of a relationship, type "is instance of" as the label of a new line, or add a type in the
  entity editor. **Inferred types** on the canvas also draws the memberships the reasoner
  works out, dotted and marked "(inferred)"; they are never stored or exported.
- **Views** – graph, editable table, hierarchy tree, and model checks.
- **Model checks** – unnamed and duplicate terms, circular or redundant hierarchies, isolated
  terms, unlabelled or duplicate relations, malformed cardinalities, missing descriptions and more.
- **Arrange** – layered hierarchy layout or force-directed network layout.
- **Subgraph mode** – on the canvas, switch from Full graph to Subgraph to see only chosen terms
  and their neighbours: search or select the starting terms, set the depth and direction, pick
  which relationship types to follow, expand or fold single terms. It is a view with its own
  layout; the model is not changed by it.
- **Class hierarchy sidebar** – the left sidebar is a collapsible tree of classes under
  `owl:Thing`, built from the stated superclasses (a class with two appears under both), with
  search by name or IRI and expand/collapse all. Data properties and individuals have their own tabs.
- **Entity editor** – the side panel edits whatever is selected, with the fields that its kind
  of entity has in OWL and no others:
  - *Class*: asserted superclasses (any number), equivalent and disjoint classes, restrictions,
    and the properties that name it as their domain. Anonymous class expressions from an import
    are listed apart from named classes and kept word for word.
  - *Object property*: domain, range, the seven characteristics, and any number of
    superproperties, inverses, equivalent and disjoint properties.
  - *Data property*: domain, datatype, functional, superproperties, equivalent and disjoint properties.
  - *Individual*: types, object property assertions, data property assertions (checked against
    the property's datatype), same and different individuals.
  - Every entity: its IRI in full, prefixed name and namespace, and annotations, several per
    property and each with its own language.

  Entities are chosen by searching names or IRIs. An edit that makes no sense is refused with
  the reason shown at the field. Only what is asserted can be edited; what the reasoner works
  out (superclasses, types, restrictions, properties from a superclass's domain) is in separate
  read-only sections and is never written into the model. The logic is in `src/model/axioms.ts`.
- **Find path** – select two terms to spotlight the shortest path between them.
- **Bulk add** – two steps: terms with their metadata (`Name | Type | Description | Synonyms`,
  or spreadsheet rows with a header), then relationships (`Customer -> places -> Order`).
- **RDFS & OWL (optional)** – switch it on in the Vocabulary view to use standard properties
  (`rdfs:subClassOf`, `owl:equivalentClass`, `owl:sameAs`, …): pick one per relation, or map a
  relationship label to one so every relation with that label exports as it.
- **Validation** – one tab for three kinds of check that answer different questions and are
  never mixed up. They run when asked; results say when and which revision of the model they
  are about, and are marked stale as soon as the model changes.
  - *OWL consistency*: the built-in RDFS / OWL RL rule reasoner. Reports whether the ontology
    contradicts itself and which classes can never have a member (not the same thing), each
    with the stated facts the reasoner derived it from. Also restrictions that cannot hold
    together, and property characteristics that exclude each other.
  - *SHACL*: the model's shapes validated against a data graph by a SHACL Core engine
    (`rdf-validate-shacl`, loaded on first use). Shapes are made in a form (SHACL shapes tab),
    imported from Turtle or written as Turtle, and saved with the model but apart from the
    ontology. The data graph is the model's own RDF (individuals and ontology triples) or an
    imported Turtle file. Results keep the standard report fields.
  - *Quality*: 27 modelling rules (missing definitions, redundant superclasses, naming, IRIs
    and namespaces, …), each of which can be switched off per model. They are suggestions,
    not errors.

  Results can be filtered by category, severity and entity type and searched; clicking one
  opens the entity. Some have a fix, which shows the change before making it. Reports export
  as JSON and RDF. What the reasoner infers is listed under "Inferred facts".
- **Align** – other ontologies, kept apart from yours, and three different things to do with one:
  - *Depend on it*: it becomes a dependency (`owl:imports`). Its axioms count when reasoning
    and validating, but are never written into your ontology.
  - *Reuse an entity*: refer to one of its classes or properties under its own IRI, as a
    superclass, domain, range or restriction filler. Only a declaration of it is exported.
  - *Copy entities*: bring chosen entities in with their definitions. The copies keep their
    IRIs and are yours to maintain from then on.

  An ontology is added from a Turtle file, a URL or a saved model, with a summary and any IRI
  collisions shown first. The library lists each with its IRI, version, namespace, source and
  use, and lets you browse and search it. Its content is cached in the browser.

  **Mappings** are ordinary axioms between one of your entities and an external one:
  `owl:equivalentClass`, `rdfs:subClassOf`, `owl:disjointWith`, `owl:equivalentProperty`,
  `rdfs:subPropertyOf`, `owl:inverseOf`, `owl:sameAs`, `owl:differentFrom`, and the SKOS
  mapping properties. They are made side by side, checked for kind and repeats, reasoned over
  together with imported ontologies, drawn on the canvas, and exported or imported as a file
  of their own. Status, comment, method and similarity are recorded beside each mapping, not
  in it. **Suggestions** are look-alikes found from labels, definitions and hierarchy, each
  with its reasons; nothing is asserted until you pick a relationship and accept.
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

## OWL constructs without an editor

Kept as text on the class and written back unchanged, but not editable piece by piece: unions,
intersections, complements, enumerations (`owl:oneOf`), `owl:hasValue`, `owl:hasSelf`,
unqualified cardinalities and nested restrictions, where they are stated as a superclass or an
equivalent class.

Read as the pairs they stand for: `owl:AllDisjointClasses`, `owl:AllDifferent`,
`owl:AllDisjointProperties` (named members only).

Not read at all, so lost on import: property chains, keys (`owl:hasKey`), negative property
assertions, `owl:disjointUnionOf`, datatype definitions and facets, annotations on axioms,
domains, ranges and hierarchies of annotation properties, `owl:imports` and the ontology's own
annotations other than its name and description, and a domain or range that is a class
expression other than a union of named classes. A value whose datatype is not one of the twelve
the app offers is kept as plain text.

## Validation: what is and is not covered

- The reasoner is a rule reasoner, not a complete OWL 2 DL reasoner: "consistent" means its
  rules found no contradiction. Class expressions kept as text are not interpreted.
- SHACL: all of SHACL Core is validated. SHACL-SPARQL, SHACL Advanced Features and entailment
  regimes are not. The shape form covers targets (class, node, subjects-of, objects-of), a
  property or its inverse as path, and the constraints min/max count, datatype, class, node
  kind, pattern, allowed values, min/max inclusive and exclusive, min/max length, one value
  per language, closed, severity and message. Anything else in Core (`sh:or`, `sh:and`,
  `sh:not`, `sh:xone`, qualified value shapes, property pairs, other paths) is written or
  imported as Turtle and validated the same.
- OWL restrictions are never turned into shapes, and reasoner-inferred types are not added to
  the data graph.
- Validation runs in the page, in steps, not in a background thread; a run cannot be cancelled.
  A full run takes about a second on 3,000 terms.
- Imported data used for SHACL is kept for the session only.

## Reuse and alignment: limits

- External ontologies are read from Turtle or N-Triples only. RDF/XML and JSON-LD are refused
  with a message; convert them first. A URL works only if its server allows requests from
  other sites (CORS) and serves Turtle.
- An external ontology's content is cached in this browser, not in the model file. On another
  machine the references and mappings are all there, and the library says the content is
  missing until the ontology is added again.
- Imports are not followed transitively: an imported ontology's own imports are not fetched.
- Opening a Turtle file, an entity outside the default namespace that is only declared is
  taken to be an external reference.
- Suggestions are lexical. The matcher is a list of functions (`src/model/matcher.ts`), so an
  embedding-based one can be added beside it.

## Not there yet

RDF/XML and JSON-LD import, Excel/PowerPoint/PDF export, AI assistance, multiple saved models.
Colours, positions and cardinalities live only in the JSON format; the Turtle export carries the
terms, descriptions, synonyms and relations.

# ConceptWeaver

A browser-based visual editor for knowledge graphs, glossaries and small ontologies, in the
spirit of [Termboard](https://termboard.com). Draw terms as boxes, connect them with labelled
relations, and export a standards-compliant model. Everything stays in the browser: no
account, no server.

All commands at a glance (see *Getting started* below for how to use them):

```bash
pnpm install
pnpm dev        # http://localhost:5180
pnpm test       # model-layer unit tests
pnpm lint       # oxlint (.oxlintrc.json); fails on any finding
pnpm build      # static site in dist/
pnpm verify     # every check: type-check, lint, unit tests, build, all browser checks, UI audit
pnpm bench      # the benchmarks, kept in bench-results/ (see docs/BASELINES.md)
pnpm corpus     # fetches the round-trip corpus (corpus/corpus.mjs) and the W3C SHACL Core tests (corpus/shacl.mjs) once; their tests then run with the unit tests
pnpm reasoner   # the OWL 2 DL reasoning service (HermiT) on http://localhost:5190; needs a JDK, 11 or later
node e2e/sidebar-tree.mjs [base URL]   # one browser check, against a running server (default http://localhost:5181/, from `pnpm exec vite preview --port 5181`)
node e2e/ui-audit.mjs [base URL]       # measures every view in both themes: text contrast, text size, pointer target size, overflow; fails if any is off
```

`pnpm verify` is what CI runs on every push (`.github/workflows/verify.yml`). It serves the build
on a free port of its own, so it does not disturb `pnpm dev`. The browser checks need Chromium's
headless shell (`pnpm exec playwright-core install chromium-headless-shell`); the ones that need
Java say SKIPPED without it, and run in CI, which has a JDK.

## Getting started

You need [Node.js](https://nodejs.org) 22 or later and [pnpm](https://pnpm.io). Install once:

```bash
pnpm install
```

**Start the app.** In a terminal in the project folder:

```bash
pnpm dev
```

Leave it running and open <http://localhost:5180> in your browser. That is all the app needs:
drawing, the entity editor, import and export, validation with the fast reasoner, SHACL and
SPARQL all work with this one command. Your work is kept in the browser, so closing the
terminal or restarting the machine loses nothing; start `pnpm dev` again and it is there.

**Start the advanced reasoner (optional).** Only if you want complete OWL 2 DL reasoning with
HermiT. It needs Java 11 or later, as a JDK (`java -version` and `javac -version` should both
answer). In a second terminal in the project folder:

```bash
pnpm reasoner
```

Leave this running too. The first start fetches the reasoner's libraries (about 90 MB, once)
and compiles the service; after that it starts in a couple of seconds and prints
`ConceptWeaver reasoning service: HermiT … on http://127.0.0.1:5190`.

Then, in the app:

1. Open **Validation**.
2. Under *OWL consistency*, choose **Advanced reasoner (OWL 2 DL)**. The line below the address
   should say "HermiT … is running".
3. Press **Run reasoning**. The card shows whether the ontology is consistent and which classes
   are unsatisfiable; **View explanation** opens the reasoner's justification.
4. After you edit the model the results are marked stale: press **Run reasoning** again.

So after a restart there are two commands, each in its own terminal: `pnpm dev` always, and
`pnpm reasoner` when you want the advanced reasoner.

If the app says the reasoning service did not answer:

- Check that the terminal running `pnpm reasoner` is still open and shows no error.
- Open <http://localhost:5190/health> in the same browser. A line starting with
  `{"service":"conceptweaver-reasoner"` means the service can be reached; an error page means
  the browser cannot reach it.
- In the Validation card, the *Reasoning service* address should be `http://localhost:5190`.
- If you open the app from an address other than `localhost` or `127.0.0.1`, start the service
  with `pnpm reasoner --allow-origin=<that address>`.

More on what the advanced reasoner does and does not cover is under
[OWL 2 DL reasoning](#owl-2-dl-reasoning-hermit) below.

## What it does

- **Opening an existing ontology** – *File → Open a file…*, a file dropped on the window, or
  *File → Open from a URL…* puts an ontology in the editor, in whichever syntax it is written:

  | Syntax | Usual files | Read by |
  | --- | --- | --- |
  | RDF/XML | `.owl`, `.rdf`, `.xml` (what Protégé saves by default) | the app, in the browser |
  | Turtle, N-Triples, N-Quads, TriG | `.ttl`, `.nt`, `.nq`, `.trig`, `.n3` | the app, in the browser |
  | JSON-LD | `.jsonld` | the app, in the browser |
  | OWL/XML, functional syntax, Manchester syntax, OBO | `.owx`, `.ofn`, `.omn`, `.obo`, and `.owl` files saved in one of them | the local OWL service (`pnpm reasoner`), which has the OWL API |

  The syntax is told from how the file starts, not from its name. Everything is read into the
  same model the same way: classes, object and data properties, individuals, the hierarchy,
  restrictions, memberships and values become what the editor shows; a class expression there
  is no drawing for is an axiom of its class, edited as one; labels in other languages and other annotations are
  kept as annotations; the file's prefixes stay its prefixes; what it imports is recorded by its
  IRI and not fetched. A file in an encoding other than UTF-8 is read in the one it declares.
  What cannot be read is refused in a message that stays on screen and says why: a file that is
  not well-formed, one that was cut short (it is not opened as a smaller ontology), a JSON-LD
  file that takes its context from elsewhere, or a syntax that needs the OWL service when none
  is running, with how to start it and what to save the ontology as instead. The same reader is
  behind adding an ontology under *Align* and importing data for SHACL. See *Reading
  ontologies: what is and is not covered*.
- **Two types of model** – an **OWL ontology** or a **SKOS-like vocabulary** (taxonomy, controlled
  vocabulary, glossary). *File → New model…* asks which, with a name and a namespace; the type
  stays with the model through saving and reopening, and changes only by an explicit, confirmed
  conversion (broader ↔ is-a, exactMatch ↔ equivalentClass, …). Either form can be exported
  without converting.
  - An ontology has every function.
  - A vocabulary has *Graph*, *Entities* and *Structure*. Its entities are concepts
    (`skos:Concept`), managed by name, IRI, IRI suffix and type; their labels, definitions, notes
    and ownership are under *Governance & Metadata*. A relationship is plain or "is a", which
    builds the hierarchy and is written `skos:broader`. There is no reasoning, no restrictions and
    no validation, and the store refuses them as well as the menus hiding them.
  - What each type has is said in one place, `src/model/modelTypes.ts`: its views, the sections
    and columns of *Entities*, the kinds of term and of relationship, the parts of the entity
    editor, what the hierarchy means, and its features. The navigation, the editors and the store
    read it from there; a further type of model is a further entry.

- **Canvas** – double-click to add a term, drag a term's ⊕ handle onto another term to relate
  them (or onto empty space to create the other term), right-click anything for its menu.
  Pan by dragging, zoom with the wheel, Ctrl+drag to box-select. Full undo/redo.
- **The ends of a line** – a selected relationship shows a handle at each end. Dragged along
  its term, an end moves where the line meets the term: any side, anywhere along it. That is
  how the graph is drawn and nothing the ontology says: it is kept with the graph style, never
  written to RDF, stays on the term when the term moves or changes size, and holds under every
  layout. Dragged onto another term, an end *reconnects* the relationship, which is an edit: the
  terms that can take it are outlined and the others fade, the reason a term cannot is said
  beside the pointer, and the relationship is never made another kind to fit where it was
  dropped. Esc, or letting go anywhere else, puts it back; one undo takes a reconnection back.
  *Reset connection points* (in the relationship's menu and panel; a double-click on a handle
  for one end) gives the ends back to the layout. The panel has the same as a side and a
  slider, for whoever would rather not drag. See *The ends of a line: what moves, and what is
  refused*.
- **My Models** – save models in this browser (IndexedDB) and reopen them later: Save, Save as,
  and a list to open, rename, duplicate and delete. The header shows whether the model in the
  editor has unsaved changes. Browser storage is local and can be cleared, so export files too.
- **Versions** (since 2026-10-16; `src/projects/`) – *File → Versions…*: named versions of a model
  in My Models, kept in this browser. A version is saved with a name and a line about it, and
  keeps the whole model: the ontology, its shape sets, the data graphs it names, the drawing.
  Versions are listed newest first. Any two, or one and the model now, are compared over what each
  states, axiom by axiom, and the difference is told entity by entity: the axioms added and
  removed under each, in Manchester syntax, each entity a link to its editor; then the shape sets'
  statements, the data graphs, and the settings that are no part of the ontology. Moving terms
  on the canvas is no change to the ontology, and is said to be only the drawing. *Restore…* makes
  the model what a version was, as one edit that undo takes back, and saves that as a new version:
  no version is ever taken away. Deleting a model from My Models deletes its versions.
- **Ontology settings** – File → Ontology settings: the ontology IRI, the default namespace new
  IRIs are made in, and namespace prefixes. Prefixes only change how an IRI is written (`ex:Actor`
  in tables, Turtle, SPARQL and search); they are kept on import and written on export.
- **IRIs and labels are separate** – the entity editor has an *IRI suffix* field: the last part
  of the IRI can be anything (`C0001`, `Film_v2`) whatever the name (`rdfs:label`) is, and renaming
  never changes it. A suffix that is taken or cannot be part of an IRI is refused; shapes, class
  expressions and mapping records that mention the IRI follow the change.
- **IRIs** – every entity has a full IRI, made once in the model's base namespace when it is first
  named (or kept from an import) and unchanged by renaming. Shown read-only with a copy button.
- **Asserted superclasses** – a class lists every superclass explicitly stated for it (not the
  inferred ones) and they can be added and removed one at a time. A superclass that is an
  expression is a class axiom (see *Class expressions*).
- **Entities view** – classes, object properties, data properties and individuals each in their
  own tab, with the side panel as the editor, in the manner of Protégé.
  Under the tabs each of the five lists (classes, object properties, data properties,
  individuals, relationships) has a bar of its own:
  - **Search** – as it is typed, by name, other labels (synonyms, and annotations that are names:
    `rdfs:label`, `skos:prefLabel`, `skos:altLabel`, `skos:hiddenLabel`, `skos:notation`,
    `dcterms:title`), the IRI with a prefix or in full, and the definition; a relationship by its
    name, its two ends and its kind. Part of a word is enough, case does not matter, and every word
    has to be found, each wherever it is. A word is looked for in the full IRI only when it is
    written like part of one (with `:`, `/`, `#` or `.`), so that "org" finds Organisation and not
    everything under example.org. What was found is marked in the row; where the row has no place
    for it (a label in another language, the full IRI) it is shown under the name. The bar says
    how many match of how many; × or Esc clears. Each tab keeps its own search.
  - **Sort** – by clicking a column heading (once, again for the other way, a third time for the
    model's own order) or with the selector, which also has what there is no column for: name,
    IRI, number of asserted superclasses, subclasses and restrictions, number of relationships,
    datatype, asserted classes of an individual, either end and kind of a relationship. The sort
    is stable, and the selected row stays selected and in sight.
  - **Filters** – a panel that folds away, with what fits the list. Classes: root, leaf, multiple
    inheritance, asserted restrictions, inferred restrictions, unsatisfiable. Object properties:
    domain or range set or not, each characteristic, having an inverse. Data properties: domain
    or range set or not, functional, datatype. Individuals: asserted class, and inferred class
    (every individual a reasoner entails to be an instance). Relationships: kind, where it starts,
    where it ends. Filters combine with each other and with the search and the order; the ones
    that are on are listed under the bar, each with its own ×, beside *Clear all filters*. What
    rests on a reasoner says which one, takes in the OWL 2 DL result when there is a current one,
    and is not applied while the ontology is inconsistent, which it also says.

  Search, order and filters are each put back on their own, are kept per tab while the app is
  open, and start afresh with another model. None of it is part of the model or changes it. An
  entity added while a list is narrowed is listed all the same, marked as just added; so is one
  opened from the Structure Explorer. The sidebar's search box narrows the sidebar and the
  Governance tab, no longer these five tables.
  *Add relationship* in its table of relationships starts one between the terms that are
  selected, or else from the first term by name to the first it can be related to and is not
  related to yet; its ends and its name are then set in its row, which is selected and brought
  into view. In an ontology not every two terms can be related (an individual has a value for a
  data property, not a line to it), so the first two by name will not always do.
- **Object properties** – declared with domain, range, characteristics, inverse and parent. A
  relationship whose name is that of one is a use of it: between two classes it is a
  restriction on the class (`some`, `only`, `min`/`max`/`exactly` N), between individuals a fact.
  In an ontology, naming a line between two classes or two individuals is enough: the property
  of that name is used, and declared on the spot if it is new.
- **Class expressions** (model format 4, from 2026-10-14). A class's superclasses, definitions and
  disjoint classes that are expressions are axioms of the class, each of one kind, chosen when
  it is made and never assumed: *SubClass Of* (every member is in the expression), *Equivalent
  To* (being in it is enough to be a member, and a reasoner classifies by it) and *Disjoint With*.
  Several of a kind are several axioms, never merged into one union or intersection. They are
  listed under *Class expressions* in the class's editor, each in Manchester syntax, and made and
  changed in the expression editor, a dialog with two ways of editing one expression:
  - *Blocks*: the expression as nested blocks, each an AND, OR, NOT, a class, a restriction
    (SOME, ONLY, VALUE, MIN, MAX, EXACTLY, SELF, on a property or its inverse), a list of
    individuals, or for a data property a datatype, one narrowed by facets, an enumerated
    datatype, a list of values. Classes, properties, individuals and datatypes are chosen with
    the searchable pickers of the rest of the editor. A block's operator can be changed without
    losing what it holds (SOME to ONLY keeps the property and filler, AND to OR the operands, and
    back again), a block can be put into an AND, an OR or a NOT, unwrapped, folded away to its
    text, or removed. What a block may hold follows from where it is: the filler of a data
    property is a data range, and a class is not offered there. What is still to be chosen is
    said at its block, and the Manchester syntax of the whole is shown beneath.
  - *Manchester syntax*: a text editor (CodeMirror, loaded when first opened) that highlights
    classes, properties, individuals, datatypes and keywords each as what they are, suggests
    the names and keywords that fit where the cursor is (Ctrl+Space), closes and matches
    brackets, lays a long expression out over lines (*Format*), and marks at its place what does
    not read: a syntax error, a name that is nothing in the ontology, a name of the wrong kind
    (“xsd:integer” is a datatype; hasChild is an object property, whose values are individuals of
    a class), or a name two entities share, properties as well as classes (FOAF has two object
    properties called “account”: write the one meant by its prefixed name). Prefixed names and
    full IRIs are read too.
  - *In words*: under either, the expression read out as a sentence of the kind of axiom it is,
    for whoever does not read Manchester syntax: `Person and (hasChild some Student)` as Equivalent
    To of Parent is "Something is a “Parent” exactly when it is a “Person” and is related by
    “hasChild” to at least one “Student”". Each axiom listed in the class's editor has its sentence
    under it, as do a property's domain and range axioms ("Anything that is related by “hasChild”
    to something is a “Person”."). The wording is the same whatever a property is called, and says
    what OWL means: *some* is at least one, *only* allows none at all ("only to members of
    “Student” (or to nothing)"), a number counts different things, and a negated restriction is
    said the way round that reads (`not (hasChild only Student)` is "related by “hasChild” to at
    least one thing that is not a “Student”"). Where a long part of an *and* or *or* comes before
    another, a semicolon sets it apart (`src/model/inWords.ts`).

  Both edit one structured expression (`src/model/expressions.ts`), so switching between them
  changes how it is shown and never what it says; a text that does not read yet is not turned
  into blocks until it does. An expression is saved only when it is finished and OWL 2 DL allows
  it (an object property used as a data property, a datatype where a class has to be, a facet a
  datatype does not have and a literal not of its datatype are refused; a class the model has
  only as an individual is warned about, since OWL allows the two to share an IRI). Whether it
  can have members at all is the reasoner's to say: HermiT gets every axiom, finds a class that
  can have none, and classifies by a definition. What is read is the W3C Manchester syntax for
  class expressions and data ranges (`src/model/manchester.ts`); `src/model/expressionConformance.test.ts`
  has the OWL API's own Manchester parser read the same texts, and they agree but for one thing
  where the OWL API departs from the grammar (it types the 4 of `xsd:string[length 4]` as a
  string). Frames (`Class: … SubClassOf: …`), annotations and property chains are not
  expressions and are not read there. An expression with something in it OWL has no class
  expression for (a restriction with two quantifiers, an empty list) is kept as it was read,
  shown, written back, and can be removed but not changed. What the editor does not do yet is
  listed in [docs/EXPRESSION_EDITOR_LIMITATIONS.md](docs/EXPRESSION_EDITOR_LIMITATIONS.md).

  A class with something it is equivalent to (an Equivalent To expression, another class drawn
  as the same class, or an enumeration with members) is a **defined class**, as Protégé calls
  it: being what it is equivalent to is enough to be one, and a reasoner classifies by it. The
  class tree marks it ≡, its editor is headed *Defined class*, and its *Class definition* says
  what defines it. Tested against the corpus: each of Pizza's definitions typed again in the
  editor, as Manchester syntax and then as blocks, is the same expression, and HermiT finds each
  equivalent to Protégé's, with the same subclasses (`expressionConformance.test.ts`); every
  class expression of the nine ontologies opens as structure, reads back the same from its text
  and its blocks, and survives renaming and describing its class (`corpusExpressions.test.ts`).
- **Domains and ranges are axioms** (model format 3, from 2026-10-14; `src/model/expressions.ts`).
  Each `rdfs:domain` or `rdfs:range` statement is one axiom, with a class expression of its own
  (for a data property's range, a data range): a class, or a union, intersection or complement of
  expressions, a list of individuals, a restriction; a datatype, one narrowed by facets
  (`xsd:integer[>= 0]`), a union of datatypes, a list of literals. Several axioms all hold, so two
  domains mean "both" (their intersection); "either" is one axiom that is a union. They are read
  each as it is stated, never merged, and written back the same: PROV-O's `prov:hadActivity`, with
  the domain `prov:Influence` and a union of four classes, keeps both. The property editor lists
  the axioms one by one, joined by *and*, each to be changed or taken away on its own and new ones
  added in the expression editor (as blocks, or in Manchester syntax as Protégé shows them:
  `Person or Organisation`, `'took part in' some Event`, names in quotes where they have spaces).
  A data property's datatype is still chosen in its list; any other range axiom is listed under
  it. An expression with something in it the editor has no structure for is shown as it was read
  and written back so, and can be taken away but not changed. A
  domain or range that nobody stated follows the uses, as it always did. Validation holds a use
  between classes to every axiom (a union is met by any of its classes, an intersection by all),
  and the rule reasoner infers each class an axiom is, or is an intersection of. Deleting a class
  takes it out of the unions and intersections that name it, and an axiom that is nothing else
  goes; giving it another IRI, the axioms follow.
- **Inferred restrictions** – a class also shows, read-only, the restrictions it inherits from
  the superclasses and equivalent classes the reasoner entails for it, each with its source.
- **Class restrictions** – a class lists what its object and data properties require of it,
  Protégé-style, and exports them as OWL restrictions.
- **Examples** – File menu: a small film ontology, a SKOS thesaurus, and a large university
  ontology (130 terms, 26 object properties, 195 relationships) for testing at scale.
- **Terms** – class, data property (with a domain and a datatype) or individual; description, synonyms, colour, and metadata fields
  (Protégé-style annotation properties such as `rdfs:comment`, or your own) that are confirmed
  before they are saved and read-only afterwards.
- **Relations** – several relations between the same two terms fan out; each has a
  description. Cardinalities at the two ends are for plain relationships only: an object or
  data property says "how many" with restrictions, and "is a" and "Is Instance Of" do not say
  it at all.
- **In an ontology, what a line is follows from what it joins and what it is called** – nobody
  has to choose a kind, and there are no plain relationships: every line says something OWL has
  a meaning for.
  - *Two classes*: called `is a` (in any capitals; `is an` too), the first is a subclass of the
    second (`rdfs:subClassOf`). Called anything else, it is a use of the object property of
    that name, which restricts the first class (`owl:Restriction`); a name that is new makes a
    new object property. Rename the line and it becomes the other thing; a property that
    existed for that one line alone, with nothing said about it, goes with its old name.
  - *A class and a data property*: the class has the data property, whichever way the line was
    drawn. It is written as the restriction and the domain it always was, never as a predicate
    of the app's own.
  - *An individual and a class*: the individual is an instance of the class (`rdf:type`).
  - *Two individuals*: a fact that uses the object property of that name.
  - *Two data properties*: the first is a sub-property of the second.
  - *An individual and a data property*: no line. What an individual has for a data property
    is a value, given under *Data property assertions* in its editor; drawing the line is
    refused, with that explanation.

  The same holds wherever a relationship is made or changed: on the canvas, in the editor, in
  the relationships table, in *Bulk add*, and in the model itself (`src/model/relating.ts`).
  A relationship that stands for a standard property (`owl:disjointWith` and the like) is left
  as it is. A plain relationship that a model has from before (an older file, a Turtle file
  with a predicate nobody declared, a vocabulary turned into an ontology) is kept and shown as
  what it is, with the ontology's kinds to choose from; it is not turned into something else
  behind your back.
- **An object property is known by an id of its own, not by its name** (model format 2, from
  2026-10-14; `src/model/identity.ts`). A line that uses a property names it, and shows its name.
  Rename the property and the lines that use it follow, and nothing else: two properties may
  have one name (FOAF has two called "account"; two ontologies may each have a `hasPart`), and
  each keeps its own uses, its own IRI and its own links to other properties. A name typed on a
  line still chooses the property of that name, the model's own before one of another ontology;
  two of the model's own cannot be given one name, which would only invite mistakes.
- **A model saved before** (format 1, which knew a property by its name in lower case; format
  2, whose domains and ranges were lists of classes; format 3, which kept class expressions as
  Turtle text; format 4, whose shapes were one list, each a form for part of SHACL with the rest
  as Turtle) opens as it was: the same ontology, the same relationships, the same properties
  and the same picture. What a list meant is what those formats wrote: one class is that class,
  several are their union in one axiom (it was always written so), an empty list no domain, and
  none at all one that follows the uses; a data property's datatype is one axiom, and a range
  kept as text the axiom it states; a superclass or definition kept as text is the class axiom
  of that kind it states. Format 4's shapes are one shape set, called "Shapes", whose Turtle is
  the same statements and whose findings are the same. `src/model/migration.test.ts` checks
  that on three models saved in format 1, one in format 2, one in format 3 and one in format 4
  (their Turtle byte for byte for formats 1 and 2, statement for statement for 3 and 4). It is
  saved in format 5 from then on, which a version of the app from before cannot read in full.
- **Every entity has an IRI from the moment it exists**: one made from its name or, while it has
  none (a new class is "New class"), one that stands in, in the default namespace. The first real
  name replaces that one, once, and whatever referred to it follows; after that a rename never
  changes an IRI.
- **In a SKOS-like vocabulary** a relationship is plain or "is a (broader)", as before.
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
- **Graph style** – the *Style* button on the canvas opens an editor for how the graph is drawn:
  shape, fill, border, size, label and opacity of nodes; colour, thickness, line, arrowhead,
  curvature and label of edges. A style is set for a kind (class, individual, datatype property;
  "is a", Is Instance Of, restriction, plain relationship and the other kinds of line) or for the
  selected terms and relationships, which then override their kind. Themes (Standard,
  Professional, Minimal, High contrast, Colorful) set every kind at once, and a style can be
  saved under a name to use in other models. The style is kept with the model like the positions
  of its terms, never in the RDF, and reasoning and validation do not see it
  (`src/model/graphStyle.ts`).
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
  entity editor.
- **Inferred facts, on the canvas** – the *Inferred facts* button in the bar at the top of the
  graph (beside *Style*) also draws what the reasoner works out, dotted and marked
  "(inferred)": class memberships, and relationships between individuals
  that follow from what an object property is (its inverse, symmetric, transitive, a
  sub-property, an equivalent property). Each is drawn once and never when it is stated. They
  come from the fast reasoner and, when it is the one chosen and was asked about the model as
  it is now, from the OWL 2 DL reasoner; an individual's editor lists them under *Inferred
  relationships*, each with what it rests on. They are never stored, and an export has them
  only when asked. The button shows how many are drawn and stays as it was left; *Show
  inferred facts in the graph*, above the list under Validation → Inferred facts, switches it
  on and goes to the graph.
- **Views** – graph, editable table, structure explorer, and model checks.
- **Structure** – the hierarchy to look through, where the sidebar is for getting to an entity
  and *Entities* for editing one. It reads the ontology and changes nothing in it.
  - *Explore* shows one of two hierarchies. **Asserted**: every class under each superclass
    stated for it (`rdfs:subClassOf`; in a vocabulary, every concept under its broader concepts)
    and nothing else. **Inferred**: what the reasoner chosen under Validation entails, each class
    under the classes *directly* above it. Classes entailed to be equivalent share one place
    (that includes classes that are each other's superclasses), and a class that can have no
    instance is under `owl:Nothing` and nowhere else. A place that is entailed and nowhere stated
    is marked *inferred*; the mark can be switched off.
  - The inferred hierarchy always says which reasoner it is from, whether that reasoner's answer
    may be incomplete (the fast reasoner's always may; HermiT's when it left something out, which
    *why* spells out), and that it is of the ontology as it is now. The fast reasoner is asked
    when the explorer is open, in a worker, and the hierarchy is there once it has answered (until
    then the view says it is working). HermiT answers when it is run, and its answer is withdrawn as soon as the ontology
    changes: then, or when it gave none, or when the ontology is inconsistent, there is no inferred
    hierarchy and the view says why. The asserted hierarchy is never shown in its place, and one
    reasoner's answer is never filled in with the other's.
  - Only named classes are in either hierarchy: an individual is not under its class, a data
    property is not under the class that has it, and a superclass that is an anonymous class
    expression is not a class above anything (the class in focus says how many of those it has).
    A class with several superclasses is one class in several places, says how many, and each
    place opens by itself. In the asserted hierarchy, stated equivalence is shown on the class
    without merging it with the other, and classes that are each other's superclasses are marked
    as a cycle and followed once.
  - Choosing a class brings it into focus without selecting it, so no editor opens. Beside the
    hierarchy is what there is to say of its structure: its asserted superclasses, and apart
    from them the direct ones the reasoner entails; equivalent classes; how many subclasses it
    has directly and in all; how many levels it is below `owl:Thing`, as a range where it is
    reached by ways of different length; whether it has one superclass or several; and each way
    down to it, which can be pressed to see that place. Its superclasses by every way up are
    marked in the hierarchy, and so is what is on show below it. *Open in Entities* and *View in
    Graph* lead to where it is edited and drawn, and a class chosen in the sidebar or on the
    canvas is the one in focus there.
  - The search narrows the hierarchy by name, other labels and IRI (in full or with a prefix).
    Branches are fetched as they are opened, long lists come a page at a time, and only the
    lines in view are drawn. The hierarchy is one stop for the Tab key: the arrow keys move
    through it, open and fold branches, and Home and End go to its ends.
  - *Compare* sets two classes side by side. They are chosen by search, from the class in focus
    (*Compare…* beside it in Explore), or, with one chosen, from its superclasses; *Swap*
    exchanges them. It says how the two stand to each other (one a subclass of the other,
    equivalent, siblings, or neither, with the nearest classes above both) and whether they can
    share an instance, each with how it is known: stated outright, through stated links (which
    are listed), or entailed according to the reasoner in use. Then every restriction and kept
    class expression of either: *Own* where the class asserts it, *Inherited* where a class
    above it (or equivalent to it) does, with that class named and marked where only the
    reasoner puts it above, and the counts of what the two share and what each has alone. Their
    superclasses are set side by side in the same way. What a line names opens in the side panel.
  - One restriction is called *stronger than* another only on evidence: the two are on the same
    property, the numbers allow it, and the filler of the one is a subclass of the filler of the
    other, which is shown with how it is known. `hasLocalProfile some OrganisationLocalProfile`
    is stronger than `hasLocalProfile some PartyLocalProfile` because, and only while,
    OrganisationLocalProfile is a subclass of PartyLocalProfile. Two restrictions that merely
    read alike are two restrictions. Where the reasoner chosen has no answer, the comparison says
    that only what is stated was read, and marks what could not be checked *unverified* rather
    than deciding it either way.
  - *View semantic explanation* gives the asserted axioms a subclass relationship follows from:
    the stated links of a chain, or, for what only the fast reasoner entails, the grounds that
    reasoner gives. For what only HermiT entails there is none to give, and that is what it says.
  - Not compared: restrictions on different properties, even where one is a sub-property of the
    other; datatypes with each other; and what a kept class expression means, which is compared
    as text. A property that merely has a class as its domain is not listed as a restriction of it.
  - *Analyze* sums the hierarchy up in numbers, for the asserted or the inferred one: how many
    classes, how many at the top and how many leaves, the deepest level and the average depth
    (the mean of each class's deepest level; `owl:Thing` is level 0, and classes that are each
    other's superclasses count as one level), how many classes have several superclasses, how
    many have no stated superclass, the groups of equivalent classes, the classes in cycles, and
    the unsatisfiable classes. That last number is a reasoner's, says whose it is, and is "not
    known" rather than 0 when the reasoner chosen has no answer.
  - Four charts show how the classes are spread: over the levels, by how many direct subclasses
    they have, over the branches under each class at the top, and by how many direct superclasses
    they have. *Structural findings* lists what stands out: cycles, superclasses that are stated
    and also follow from another stated one, classes with several superclasses, and classes with
    unusually many direct subclasses, unusually deep leaves, or unusually many statements about
    them. "Unusually" is judged against the ontology itself (far beyond its upper quartile), and
    none of it is called an error: only an unsatisfiable class is a reasoner's finding. A stated
    superclass that a reasoner merely does not put directly above the class is not counted as
    redundant, since the reasoner may have needed it to find the class in between.
  - Every number, bar and finding lists the classes behind it, a page at a time; a class in the
    list opens in Explore, *View in Graph* draws the listed classes as a subgraph on the canvas,
    and *Open Validation* goes to what Validation found under the same rule. The measuring runs
    in short stretches so the page stays usable, shows how far it has got with a *Cancel* beside
    it when it takes long, and is kept for the revision it was made for.
  - Not done: the fast reasoner is asked about this ontology alone, without the ontologies it
    imports (HermiT is sent them, as under Validation). A class entailed to be equivalent to
    `owl:Thing` is not marked as such.
- **Shapes** (model format 5, from 2026-10-16; `src/model/shacl.ts`, `src/components/Shapes.tsx`)
  – SHACL shapes, as a constraint model of their own beside the ontology: what the data of one
  application or source has to be like, where the ontology says what holds of the world.
  - Shapes are kept in **shape sets**, each with a name, what it is for and the namespace of its
    new shapes. Two sets may have a different shape for one class. A set imports Turtle (a shape
    with the IRI of one it has is replaced, and keeps its place) and exports as a file of its
    own; exporting the ontology leaves the shapes out. Deleting a set, like every edit of a shape, is
    one step to undo.
  - A shape is a form of what is said of it, and every construct of SHACL 1.0 Core has a place
    in it: targets, node and property shapes, every kind of property path (typed as SPARQL writes
    it, `:a / ^:b | :c*`, and kept as the SHACL path it is), value type, cardinality, value
    range, string, property pair and other constraints, `sh:and`, `sh:or`, `sh:xone`, `sh:not`,
    `sh:node` and qualified value shapes, with a shape given in place or a named one from any
    set, and the non-validating `sh:name`, `sh:description`, `sh:order`, `sh:group` and
    `sh:defaultValue`. What is about no shape (a property group, data) and what is not Core
    (`sh:sparql`) is kept as Turtle, as written, and can be edited as such.
  - Nothing is lost on the way through: each shapes graph of the W3C SHACL Core test suite is
    read into the form and written back statement for statement (`src/model/shacl.test.ts`;
    `pnpm corpus` fetches the suite).
  - The editor of a class, data property or object property lists the shapes about it in every
    set, each opening where it is, and *Add a shape for this class* starts one in the set open.
  - OWL restrictions never become shapes by themselves, nor shapes restrictions: the ontology
    and the shapes are kept apart (ADR-020). What the ontology states can be **proposed** as
    shapes (since 2026-10-16, roadmap stage SH-3; `src/model/proposals.ts`,
    `src/components/Proposals.tsx`): *Propose from the ontology…* in the Shapes view, or *Propose
    from its axioms…* in a class's editor, for the whole ontology, a class or a few. Proposals
    come from restrictions (some, only, min, max, exactly, value; also inside an intersection or
    a definition), domains and ranges, functional and inverse functional properties, datatypes,
    enumerated datatypes and facets, and enumerations (`owl:oneOf`), read from the ontology as it
    is written, so restrictions drawn on the canvas and class axioms alike. Each shows its axiom,
    the shape it would add, what the axiom means in OWL (it concludes what is not stated, and
    does not take different names for different things), what the shape would check in the data,
    and where the two differ. None is chosen to begin with; they are chosen or dismissed one by
    one or by kind, and added to a chosen set, or a new one, as one step that undo takes back. An
    accepted shape says which axiom it came from (`cw:fromAxiom`, in OWL functional syntax, kept
    in its Turtle), and is marked stale once the ontology no longer states it; it can then be
    kept as a shape of its own. Keys (which SHACL Core cannot check), `Self` restrictions, and
    fillers that are nested class expressions are listed as not proposed, each with why.
- **Model checks** – unnamed and duplicate terms, circular or redundant hierarchies, isolated
  terms, unlabelled or duplicate relations, malformed cardinalities, missing descriptions and more.
- **Graph layouts** – a *Graph layout* selector in the bar above the graph (and the *Arrange*
  menu) arranges what the canvas shows, the full graph or a subgraph, in one of seven ways:
  *Hierarchical* (layers, the general above the specific), *Layered (Dagre)* (layers chosen to
  keep lines short and straight), *Orthogonal* (a tree with each term over what is under it and
  lines at right angles), *Radial tree* (rings around a root: the selected term, one chosen in the
  options or by right-clicking a term, or else the middle of the graph), *Circular*,
  *Force-directed network*, and *Manual* (nothing is rearranged). *Layout options* has what the
  chosen layout can be told: direction (top to bottom, bottom to top, left to right, right to
  left), node spacing, layer or ring spacing, repulsion, the root, and how lines run (straight,
  curved or with right angles, whatever the layout). *Rearrange* runs the layout again; after
  every layout the view is fitted to the graph, and up to a few hundred terms glide to their new
  places. Terms can be dragged under any layout. The arrangement made by hand is remembered when
  another layout is chosen and comes back with *Manual*; *Save positions* and *Restore saved
  positions* do the same on request, and *Keep this as manual* takes over what a layout made.
  A layout moves terms and nothing else: it is given boxes and lines and answers with places, so
  no statement of the model can change, and the Turtle is the same before and after. The layout
  and its settings are kept in the JSON file beside the graph style, never in RDF; a subgraph has
  a layout of its own, which like the subgraph is not saved. An expensive layout (the network
  layout above 400 terms, Dagre on all but small graphs) is worked out in a worker and can be
  cancelled; the page stays usable meanwhile. See *Graph layouts: what the canvas can and cannot do*.
- **Subgraph mode** – on the canvas, switch from Full graph to Subgraph to see only chosen terms
  and their neighbours: search or select the starting terms, set the depth and direction, pick
  which relationship types to follow, expand or fold single terms. It is a view with its own
  layout; the model is not changed by it.
- **Class hierarchy sidebar** – the left sidebar is a collapsible tree of classes under
  `owl:Thing`, built from the stated superclasses (a class with two appears under both), with
  search by name or IRI and expand/collapse all. Data properties and individuals have their own tabs.
  The sidebar is as wide as you make it: drag its edge (or, with the edge focused, use the
  arrow keys), and double-click the edge to fit it to the longest name. The button beside the
  search folds the whole sidebar away to a strip, and the strip opens it again as it was. Either
  way the graph stays where it is on the screen, and both are remembered in the browser.
- **Entity editor** – the side panel edits whatever is selected, with the fields that its kind
  of entity has in OWL and no others:
  - *Class*: asserted superclasses (any number), equivalent and disjoint classes, restrictions,
    and the properties that name it as their domain. Anonymous class expressions from an import
    are listed apart from named classes and kept word for word.
  - *Object property*: domain and range, each as its axioms (see *Domains and ranges are
    axioms*), the seven characteristics, and any number of superproperties, inverses,
    equivalent and disjoint properties.
  - *Data property*: domain as its axioms, datatype and further range axioms, functional,
    superproperties, equivalent and disjoint properties.
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
- **Import a table** (since 2026-10-16; `src/mapping/`, `src/import/`, `ImportTable.tsx`) – *File →
  Import a table…*: a CSV, TSV or Excel (.xlsx) file, read in the encoding, with the separator,
  sheet and header row chosen (each found in the file to begin with). Each row becomes a class
  (in a vocabulary, a concept) or an individual of a class. Its IRI is made by a template over its
  columns (`http://example.org/f#{Code}`, or `{Title:name}` for a value made into a name the way
  the editor makes IRIs), and each column is given a use: the name, a superclass or broader
  concept, the class of an individual, a description or synonyms (in a language), an annotation
  (`skos:notation`, `rdfs:seeAlso`, …), a value of a data property (converted: "yes" is true,
  "1,234.5" is 1234.5, a date is a date), or a link by an object property (between individuals a
  fact, between classes a restriction). A column is guessed a use from what it is called. What
  a row refers to (a parent, a class, a link) is looked for among the rows, by the column chosen
  as their key, then by name, then among the model's entities. Before anything is made, the
  preview says what each row becomes: made, in the model already (and left as it is), or
  skipped, with why (its IRI cannot be made, another row has it, what it is under is neither a
  row nor in the model, or is a row that is skipped), and which values of a row that is made are
  left out, and why; for classes, the hierarchy they will be. The import is one edit, which one
  undo takes back. A mapping can be kept as a template, by name, for the next file laid out the
  same way. 20,000 rows are planned in well under a second.
- **RDFS & OWL (optional)** – switch it on in the Vocabulary view to use standard properties
  (`rdfs:subClassOf`, `owl:equivalentClass`, `owl:sameAs`, …): pick one per relation, or map a
  relationship label to one so every relation with that label exports as it.
- **Validation** – one tab for three kinds of check that answer different questions and are
  never mixed up. They run when asked; results say when and which revision of the model they
  are about, and are marked stale as soon as the model changes.
  - *OWL consistency*: answered by one of two reasoners, chosen in the card (**Reasoning
    engine**), which always says which one answered.
    The **fast reasoner** is the built-in RDFS / OWL RL rule reasoner: in the browser, in a
    worker, in a fraction of a second, and incomplete. It reports the contradictions and unsatisfiable classes its rules reach,
    each with the stated facts it derived them from; when it finds none it says "No
    contradiction found", which is not a proof of consistency.
    The **advanced reasoner** is HermiT, a complete OWL 2 DL reasoner, run by a service beside
    the app (see *OWL 2 DL reasoning* below). It says whether the ontology is consistent,
    which named classes are unsatisfiable, and what the inferred class hierarchy and class
    memberships are, with a justification for each finding: the asserted axioms it follows
    from, in Manchester syntax, each entity a link to the editor.
    With the fast reasoner, also restrictions that cannot hold
    together, and property characteristics that exclude each other. Enumerations are part of
    it: what a class lists are its instances, members declared all different are different, an
    instance of an enumeration that is different from all members but one is that one (and
    from all of them, a contradiction), an enumeration whose members are all of a class is a
    kind of that class, and a value of a property has to be one its enumerated datatype lists.
  - *SHACL*: the shapes of one shape set, or of every set (see *Shapes*), validated against a
    data graph by a SHACL Core engine (`rdf-validate-shacl`, loaded on first use). Both are
    chosen on the SHACL card. The data graph is the model's own RDF (individuals and ontology
    triples) or one of the model's **data graphs** (since 2026-10-16, roadmap stage SH-2;
    `src/model/dataGraphs.ts`): RDF read from a file, in any syntax an ontology can be opened in,
    kept with the model by what it is (name, file, triples, a fingerprint of its content) and its
    content in this browser's IndexedDB, so it is there after a reload and in a later session.
    The *Data graphs* tab lists them: rename, read again from a file (*Replace…*), validate,
    delete (one undo brings it back), and whether the ontology's triples go with it. Nothing of
    a data graph is ever part of the ontology. Results keep the standard report fields. A
    finding says on which line of its file the focus node is, where the file was Turtle, gives a
    path of more than one property as SPARQL writes it (`:a / ^:b`), and *Open the shape at this
    constraint* opens the very property shape it is of, in its set, with the constraint that
    failed marked and what failed it said there. A run is stale once the model, the data graph's
    content or the choice of shapes changes.
  - *Quality*: 34 modelling rules (missing definitions, redundant superclasses, naming, IRIs
    and namespaces, enumerations without members or with something on the list that does not
    belong there, …), each of which can be switched off per model. They are suggestions,
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
- **Enumeration classes** – a class can be defined as exactly the individuals it lists
  (*Class definition → Enumeration (ObjectOneOf)* in the class editor). Members are picked from
  the individuals of the model or made on the spot; an individual can be on several lists, and
  not twice on one. The class stays a class with everything else it has, and is written as
  `owl:equivalentClass [ a owl:Class ; owl:oneOf ( … ) ]`: never as a triple from the class to
  an individual, and never as `rdf:type`. Members are not taken to be different from one
  another unless *Declare all members different* is ticked (`owl:AllDifferent`). On the canvas
  a line labelled *one of* joins the class to each member. It is a picture of the definition,
  not a relationship: it is not stored, has a style of its own, can be hidden with
  *Enumerations*, and is a kind of line a subgraph can follow or leave out.
- **Enumerated datatypes** – the range of a data property is a standard datatype or one that
  lists its values (*New enumerated datatype…* in the range selector): text, typed values or
  text in a language. It is a datatype, not a class, and its values are literals, not
  individuals. A named one is written as `:Status a rdfs:Datatype ; owl:equivalentClass
  [ a rdfs:Datatype ; owl:oneOf ( "active" "pending" ) ]` and can be the range of several
  properties; one that a file wrote in place as a range is kept in place. An individual can
  only be given one of the listed values for such a property.
- **Interactive page** – *File → Export → Interactive page (HTML)* writes the model as one HTML
  file that opens on its own, with no app and no network: the graph as the canvas draws it (its
  style included, in the theme the app is in), which can be dragged and zoomed; the classes or
  concepts as a hierarchy, and the other kinds of entity, in a list with a search; and for
  whatever is clicked its IRI, definition, place in the hierarchy, relationships and metadata,
  each term named there a link to it. In the page a term can be dragged elsewhere (its lines
  follow, drawn as the app draws them) and a relationship's line pulled into a bow; the
  arrangement is remembered in that browser and *Reset layout* undoes it. It is a read-only copy
  of the model (`src/model/htmlExport.ts`, with the page's own script and stylesheet in
  `src/export/`).
- **Files** – save/open JSON; import Turtle / N-Triples (OWL, RDFS, SKOS); export OWL (Turtle),
  JSON-LD, CSV, SVG and PNG. Drag a file onto the window to open it.
- **Export with inferred assertions** – an export is of what is asserted. *File → Export → OWL
  with inferred assertions (Turtle)* writes the same ontology and, after it, under a heading
  that says what they are and which reasoner worked them out, the inferred class memberships
  and the inferred relationships between individuals as triples. It is of the reasoner chosen
  under Validation; when that one has no answer, or finds the ontology inconsistent, no file is
  made and the reason is given. The model is not changed by it. RDF cannot mark a triple as
  inferred, so a tool that reads the file, this app included, takes them for assertions.
- Whatever is in the editor is also kept as a working copy in the browser, so a reload or a crash
  loses nothing: in IndexedDB, a moment after each change (and at once when the page is hidden),
  with no limit but the space the browser gives the site; a model of 5,200 classes and 6.5 million
  characters is kept and reopened whole. Once something has been edited the browser is asked to
  keep the site's data even when space runs low (`navigator.storage.persist()`); browsers decide
  this for themselves. *My Models* says how much the site keeps and whether the browser has agreed.
  A working copy an earlier version kept in `localStorage` is moved over when the app starts. If
  the copy cannot be kept, that is said, and closing the page asks first.

## Size

Tested with generated ontologies (File → Generate a stress-test model; `src/model/stress.ts`).
Long tables and result lists are shown a page at a time; the search above a table narrows it.

Of a graph of more than 500 terms the canvas draws what is around the view, not the whole graph
(`src/model/culling.ts`, since 2026-10-15); a smaller one is drawn whole and in full, as before:

- **Only the area around the view is drawn**: the terms in it, and the lines that may cross it,
  a line from far away cut to the part that may be seen (the same curve, its dashes where they
  were). The area is the view and four tenths of it on every side, and is drawn as a layer of
  its own, which a pan moves without painting anything again; when the view nears its edge,
  another is drawn around it.
- **Less is drawn zoomed out**: below 30 % no words on the lines, below 20 % no words in the
  terms and no handles, and above 1,500 lines in view they are drawn as a few paths, one for
  each way of drawing them, which a drag passes through to pan.
- **A picture is of the whole graph** all the same: for an SVG, PNG or interactive page the
  canvas draws all of it, in full, for the moment the picture is taken.
- **Above 12,000 terms the graph is never drawn whole** (`GRAPH_LIMIT`): such a model opens on
  the Structure Explorer, and the Graph view asks for a class to draw the graph around (or one
  is clicked in the class tree, or shown in the graph from anywhere else); *Full graph* comes
  back to that question, saying why. Drawn whole, the graph is worked out again, line by line,
  at every edit: some 200 ms at 10,000 terms.

Measured with `scripts/canvas.mjs` (part of `pnpm bench`): on the generated 2,600-class model,
panning with some 300 terms in view went from 4.5 to 55 frames a second, and 91,949 SVG
elements are 1,079; on one of 9,892 terms (6,700 classes), from 0.9 to 43, with 825 elements
for 236,931, and opening it from 5.4 s of blocked page to 0.6 s. Fitted on the screen, both pan
at 60. A model file holds up to 250,000 terms and 1,000,000 relationships (`MAX_TERMS`).
`BENCH_OUT=/tmp/bench.txt pnpm exec vitest run src/model/bench.test.ts` times the model layer.
`pnpm bench` runs both benchmarks named here and measures, in the browser, how long the page is
blocked by an edit, a reasoner run and a validation run on 2,600 classes; the numbers it gave
when this was set up are in [docs/BASELINES.md](docs/BASELINES.md).

The Structure Explorer is built for more than that, because it does not need the ontology to be
in the page: it asks a service, a branch or a page at a time, and draws only the lines in view.
`BENCH_OUT=/tmp/structure.txt pnpm exec vitest run src/structure/bench.test.ts` times that
service on generated hierarchies. On this machine, for 50,000 classes (200,000 in brackets):
building the hierarchy 0.11 s (0.6 s), the inferred hierarchy from a reasoner's direct links
0.23 s (1.3 s), measuring it for *Analyze* 0.2 s (1 s, in stretches that leave the page usable),
and under 10 ms (25 ms) for a page of subclasses, a search, the ways down to a class and a
comparison. What is said of a class takes as little once the depths have been worked out, which
is done once for a revision and takes 0.08 s (0.5 s). *Expand all* to 10,000 lines is 29
questions to the service, one for each level, not one for each branch.

What does not scale with it is the rest of the app, which holds the whole model in the page. The
fast reasoner takes 0.13 s for 650 classes and 1.3 s for 5,200, in a worker since 2026-10-15
(see *Reasoning and validation as jobs*); the canvas draws what is around the view, but works
out the lines of the whole graph at each edit. So that the canvas does not slow the other views
down, it is not laid out or painted while a view covers it: on 5,200 classes that took a click in
*Structure* from about 600 ms to under 70 ms. In the browser, with the 5,200-class generated
ontology open, *Expand all* (7,325 lines, 40 of them drawn) takes 0.2 s, what is said of a class
0.1 s, *Analyze* 0.2 s; opening a model of 6,700 classes blocks the page for 0.6 s.

The lists of the Entities page are searched, sorted and filtered by a service of their own,
over records made once for each revision of the model (0.1 s for the 650 classes of the stress
model, 0.01 s for its 2,553 relationships). On this machine a question then takes about a
millisecond for that model, and 13 ms for a search, a filter and a sort together over 50,000
entities with two labels each. What takes time in the browser is drawing the rows, which is why
a table shows 150 at a time and typing is waited out for 160 ms before it asks: there a search
over the 2,553 relationships is on screen 0.2 s after the last key, and one over the 650 classes,
whose rows hold more, after 0.5 s.

Arranging the graph is not what limits it. The layouts the app has of its own take, for 5,000
terms and 7,500 lines (20,000 and 30,000 in brackets): hierarchical 0.03 s (0.13 s), orthogonal
0.03 s (0.11 s), radial 0.03 s (0.11 s), circular 0.02 s (0.07 s), and the network layout 0.4 s
(1.9 s), which above 1,500 terms lets a term be pushed only by the ones near it. Dagre is the
exception: its time grows far faster than the graph, and with the lines more than the terms
(400 terms with 750 lines: 4 s; 600 with 1,400: 30 s; 960 with 2,550: 3 minutes). So it is
given a graph only up to a weight of 2,400, counting a term as one and a line as two; beyond
that *Layered* says so and uses the built-in hierarchical layout.

## Layout of the code

- `src/model` – everything that isn't UI: types, the zustand store (`store.ts`, made of slices in
  `state/`: the document and its edits, the session, and one slice per job; the working copy, kept in IndexedDB, in `state/persistence.ts`),
  checks, RDF import/export, file handling. What two terms can be related by
  is in `props.ts`, `relating.ts` and `axioms.ts`, and `reconnect.ts` asks them whether an end
  of a relationship can be moved to another term. How a line runs is `geometry.ts`, including
  from an end that was put somewhere by hand; where those ends are is kept in `graphStyle.ts`.
  What of the graph is drawn, and how much of each thing, by where the view is and how far it
  is zoomed, is `culling.ts`, which also cuts a long line to the part that may be seen.
  Which object property a relationship uses, by id, is `identity.ts`; every entity's IRI is
  `iri.ts`; a model of an older format is brought up to date in `normalizeModel` (`types.ts`),
  checked against the files in `fixtures/v1` to `v4`. SHACL shapes as structure, read from
  Turtle and written back, and their paths as SPARQL, are `shacl.ts`; what the views ask of the
  shape sets of a model is `shapes.ts`, and the format-4 shapes are read by `shapesLegacy.ts`.
  The data graphs SHACL validates are `dataGraphs.ts` (their content in IndexedDB, `library.ts`),
  and where in a file a node is, `dataLines.ts`. Shapes proposed from the ontology's axioms, and
  whether an accepted one is stale, are `proposals.ts`. What an ontology says that the model has no place
  for is kept whole by `unmapped.ts`, which the reader (`fromTurtle` in
  `rdf.ts`) tells what it took. Class expressions and data ranges are one structure,
  `expressions.ts` (read from RDF, written in OWL functional syntax as the OWL API has them,
  followed through renames and deletions), with nothing of React in it: `manchester.ts` reads and
  writes them as Manchester syntax and says what to complete and highlight, `inWords.ts` reads
  them out in words, `expressionDraft.ts` is an expression as the visual editor builds it,
  `expressionCheck.ts` what OWL 2 DL allows of it, and `domains.ts` the edits of domains and
  ranges.
- `src/components` – the SVG canvas, side panels, views and menus. The expression editor is
  `ExpressionEditor.tsx` (the blocks, and the dialog), over `manchesterEditor.ts` (the text
  editor, on CodeMirror, loaded when first opened); `ClassAxioms.tsx` and `AxiomList.tsx` use it
  for a class's axioms and a property's domain and range.
- `src/reasoning` and `src/validation` – reasoning and the checks as jobs (see *Reasoning and
  validation as jobs*). Each has its `contracts.ts` (`ReasoningService`, `ValidationService`:
  start, status, cancel and the answer, of a named revision), a local implementation `local.ts`
  that runs the work in a Web Worker (`worker.ts`), and a boundary test. `src/validation/report.ts`
  is what the workbench shows of a report and writes of it. The views never import the reasoner
  or the validation engine (`src/components/boundaries.test.ts`): they read the answers through
  the store (`state/reasoning.ts`, `state/validation.ts`, and `useReasoning` in
  `src/components/reasoning.ts`).
- `src/mapping` – the mapping core (ADR-019), which does not know where rows come from, for
  tabular import now and database mapping at stage DI-2: `template.ts` (IRI templates),
  `values.ts` (value conversion), `plan.ts` (what an import would do, row by row with reasons,
  and the model it makes). `src/import` reads tables from files: `delimited.ts` (CSV and TSV, in
  an encoding), `xlsx.ts` (Excel workbooks, unzipped with the browser's DecompressionStream, no
  library; loaded when first used), `guess.ts` (a first mapping from the column names) and
  `templates.ts` (mappings kept by name).
- `src/projects` – the versions of the models in My Models (`ProjectService` in `contracts.ts`):
  `local.ts` keeps them in IndexedDB, compressed, and restores one as a new version;
  `difference.ts` says what differs between two models, entity by entity, over `changesBetween`.
- `src/editing` – what an edit is, and the service that makes edits (see *Edits as change sets*).
  `contracts.ts` is the change set, by OWL 2's axiom names and IRIs, and `OntologyEditService`
  (apply, validate, and the axioms about an entity). `axioms.ts` reads an RDF statement as an
  axiom and writes it back, giving a typed axiom only where that is the very same statement.
  `local.ts` is the service over the model in the editor: the history of the document as steps,
  which undo applies backwards, and change sets made elsewhere, held to the editor's rules.
  `boundaries.test.ts` keeps the contract free of everything else.
- `src/entities` – the search, the sorting and the filters of the Entities page, apart from the
  page. `contracts.ts` is all the page knows: three questions (`EntityQueryService`: which sorts
  and filters a list has, a page of a list for a search, an order and some filters, and the
  entities there are to choose from for a filter), asked of a named revision, answered with plain
  data. `service.ts` answers them over records (what each entity is searched by, sorted by, and
  has for each filter) without knowing where the records are from; `local.ts`, the only file
  that reads the app's model, makes the records; `http.ts` is the same service asked over HTTP.
  The page (`Entities.tsx`, `EntityToolbar.tsx`, `entityQuery.ts`) asks whole questions and is
  given keys in an order, which it resolves to the rows it edits. `boundaries.test.ts` keeps it so.
- `src/layout` – the graph layouts, apart from the model and from how the graph is drawn.
  `types.ts` is what is kept of a layout (`GraphLayout`) and what a layout is given and answers
  (`LayoutGraph` in, places out). One file for each algorithm (`hierarchy.ts`, `tree.ts`,
  `radial.ts`, `circular.ts`, `force.ts`, and `layered.ts`, the only one that uses Dagre, which is
  fetched when first asked for); `shared.ts` has what they share (breaking rings, layers, the
  parts of a graph and setting them side by side). `compute.ts` runs one, on the page or in
  `worker.ts`; `run.ts` decides which and can cancel. Only `graph.ts` reads the app's model. A
  new layout is a function from a `LayoutGraph` to places, an entry in `LAYOUTS` and a case in
  `compute.ts`. How lines run under a layout (`edgeGeom` in `src/model/geometry.ts`) is the
  renderer's.
- `src/structure` – what the Structure Explorer asks about an ontology and how it is answered,
  apart from both of the above. `contracts.ts` is the whole of what its views know: the questions
  (`StructureService`), asked by IRI, of a named revision, a page at a time, each answer with
  where it comes from. `graph.ts`, `compare.ts`, `analyze.ts` and `service.ts` answer them from classes,
  subclass links and asserted axioms held in memory; `outline.ts` is what a reader of the
  hierarchy keeps of it; `http.ts` is the same service asked over HTTP, with what a server does
  with a request, for when there is a backend (see *Moving the Structure Explorer to a semantic
  backend*). Only `local.ts`
  reads the app's model, and a test (`boundaries.test.ts`) fails if anything else there does, or
  if any of it reaches for the interface. A backend takes part by implementing `StructureService`.
- `e2e` – the browser checks: each a Node script that drives the built app in a headless
  Chromium and prints PASS or FAIL for each thing it checks. Each takes the app's address as its
  argument.
- `scripts` – `verify.mjs` (every check, as CI runs it), `bench.mjs` (the benchmarks and their
  report) and `main-thread.mjs` (the longest main-thread task in the browser, for `bench.mjs`).
- `corpus` – the round-trip corpus: `corpus.mjs` lists the ontologies, each by a fixed version
  and its checksum, and fetches them into `files/` (not committed); `expected/` holds what a
  round trip through the app loses of each today (see *Reading ontologies*). `shacl.mjs` fetches
  the W3C SHACL Core test suite, at a fixed commit and with a checksum of the whole, into
  `shacl/` (not committed); `expected/shacl-core.txt` lists the tests whose report validation
  does not give today (none).

## OWL constructs without an editor

Unions, intersections, complements, restrictions of every kind (on a property or its inverse,
qualified or not, nested to any depth), lists of individuals and data ranges have an editor
wherever they are a domain, a range, a superclass, an equivalent class or a disjoint class (see
*Class expressions*). What has none: an expression OWL does not have (kept as it was read, and
removable), a general class axiom (an expression on the left of SubClassOf), `owl:disjointUnionOf`,
property chains and keys (kept as they were read, see *Reading ontologies*).

An `owl:oneOf` is an enumeration, with an editor of its own, in two places: as the whole of a
class's definition (`owl:equivalentClass` to a list of named individuals) and as the whole of a
datatype (a named datatype equivalent to a list of literals, or such a list written in place as
the range of a data property). Anywhere else it is part of the class expression it is in, and
edited with it (`{Ann, Bob}`, `hasColor some {Red, Green}`, `xsd:date or {"unknown"}`), but not
shown as an enumeration nor read by the app's own reasoner (HermiT reads it): a class that is a
*subclass* of a list, a list inside a union, an intersection or a restriction, a second list on
a class that has one already. A list with an anonymous individual or with both individuals and
literals in it, and a list of nothing, are no OWL class expression: kept as they were read. An
RDF list that is not well formed (it forks, stops short, or comes back on itself) is never taken
for an enumeration; it is kept cell by cell, as broken as it was. A data range written in place
that is not a list of literals (a datatype narrowed by facets, a union of datatypes) is the
property's range axiom, edited as such. Validation points out each list that is not taken as an
enumeration.

Read as the pairs they stand for: `owl:AllDisjointClasses`, `owl:AllDifferent`,
`owl:AllDisjointProperties` (named members only). An `owl:AllDifferent` over exactly the
members of an enumeration is kept as one statement on that enumeration instead.

Not read at all, so lost on import: property chains, keys (`owl:hasKey`), negative property
assertions, `owl:disjointUnionOf`, a *named* datatype defined by anything but a list of
literals (facets, unions; a property that has one as its range names it there),
annotations on axioms,
domains, ranges and hierarchies of annotation properties, `owl:imports` and the ontology's own
annotations other than its name and description. A value whose datatype is not one of the twelve
the app offers is kept as plain text.

## Moving the Structure Explorer to a semantic backend

The Structure Explorer is written so that the ontology can move out of the browser (to Spring
Boot with the OWL API, HermiT or ELK, and Jena TDB2, say) without its views being touched.

**What depends on what.** The views (`src/components/Structure*.tsx`) know one interface,
`StructureService` in `src/structure/contracts.ts`: nine questions, each asked by IRI of a named
revision of a named ontology, each answered with plain data. `Structure.tsx` has the one line
that says which service that is: today `createLocalStructureService`, which reads the model in
the editor. With a backend it is `createHttpStructureService(url)` from `src/structure/http.ts`.
A test puts every question through that client and through JSON and compares the answers with
the local ones, so what goes over the wire is settled. `boundaries.test.ts` fails if anything in
`src/structure` other than `local.ts` reads the app's model, or if any of it reaches for React
or the store.

**The wire.** One `POST {base}/structure/{question}` for each question, the query as the JSON
body, the answer as the JSON response. A refusal is a status with `{ code, message }`:
`stale-revision` 409, `not-found` 404, `invalid` 400, `unsupported` 501.
`answerStructureRequest` in `http.ts` is all a controller has to do.

| Question | Answers | With the OWL API and a reasoner | Notes |
|---|---|---|---|
| `children`, `branches` | The direct subclasses of a class (or the top), a page at a time; `branches` for many classes at once | Asserted: the `SubClassOf` axioms with that named superclass. Inferred: `reasoner.getSubClasses(c, true)`; each `Node` is one line, its other members the `equivalents` | Sorted by label then IRI on the server. `through` asks for the page a subclass is on. `filter` keeps what matches and what leads to it: a label index (Lucene, or Jena's text index) and the ancestors of the hits |
| `paths` | The ways down to a class, shortest first | Upward over the same links, never passing a class twice | A few ways at most; `truncated` says there are more |
| `summary` | Stated superclasses and equivalents, the direct inferred ones, depth, descendants | `getSuperClasses(c, true)`, `getEquivalentClasses(c)`, `isSatisfiable(c)`; anonymous superclasses are counted, not listed | Depths are worth working out once for a revision |
| `search` | Classes by text, best first | The label index | |
| `compare` | How two classes stand, and what each asserts and inherits | Restrictions come as structured axioms, so more kinds can be read than here (`hasValue`, nested expressions). Whether one implies another can be asked outright: `isEntailed(SubClassOf(R2, R1))`, which also covers sub-properties and datatypes | Extend `ClassAxiom` for the further kinds; keep `Basis` saying how each thing is known |
| `explain` | The asserted axioms a subclass relationship follows from | The OWL API's explanation generator, for `SubClassOf(sub, sup)` | The one thing the local service cannot give for HermiT, which is why it says "no justification" |
| `analyze`, `members` | The hierarchy in numbers, and the classes behind each | Over the reasoner's class hierarchy, as a job for a revision | Over plain HTTP there is no progress to report until it is done; for that, poll or stream |

**Revisions.** `revisionId` has to change whenever an axiom changes and at no other time (not
when something is moved on a canvas). A counter bumped by an `OWLOntologyChangeListener`, or
the TDB2 commit, will do. Every answer carries the revision it is of; a reasoner's answer
carries the revision that was reasoned over, and is `stale` once that is no longer the current
one. The views show nothing of a stale answer, and ask again when the revision changes.

**Provenance.** One reasoner stands behind an answer, and it is named. ELK is complete for OWL
2 EL only: for an ontology outside it, say `incomplete` and why, as the fast reasoner does here.
For an inconsistent ontology there is no inferred hierarchy: answer with status `inconsistent`
and no classes, never with the asserted hierarchy in its place.

**What the local service does that a backend has to do the same way.** These are the choices
the views rely on, each covered by a test in `src/structure`:

- Only named classes are in a hierarchy. An individual is not under its class, and a superclass
  that is a class expression is counted for the class and is not a line.
- The asserted hierarchy is what is stated: classes that are each other's superclasses are a
  cycle (`inCycle`), followed once, and one class of a cycle with nothing above it is listed at
  the top so that every class can be reached. Stated equivalence is shown on each class and
  does not merge them.
- The inferred hierarchy has one line for each group of equivalent classes, under the first of
  them by label; a class that can have no instance is under `owl:Nothing` and nowhere else; a
  place that is entailed and nowhere stated is marked `entailedOnly`.
- Direct and indirect are never mixed: `children`, `summary` and `paths` give direct links only.
- owl:Thing is level 0; a class's depth is a range; a cycle is one level.
- A stated superclass is redundant only when another stated one leads to it.
- "Unusually" many subclasses, levels or statements is judged against the ontology itself.

**What stays in the browser.** `outline.ts` (which branches are open, and the lines to draw from
what was fetched), the focus and the two compared classes (in the store), and `StructureHost`,
through which the views open an entity in the editor or on the canvas. Those last two still
need the app to find its own term for an IRI. Every class has one from the moment it is made, so
the views and a backend speak IRIs only; `local.ts` knows a class without one as
`urn:conceptweaver:term:…` only for a model built in code that never had its IRIs given.

**Limits a server may set.** A page is 200 classes unless asked otherwise and never more than
1,000; `branches` takes up to 500 classes; a search gives 12 matches and the total. None of these
is known to the views, which ask for the next page or the next batch.

## Moving the Entities lists to a backend

The same holds for the Entities page as for the Structure Explorer: `entityQuery.ts` has the one
line that says which `EntityQueryService` answers, today `createLocalEntityService`. With a
backend it is `createHttpEntityService(url)` from `src/entities/http.ts`, and the searching,
sorting and filtering are then done where the ontology is; nothing is narrowed or put in order
afterwards in the browser. A test puts every question through that client and through JSON and
compares the answers with the local ones.

**The wire.** `POST {base}/entities/describe`, `/query` and `/options`, the query as the JSON
body, the answer as JSON. A query is `{ ontologyId, revisionId, kind, search?, sort?: { by,
dir }, filters?: { [filterId]: string[] }, offset?, limit? }`; its answer has `rows` (each a
`key`, an `iri`, a `label`, and with a search the `matches`: the texts the words were found in
and where in each), `total`, `matched`, the `words` that were looked for and `notes`. Refusals
are `409` (`stale-revision`), `400` (`invalid`: a sort or filter the list does not have) and
`499` (given up), each with a `code` and a `message`.

**What a backend has to do the same way.** A search is words, each to be found somewhere, a
plain word not in the full IRI. A sort is stable over the ontology's own order, and what has
nothing to be sorted by comes last either way. A filter of type `all` wants every option chosen,
`any` and `one` any of them; a filter that cannot be answered (`unavailable`) is left unapplied
and said so in `notes`, rather than answered with nothing. A page is 150 rows unless asked
otherwise and never more than 1,000; the page asks for more a page after a page.

**What stays in the browser.** A row is edited against the model in the editor: the service
gives keys (locally, term ids, object property keys and relationship ids), and the page resolves
them. With the ontology in a backend the keys would be IRIs and the rows would come with what
they show, which is the one part of the page that would change. What is typed, chosen and open
(`entityViews` in the store) is the page's own and no part of the model.

## Edits as change sets

Every edit of the document is a change set: axioms added to and removed from one revision of
the ontology, with a line saying what was done (`src/editing/contracts.ts`). It is the one shape
an edit has wherever it is made, so that a backend that holds the ontology as OWL API objects can
take the same edits (roadmap tasks 3.5 and 4.3).

**An axiom** has the structure OWL 2 gives it, by OWL's own names, with full IRIs:
`Declaration`, `SubClassOf`, `ClassAssertion`, `ObjectPropertyAssertion`, `AnnotationAssertion`,
the domains, ranges and characteristics of properties, and the rest of the list in
`contracts.ts`, with class expressions and data ranges as the structure the expression editor
has. What has no typed form there yet is carried as the RDF statement it is (`Unmapped`, canonical
Turtle). `src/editing/axioms.ts` reads each statement of an ontology as an axiom and gives a typed
form only where writing that form back gives the very same statement, so an axiom always names
exactly one statement. Of what the app writes for its sample models and fixtures, all but plain
relationships (an `rdf:Property` and the triples that use it, which OWL has no axiom for) is
typed; every statement of the corpus's Turtle ontologies reads and writes back unchanged.

**An edit in the editor** is applied at once and exactly, as a step of the document's history:
the parts of the model it replaced, what they were and what they became (`src/editing/local.ts`).
Undo applies the last step backwards and redo forwards, putting back the very parts it replaced.
A step is applied only to the model it was made to; an edit made after an undo, recorded or
not, means what was undone cannot be redone. What a step is as axioms is worked out when it is
asked for (`changeSetOf(index)` in the store), not on every keystroke: for the 2,600-class model
that takes about half a second, as much as an export, while recording and undoing a step take
less than a millisecond.

**The revision and unsaved changes.** The document has a state (a number for each state it has
been in) and the revision of the ontology that state is. Moving a term is a new state, which has
to be saved, but not a new revision: the ontology says the same. "Unsaved changes" compares
states, so undoing back to what was saved makes the model saved again. Undone back to an earlier
revision, everything worked out for it holds again: the validation results of that revision are
current, and the Structure Explorer and the Entities lists answer from what they have.

**A change set made elsewhere** is applied through `editService` in the store, which implements
`OntologyEditService` over the model in the editor:

- It is refused whole, with a reason for each change it cannot make, when it names another
  ontology (`not-found`), a revision the ontology has moved on from (`stale-revision`), removes
  what is not stated or adds what is (`invalid`), or adds what the editor's rules refuse
  (`refused`: a class cannot be its own superclass, a value has to fit the property's range, a
  membership is not stated twice; the rules are the functions of `src/model/axioms.ts` that the
  editor's own controls use). What a rule allows but has something to say about (a circular
  hierarchy) is answered as a note. The rules are asked of the model once the change set's
  removals are made, so what it takes away does not stand in the way of what it adds.
- Otherwise its statements are applied to the ontology's and read back into a model, with what
  the statements do not say carried over from the model before: the ids of entities,
  relationships and axioms (which the drawing, the shapes and the mappings refer to), where the
  terms sit and their colours, and the model's settings. A term, relationship or axiom that is the
  same as before is the very object it was.
- It is applied only if the model read back states exactly what was asked for. Where the editor
  would hold it otherwise, it is refused as `unsupported`, with how many statements would be lost
  or added: a class of the ontology's own namespace declared without a label (the editor gives
  every term a name, and states it).
- Applied, it is one step of the history like any other, and undo takes it back.

`validate` answers the same without applying anything; `entity` gives the axioms about one
entity in a revision: those it is the subject of, and those of no subject of their own (such as
`owl:AllDifferent`) that name it.

**Not done yet.** There is no HTTP client for this service: it is the server's in Phase 3, where
the same change sets are put through both and compared (the conformance suite of task 3.5). The
store's edits are synchronous, so a remote service will need the document to wait for its answer
(Phase 4). A change set's additions are held to the rules only where they are about entities the
model has before it is applied; an entity it declares itself is not checked. Terms that a change
set adds are placed where the reader's layout puts them, not near what they are related to.

## Reasoning and validation as jobs

Reasoning and the checks are jobs (`src/reasoning`, `src/validation`): asked about one revision
of the ontology, worked out away from the page, stopped whenever they are no longer wanted, and
answered for that revision only. So the page is never held up by them: on the 2,600-class
generated ontology the longest main-thread task of an edit went from 533 ms to about 70 ms, and
a reasoner run or a validation run no longer has a task over 50 ms (from 357 ms and 386 ms; see
docs/BASELINES.md).

**The fast reasoner** runs in a Web Worker, one for each job, and is asked only when something
on show wants its answer: the inferred sections of the entity editor and the panel, the inferred
column of the classes table and the filters that rest on it, the Structure Explorer, the inferred
facts on the canvas, the list under Validation. Until it has answered about the model as it is,
each of these says that it is working out what follows. The worker sends back what it derived,
fact by fact with what each fact was derived from (`derive` in `src/model/reasoner.ts`), and the
page words it, and works out the superclasses and types of what is asked about, when it is asked
(`view`). The whole answer in words would be 36 MB at 2,600 classes, and copying it to the page
would itself hold the page up for a quarter of a second. A job about a revision the model has
moved on from is stopped; the answers of the last few revisions are kept, so that an undo finds
its answer there.

**The OWL 2 DL reasoner** is a job of the same service, asked through the reasoning service beside
the app (`engine: 'dl'`); stopping the job gives the request up. Its answer is kept with the
revision it is of, whichever view asked for it.

**The checks** run in a worker too. The workbench's run says what it is doing as it goes and can
be stopped (*Stop*); the results shown are then those of the run before. A quick fix travels as
what it does, in words, and is found again in the model when it is applied. The count of problems
in the header comes from the OWL and quality checks run by themselves a moment after each edit,
and the check of the mappings under *Align* from the OWL checks over the ontology with what it
imports, both in the background.

**Not done.** The reasoner is run once for the views and again inside a validation job, each in
a worker of its own. Applying a quick fix finds it again by running the quality rules on the page
(about 0.2 s at 2,600 classes). At 2,600 classes opening the model blocks the page for 0.2 s,
selecting a class from the class tree 0.14 s, an edit 0.08 s; at 10,000 terms selecting one is
0.28 s, most of it painting the part of the graph the view jumps to, and an edit 0.19 s, the
lines of the whole graph worked out again (`scripts/main-thread.mjs`).
There is no HTTP client for either service yet; a backend implements the same contracts (Phase 3).

## OWL 2 DL reasoning (HermiT)

The app runs in the browser, and there is no complete OWL 2 DL reasoner for the browser: HermiT
is a Java program. So the advanced reasoner is a small service that runs beside the app, on the
same machine, and is asked over HTTP.

```bash
pnpm reasoner          # http://localhost:5190; Ctrl+C stops it
```

- **What it needs**: Java 11 or later, as a JDK (the service is one source file,
  `reasoner/ReasonerService.java`, compiled on the first start). The first start also fetches
  the libraries, once, about 90 MB: the OWL API 4.5.29, HermiT 1.4.5.456 and the OWL API's
  explanation library 2.0.0, in the one file the ROBOT project publishes them in. It is checked
  against a pinned SHA-256 and kept in `reasoner/lib/`.
- **What it does with an ontology**: nothing but reason over it. The app sends the ontology as
  the Turtle it exports, and the ontologies it imports as the Turtle that is cached in the
  browser. The service loads them into memory, answers, and forgets them. It writes nothing to
  disk and fetches nothing from the network: an import whose content was not sent is reported
  as missing.
- **What else it does**: it reads the OWL syntaxes a browser cannot. A file in OWL/XML,
  functional syntax, Manchester syntax or OBO is sent to it (`POST /convert`) and comes back as
  Turtle, with its prefixes, which the app then reads like any other. Only the file is read: no
  import is fetched, and nothing is reasoned over or kept. A service started before this was
  added has to be stopped and started again to have it. It also compares two documents of one
  ontology statement by statement (`POST /compare`), which the round-trip test uses; the app
  does not ask it that.
- **Who can ask it**: it listens on 127.0.0.1 only and answers pages served from this machine
  (`localhost`, `127.0.0.1`). An app served from elsewhere has to be named when the service is
  started: `pnpm reasoner --allow-origin=https://where.the.app.is`. `--port=` and `--host=`
  change where it listens; the address the app asks is set beside the engine choice.
- **Without it** the app is what it was. The fast reasoner needs nothing. Choosing the advanced
  reasoner while the service is not running gives the status "Unknown: the reasoner gave no
  answer" and says how to start it; it is never reported as consistent.

What the answer covers, and where it stops:

- HermiT reasons over what the app exports. Everything the app keeps is in it, including class
  expressions kept as text (unions, intersections, complements, nested restrictions, `hasValue`,
  unqualified cardinalities), enumerations, datatype restrictions and RDF lists. What the app
  does not keep when it reads a file is not: property chains, keys, negative property
  assertions (see *OWL constructs without an editor*). A relationship kept plain is not an OWL
  axiom and plays no part.
- The status says how far the answer goes. *Complete*: the ontology is OWL 2 DL and all of it
  was reasoned over; "consistent" is then proved. *Partial*: reasoned, with something taken
  loosely or left out, which is named: a datatype outside the OWL 2 datatype map (`xsd:date`,
  `xsd:time`, `xsd:gYear`, `xsd:duration`), whose values HermiT then neither checks nor
  compares, or an import that was not available. *Failed*: no answer. HermiT refuses an
  ontology outside OWL 2 DL in ways that make reasoning undecidable, such as a transitive
  property in a cardinality restriction; the violations are listed as findings, on the
  entities they are about.
- Something used without being declared (`skos:definition`, most often) is read as what its use
  implies and is not counted as being outside OWL 2 DL: it changes no axiom.
- An inconsistent ontology has no inferred hierarchy or memberships: none are shown.
- Justifications come from the OWL API's explanation library, one for each finding, within a
  time limit (20 seconds a run, and the first 25 unsatisfiable classes). Where none was worked
  out, the finding says so. Nothing is composed by hand.
- Reasoning is stopped after 60 seconds and reported as failed. Results belong to the revision
  of the model they were made for: after an edit they are marked stale, and what the editor
  and the graph show of them is withdrawn until the reasoning is run again.
- Inferred relationships between individuals are worked out for an ontology of up to 4,000
  pairs of individual and object property (one question to the reasoner each); beyond that
  they are left out and the result says so. Inferred values of data properties are not asked for.

Both reasoners feed the same places: the Validation results, the *Inferred* sections of the
entity editor (each line credited to the reasoner it is from), the inferred class memberships
and relationships between individuals on the canvas, *Inferred facts*, and the export with
inferred assertions. Choosing the other reasoner asks it at once, and what the first one
inferred is withdrawn from all of them. Nothing inferred is ever added to the model unless you
state it with *Add to model*. The interface between the app and a reasoner is
`src/model/reasoning.ts`; what is shown as inferred, whichever reasoner found it, is put
together in `src/model/inferred.ts`.

## Validation: what is and is not covered

- The fast reasoner is a rule reasoner, not a complete OWL 2 DL reasoner: "No contradiction
  found" means its rules reached none. Class expressions kept as text are not interpreted by
  it. The advanced reasoner (above) is complete, and interprets them.
- Enumerations are not reasoned with by cases. An instance of `{ A, B }` is concluded to be `A`
  only once it is known to be different from `B`; what holds for `A` and for `B` alike is not
  concluded of it. Nothing is counted: a class that needs three different values out of an
  enumeration of two is not found unsatisfiable, and two enumerations without a common member
  are not found disjoint. An enumeration with something other than an individual on its list
  is left alone until that is taken off. An enumerated datatype is used for one thing, checking
  the values individuals have against the list of their property's range (a number by its
  value, so `"01"` is `"1"^^xsd:integer`; anything else as written, so a date with a time zone
  is not the same date without one); datatypes are not compared with each other.
- SHACL: all of SHACL Core is validated, and the shape form covers all of it. Every one of the
  98 tests of the W3C SHACL 1.0 Core suite gives its expected report when its shapes are read
  into a shape set and its data validated as the workbench does
  (`src/model/shaclConformance.test.ts`, run in CI). SHACL-SPARQL, SHACL Advanced Features and
  entailment regimes are not validated; `sh:sparql` is kept as Turtle. A shape that refers to
  itself (through `sh:node`, `sh:or` and the like), which SHACL leaves undefined, ends the run
  with a message saying so.
- A finding's line is the one statements about its focus node begin on (or where it is first
  named, when nothing is said of it). There is none for a blank node, nor for a file read from
  RDF/XML, JSON-LD or another syntax that is converted to Turtle: the Turtle is not the file.
- Importing a table: the older Excel format (.xls) is not read (save it as .xlsx or CSV); a
  formula gives the value Excel last calculated. A row whose IRI the model has already is left
  as it is: updating entities from a table is not done yet (FR-M7-6). An individual's values are
  values of data properties; a class's column of values is an annotation. More than 3,000 new
  terms are laid out row by row rather than as a hierarchy. Templates are kept in this browser.
- Shapes proposed from the ontology: a proposal dismissed is shown again the next time
  proposals are opened. A stale shape shows the axiom it came from in OWL functional syntax, since
  the ontology no longer has it to be read out in Manchester syntax.
- A data graph's content is kept in this browser only. A model saved to a file or opened in
  another browser names its data graphs without their content: each says so, and validating it
  says why it cannot be done, until it is read again from its file. The content of a deleted
  graph stays in the browser, so that undo finds it.
- OWL restrictions are never turned into shapes, and reasoner-inferred types are not added to
  the data graph.
- Validation runs as a job in a worker, and a run can be stopped (*Stop*, while it runs); the
  results shown are then those of the run before. See *Reasoning and validation as jobs*.
  A full run takes about a second on 3,000 terms.

## Reuse and alignment: limits

- External ontologies are read in every syntax an ontology can be opened in, and kept in the
  browser as Turtle. A URL works only if its server allows requests from other sites (CORS).
- An external ontology's content is cached in this browser, not in the model file. On another
  machine the references and mappings are all there, and the library says the content is
  missing until the ontology is added again.
- Imports are not followed transitively: an imported ontology's own imports are not fetched.
- Opening a Turtle file, an entity outside the default namespace that is only declared is
  taken to be an external reference.
- Suggestions are lexical. The matcher is a list of functions (`src/model/matcher.ts`), so an
  embedding-based one can be added beside it.

## Graph layouts: what the canvas can and cannot do

The graph is drawn by the app's own SVG canvas (`src/components/Canvas.tsx`); there is no graph
library under it, so there were no built-in layouts to reuse beyond the two the app already
had. Those are kept as they were, place for place, and the others are written beside them.
Dagre was added for the layered layout (15 kB gzipped, in a chunk of its own). ELK.js was looked
at and left out: it is 1.5 MB, and what it does best, routing each line around the terms with
bend points, the canvas cannot keep (see below).

- **A line is drawn from where its two terms are, and where its ends were put by hand if they
  were, and from nothing else.** That is what lets a
  term be dragged in any layout with its lines following, and what the picture exports and the
  exported page rely on. It also means no layout can hand the canvas a route: Dagre's bend
  points are not used, a line does not go round a term that lies in its way, and right-angle
  lines are an elbow between two sides, not routed through free channels. In a tree they run
  clear; a line to a second superclass, or any line across the tree, can cross terms.
- **Lines know little of each other.** Several arriving at one term are set side by side, and
  the words go to the end with fewer lines; beyond that, lines sharing a stretch lie on top of
  each other, and labels are moved along their own line only.
- **Wide trees stay wide.** The orthogonal tree and Dagre give every leaf a column, so a
  hierarchy with a hundred leaves is some 15,000 pixels wide; *Fit* now zooms out to 3 % to show
  it. Left to right, the radial tree or a subgraph are the ways to a smaller picture. Sibling
  leaves are not stacked.
- **Circular is one ring for each connected part**, however many terms: past a few hundred it
  shows the density of the graph more than anything in it.
- **The layout is not kept up to date by itself.** A term added later goes where it is put;
  *Rearrange* runs the layout again. That is deliberate: an edit never moves what was arranged.
- **Gliding is for up to 300 terms and 700 lines**; a larger graph is shown in its new places at
  once, and nothing glides for someone who asked their system for less motion.
- **The canvas draws what is around the view** (see *Size*), whatever the layout: arranging
  5,000 terms takes a fraction of a second, and drawing them only as many as are near the view.
- In the exported page a moved term redraws its lines the way the layout has them, with the
  places among other lines they had when exported.

## The ends of a line: what moves, and what is refused

Two things can be done with an end of a relationship, and they are kept apart all the way down.

**Where the line meets its term** is a matter of the picture. It is kept as a side of the term
and how far along that side (`style.anchors[relationshipId].from` and `.to`, each
`{ side: 'top' | 'right' | 'bottom' | 'left', at: 0..1 }`), beside the styles of single
relationships and nowhere near the statements. So it travels with the model in its JSON file,
in the browser's working copy and in *My Models*; it is not in Turtle, RDF/XML or JSON-LD, and
an ontology opened from one of those has every end placed automatically. Being a proportion of
a side, it stays put when the term is moved and keeps its place when the term grows with its
name or is given another shape. Changing it does not touch `model.relations`: nothing is
reasoned or validated again for it, and the exported ontology is the same text.

**Which term the end is on** is what the ontology says, and moving it is an edit. One module
decides it, `src/model/reconnect.ts`, which draws nothing: `reconnection(model, id, end)` works
out once which terms could take an end (so that every term on the canvas can be asked while the
end is dragged, at no cost that grows with the model), and `reconnect(model, id, end, term)`
gives the model with the end moved, or the reason it cannot be. The canvas, the side panel, the
table of relationships, the store and a server that kept the ontology all ask the same two
questions. Its rules are the ones the
rest of the app relates terms by, not a second set:

| Relationship | Its start | Its end |
| --- | --- | --- |
| Is a | a class (or a data property) | a class (or a data property), not itself, not one it is a kind of already |
| Is an instance of | an individual | a class it is not stated to be an instance of already |
| Has data property | a class | a data property |
| Object property, between classes (a restriction) | a class | a class; the class itself is allowed, as a loop |
| Object property, between individuals (a fact) | an individual | an individual |
| Standard property (`owl:disjointWith` and the like) | what the property is meant to connect | the same; not what is stated already, either way round where it holds both ways, and not what the opposite statement rules out |
| Plain relationship, broader (a vocabulary) | any concept | any concept; "is a" not itself |

- **What it is never changes.** An "is a" dropped on a data property is refused; it does not
  become "has data property". The same holds for the *From* and *To* boxes of the side panel and
  of the table of relationships, which move an end by the same rule: a term that cannot take it
  is listed greyed out, with the reason as its tooltip. To make a relationship another kind of
  relationship is an edit of its own, under *Kind*; where no kind fits both the old ends and the
  new ones, the relationship is drawn again between the new ones.
- **One step, or nothing.** The relationship keeps its id, its name, its restrictions
  ("only", "min 1"), its cardinalities, its description and its style; only the end is another
  term. No class or property is made and no other statement is rewritten. Where a rule refuses,
  the model is the very object it was, nothing is added to the undo history, and the reason is
  shown. A circular hierarchy is allowed, as adding a superclass allows it, and said.
- **What follows from the uses of a property follows.** A domain or range that was never set by
  hand follows where the property is used, as it always did, so it can change with a
  reconnection; one that was set by hand is left alone.
- **Not everything can be reconnected.** What the reasoner works out and what an enumeration
  lists are not stored relationships: they cannot be selected, so they have no handles. A
  relationship between two terms of other ontologies is that ontology's statement, and a mapping
  to another ontology is kept under *Align* with its status and notes: both show their handles,
  so that where the line meets its terms can still be changed, but no term will take their ends,
  and the reason is said. A plain relationship left over in an ontology is given a kind first.
  Class expressions the app has no drawing for (axioms of a class) are not lines at all.
- The end that moved is drawn where the layout puts it again: where it had been dragged to was a
  place on the term it left. The other end stays where it was put.

What the canvas itself limits (it is the app's own SVG canvas; there is no graph library under
it, and nothing was replaced):

- **A line with an end put by hand goes round its own two terms, not round others.** Straight,
  it runs from the place it was given; if that place faces away from the other term it bows
  round. Curved, it leaves square to its side. With right angles it turns as often as it takes
  not to double back, up to four times. A third term lying in its way is crossed, as it is by
  any other line (see *Graph layouts: what the canvas can and cannot do*).
- **A place is a side and a position along it**, not a free point: on an ellipse, a circle, a
  diamond or a hexagon that is the point of the outline above, below or beside it. There are no
  bend points to drag, and a loop from a term to itself has the one place it always had.
- **The handles are for a pointer.** They are 26 pixels across whatever the zoom, but they are
  not reached with Tab: from the keyboard the panel's *Connection points* (side and slider) and
  its *From* and *To* do the same. Only one relationship has handles at a time, the one that is
  selected by itself.
- **Terms are told apart while an end is dragged by redrawing each once**: with a few thousand
  on the canvas that is a moment's pause when the end leaves its term, on top of what *Size*
  says about drawing that many at all. The rules themselves are worked out once per drag.
- In the exported page the ends are where they were put, and stay there when a term is moved;
  the page cannot move them.

## Reading ontologies: what is and is not covered

- **How it is read.** Everything is made Turtle first and then read by the one reader the app
  has always had (`src/model/rdfFormats.ts`, then `fromTurtle` in `rdf.ts`). RDF/XML and JSON-LD
  are parsed by the RDF engine the app already had for SPARQL (oxigraph, 4 MB, fetched when
  first needed), RDF/XML with a line break or a tab in an attribute value read as a space, as XML
  and every other reader have it; the syntaxes that are not RDF go through the OWL API in the
  local service.
  Tried on the Pizza, Wine, Koala, PROV-O, SKOS and OWL-Time ontologies and FOAF as published:
  each opens in under 50 ms (Wine: 238 terms, 1,257 relationships), and written out and read
  again gives the same terms and relationships.
- **What becomes what.** As for Turtle: a named class, property or individual is an entity of
  the model; `rdfs:subClassOf`, `rdf:type`, restrictions by one property and property
  characteristics are drawn or listed; every domain and range statement is an axiom with its
  expression (see *Domains and ranges are axioms*); any other class expression stated as a
  superclass, an equivalent class or a disjoint class (an intersection, a union, a nested
  restriction) is an axiom of its class, of that kind, with its structure (see *Class
  expressions*): shown, edited, exported and sent to the reasoner. A restriction by a data
  property is drawn only where its datatype is the property's range (or `rdfs:Literal`, where
  the property has none), as a drawn one is written; one to another datatype is an axiom of the
  class, with its datatype.
- **What the model has no place for is kept, not editable here**: SWRL rules, property chains
  (`owl:propertyChainAxiom`), keys (`owl:hasKey`), negative property assertions, annotations on
  axioms, an ontology's version IRI and its annotations beyond name and description, a class
  defined by an `owl:intersectionOf` stated on itself (as older RDF/XML files write it), datatype
  definitions, statements about annotation properties, and whatever else the reader takes
  nothing from. Each such statement is kept whole, as it was read (`src/model/unmapped.ts`), saved
  with the model, and written back at the end of every Turtle and JSON-LD export; the OWL 2 DL
  reasoner gets it too, the app's own reasoner does not. It is not shown or edited. The message
  on opening says what was kept ("2 property chains, 1 key and 12 other statements"). A
  statement the reader took into the model is never kept a second time: deleting a class
  deletes it, without a copy left behind; and a kept statement that mentions a deleted entity
  goes with it, as it would in any other editor, while one that mentions an entity given a new
  IRI follows it. `owl:AllDisjointClasses` and `owl:AllDifferent` of more than two members are
  drawn as their pairs, each of which can be edited or deleted on its own, and written back as
  the one axiom they were while every pair of them is still stated; with one taken away, what is
  left is written pair by pair. A pair the file also stated on its own is written so too.
  `owl:AllDisjointProperties` is still read, and written, as pairs.
- **Written back as read**: a description with the property it came from (`rdfs:comment`,
  `skos:definition` or `dcterms:description`), a name or description in the language it had (or
  none), an annotation of another vocabulary by its own IRI, a value with its own XML Schema
  datatype, text that looks like a link as text (a link of `rdfs:seeAlso` and the like as a link).
- **What a round trip loses, measured.** `src/model/corpus.test.ts` opens each ontology of a
  fixed corpus (`corpus/corpus.mjs`: the seven above, the OWL 2 Primer's example and the core of
  the Relation Ontology), saves it as Turtle unchanged, and has the OWL API compare the two
  statement by statement. Over the nine, nothing is lost (790 statements were before what is not
  understood was kept, and 24 before the n-ary axioms, the data restrictions, the text that looks
  like a link and the RDF/XML white space above). SKOS comes back exactly. What is added (521
  statements) is an `rdfs:label` for each entity that had none, a declaration where OWL 1 used
  an entity without one, the ontology's name, and, for a property of which the file states no
  domain or range, the one that follows its uses (Pizza's `hasSpiciness`, Wine's `hasMaker`):
  the only additions that say more than the original. The lists are
  in `corpus/expected/`, one file for each ontology, and the test fails when one changes: a fix
  shows there as statements no longer lost. `pnpm corpus` fetches the corpus once.
- **Imports are not followed.** What an ontology imports is listed under *Align* by its IRI;
  add it there (from a file or a URL) for its entities to be reused and its axioms reasoned
  with.
- **From a URL**, the browser has to be allowed to fetch it: many servers of ontologies do not
  let other sites do that (CORS), and then the file has to be downloaded and opened. The app
  asks for Turtle first, then RDF/XML, then JSON-LD.
- **JSON-LD** is read when its context is in the file. A context that is a link is not fetched.
- **Size.** The file is read in one go in the page. A few megabytes are fine; an ontology of
  hundreds of thousands of classes will open slowly or not at all, and the canvas draws every
  term (see *Size*).

## Not there yet

Excel/PowerPoint/PDF export, AI assistance, multiple saved models.
Colours, positions, the layout and cardinalities live only in the JSON format; the Turtle export carries the
terms, descriptions, synonyms and relations.

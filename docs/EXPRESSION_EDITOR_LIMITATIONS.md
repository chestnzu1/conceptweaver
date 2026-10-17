# Limitations of the Expression Editing Framework

What the class expression editor, and the domains and ranges built on the same model, do not do
today (2026-10-14, model format 4, branch `instance-of-and-iri-suffix`; brought up to date
2026-10-15, roadmap task 2.1: three of them are done, and keep their numbers). Companion documents:
[TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) (TD-01, TD-02), [BASELINES.md](BASELINES.md) (what a round
trip of the corpus loses), and the README sections *Class expressions* and *Domains and ranges
are axioms*.

The framework is:

- `src/model/expressions.ts`: the structured expression model, shared by every editor;
- `src/model/manchester.ts`: Manchester syntax, read and written;
- `src/model/inWords.ts`: an expression, and an axiom, read out in words;
- `src/model/expressionDraft.ts` and `src/model/expressionCheck.ts`: the visual editor's draft,
  and what OWL 2 DL allows;
- `src/components/ExpressionEditor.tsx` and `src/components/manchesterEditor.ts`: the editor;
- `Term.classAxioms`, `ObjProp.domains`/`ranges`, and `Term.domains`/`ranges`: where expressions
  are kept.

## 1. How to read this document

Each limitation says:

- what it is;
- what it does to the user's data (**kept** means nothing is lost; **changed** means the
  ontology says the same but is stored or written another way);
- what can be done about it now, and what would remove it.

| Kind | Meaning |
| --- | --- |
| **By design** | A choice, made on purpose and with a reason. It would be changed only by deciding otherwise. |
| **Gap** | Not done yet. Nothing in the design stands in its way. |
| **External** | Comes from a library or tool the app depends on. |
| **Done** | Was a gap; is not any more. Kept here, with what was done, so that the numbers stay. |

## 2. Summary

| # | Limitation | Kind | Data |
| --- | --- | --- | --- |
| 1 | Expressions OWL has no class expression for are read-only | By design | kept |
| 2 | Frames and general class axioms are not edited | Gap | kept |
| 3 | The OWL API reads one facet value differently from the app | External | — |
| 4 | Deleting a class inside a restriction removes the whole axiom | By design | changed by the user's action |
| 5 | The app's own reasoner does not interpret expressions | Gap | — |
| 6 | No rendering of an expression in words | Done | — |
| 7 | A stated empty domain or range reads back as one that follows the uses | By design | changed |
| 8 | A domain equal to the uses reads back as one that follows them | By design | changed |
| 9 | One edit that deletes an entity and adds another may leave a reference to the deleted one | Gap | kept, as a dangling IRI |
| 10 | A data property's datatype list edits the first datatype axiom only | By design | — |
| 11 | Complex domains and ranges are not editable in the Entities table | By design | — |
| 12 | Two properties with one label: a typed name takes the first | Done | — |
| 13 | Only class expressions are laid out over lines | Gap | — |
| 14 | Validation judges only named classes, unions and intersections | Gap | — |
| 15 | Facets and literals are checked for the XML Schema datatypes only | Gap | — |
| 16 | Punning is warned about, not refused | By design | — |
| 17 | Disjoint-class expressions are not inherited into *Inferred restrictions* | By design | — |
| 18 | The Structure Explorer compares expressions as written | By design | — |
| 19 | Models of format 3 and 4 cannot be opened by an older version of the app | By design | — |
| 20 | A format-3 model's disjoint-class expressions stay uneditable until re-imported | Gap | kept |
| 21 | A named superclass typed as an expression is not drawn until the file is read again | Gap | changed |
| 22 | JSON-LD exports are checked with the RDF engine, not the OWL API | External | — |
| 23 | The accessibility audit does not cover the expression dialog | Done | — |

## 3. Editing

### 1. Expressions OWL has no class expression for are read-only

**What.** An expression read from a file that OWL 2 has no structure for is kept as the canonical
Turtle it was read as (`Unparsed`). Examples: a restriction with two quantifiers on one node, an
empty `owl:oneOf ()`, a list with an anonymous individual in it, or a list mixing individuals
and literals. It is shown, marked *kept as read*, written back, and can be removed, but not
changed. The same holds for an expression with such a part anywhere inside it.

**Why.** There is nothing well formed to edit it into. Guessing a repair would change what the
file says.

**Data.** Kept, statement for statement (`domains.test.ts`, `enumReasoning.test.ts`).

**Now.** Remove it and state what was meant with the editor. A remedy, should one be wanted, is
a "replace with…" that starts the editor from the parts that do read.

### 2. Frames and general class axioms are not edited

**What.** The editor edits expressions where a class or a property's domain or range takes one.
These are not edited:

- whole Manchester frames (`Class: … SubClassOf: …`);
- general class axioms (an expression on the left of SubClassOf);
- SWRL rules.

**Data.** A frame is not read as an expression at all; a general class axiom and a SWRL rule
are kept as the statements they were read as (`Model.unmapped`), written back with every
export, and sent to HermiT.

**Status, 2026-10-17 (roadmap task 2.8).** Annotations on axioms, `owl:propertyChainAxiom`,
`owl:hasKey`, `owl:disjointUnionOf` and negative property assertions are typed axioms now (model
format 8) with editors of their own (`src/components/AxiomParts.tsx`), and are no longer kept as
text. What remains as text is what this item now names: frames, general class axioms and SWRL
rules.

**Next.** A general class axiom editor. Frames are a syntax the app does not read; SWRL rules
are FR-M2-8.

### 3. The OWL API reads one facet value differently from the app

**What.** In `xsd:string[length 4]` the OWL API's Manchester parser types the `4` as
`"4"^^xsd:string`. The W3C grammar makes a bare `4` an `xsd:integer`, and OWL 2 requires the value
of `length` to be a non-negative integer, so the app reads `"4"^^xsd:integer`. This is the one
difference `expressionConformance.test.ts` finds among the 30 expressions it checks. The test
names it, so that any other difference fails.

**Data.** Unaffected. The app writes what the grammar says; HermiT accepts it.

**Next.** None needed in the app. A backend that uses the OWL API's parser should normalise facet
values, or keep using the app's reading.

### 4. Deleting a class inside a restriction removes the whole axiom

**What.** When a class, property, individual or enumerated datatype is deleted, what names it in
domains, ranges and class axioms goes with it:

- an operand of a top-level union or intersection is dropped, and the rest stays;
- anything else that names it goes as a whole axiom. For example, deleting `Organization`
  removes `hasChild only (Person or Organization)` entirely, rather than narrowing it to
  `hasChild only Person`.

**Why.** Dropping an operand inside a restriction changes what the restriction says, and in
either direction. Removing the axiom is what the OWL API's entity remover does.

**Data.** Changed by the user's own deletion. Undo restores it (`classAxioms.test.ts`).

### 5. The app's own reasoner does not interpret expressions

**What.** The in-page rule reasoner reads named classes, drawn restrictions, and domains and
ranges that are a class or an intersection of classes. It does not reason with the inside of a
class expression. *Inferred restrictions* inherit a superclass's expressions as they are stated,
not interpreted.

**Now.** The OWL 2 DL reasoner (HermiT, in the local service) interprets all of them: it finds
unsatisfiable classes and classifies by definitions (`expressionConformance.test.ts`).

**Next.** Not planned for the in-page reasoner. The roadmap's backend takes OWL reasoning server-side.

### 6. No rendering of an expression in words (done)

**What.** FR-M2-3 asks for an expression rendered in words ("everything that has a child who is a
student"). The editor showed Manchester syntax, and the blocks named each operator (`SOME ·
existential`), but there was no sentence form.

**Done, 2026-10-15.** `src/model/inWords.ts` reads an expression out, beside `classText` and over
the same model: under the editor as it is written, and under each class, domain and range axiom
listed, as a sentence of its kind ("Every “Margherita” is …", "Something is a “MeatyPizza”
exactly when it …", "No “Pizza” is …"). One wording serves every property ("is related by “p”
to"), whatever it is called; it does not make English of a property's own name, so `hasChild
some Student` is "related by “hasChild” to at least one “Student”", not "has a child who is a
student". A long part of an *and* or *or* before another is set apart with a semicolon; past
three levels of nesting a sentence can still be hard to follow, and the Manchester syntax above
it is the exact form.

## 4. Domains and ranges

### 7. A stated empty domain or range reads back as one that follows the uses

**What.** A domain stated as none (`domains: []`) writes no `rdfs:domain` statement. Read back,
no statement means the domain follows the property's uses.

**Data.** Changed only in what happens next: the two say the same until the property gets a use
between classes, when one that follows the uses gains a domain.

**Next.** RDF has no statement for "no domain". An annotation of the app's own could carry it,
at the cost of an extra statement in every export.

### 8. A domain equal to the uses reads back as one that follows them

**What.** On import, a domain or range that is exactly one axiom, naming the class (or the union
of the classes) the property is used with, is taken to follow the uses. Two axioms are never
treated so (PROV-O's `prov:hadActivity` keeps both).

**Why.** The app writes a domain that follows the uses as just such a statement. Reading it back
the same way keeps the app's own round trip stable.

**Data.** Changed only in what happens next, as in limitation 7. The written statement stays
the same while the uses do.

### 9. One edit that deletes an entity and adds another may leave a reference to the deleted one

**What.** Pruning (limitation 4) runs when an edit leaves fewer terms, properties or datatypes
than before (`prepared` in `store.ts`). That check keeps the cost off edits that delete nothing.
An edit that deletes one entity and adds another at once leaves the counts equal, and is not
pruned.

**Data.** Kept. The axiom names an IRI that is no longer an entity of the model, which is still
valid OWL.

**Next.** Compare entity IRIs whenever any of the three lists changes identity, at the cost of a
set per edit on large models.

### 10. A data property's datatype list edits the first datatype axiom only

**What.** A data property whose range axioms name two datatypes on their own (`xsd:integer` and
`xsd:nonNegativeInteger`) shows the first in the *Datatype* list. The others are listed under
*Further range axioms*. Values entered for such a property are checked against every datatype
named.

### 11. Complex domains and ranges are not editable in the Entities table

**What.** In the table, a domain that is "any of" some classes is edited as chips. One that is
two axioms, or an expression, is shown as text with an *edit* link to the side panel.

**Why.** A table cell has no room for the expression editor.

## 5. Manchester syntax

### 12. Two properties with one label: a typed name takes the first (done)

**What.** A name is matched against labels, exactly and then ignoring case. Two classes, two
individuals or two datatypes with one label were refused, with a request for the prefixed name
or IRI. Two properties with one label (FOAF has two called "account") were not: the first was
taken.

**Done, 2026-10-15.** Properties are refused as the other kinds are, and so is a name an object
property and a data property share. What is printed was never ambiguous: a shared label is
written as the prefixed name or IRI.

### 13. Only class expressions are laid out over lines

**What.** *Format* lays out a class expression over lines. A data range stays on one line, and
the button is disabled for it.

## 6. Semantics and validation

### 14. Validation judges only named classes, unions and intersections

**What.** Whether a use of a property lies inside its domain or range is decided for named
classes, unions and intersections. For a restriction, a complement or a list of individuals it
is "cannot tell", and no finding is made.

**Now.** HermiT decides it, and reports an inconsistency or an unsatisfiable class where there is
one.

### 15. Facets and literals are checked for the XML Schema datatypes only

**What.** `expressionCheck.ts` knows which facets the XML Schema and OWL datatypes have, and checks
literals of the datatypes the app has patterns for. A facet on a datatype of another vocabulary,
and a literal of such a datatype, are not checked.

### 16. Punning is warned about, not refused

**What.** A class that the model has only as an individual or a property, and an individual that
it has only as a class, get a warning, since OWL 2 lets one IRI be both. An object property used
as a data property, and a datatype used as a class, are refused: OWL 2 DL does not allow them.

### 17. Disjoint-class expressions are not inherited into *Inferred restrictions*

**What.** A subclass inherits its superclasses' SubClass Of and Equivalent To expressions in that
list, but not their Disjoint With ones. Disjointness is inherited in OWL; the list is of what
members have, and disjointness is what they lack.

### 18. The Structure Explorer compares expressions as written

**What.** Two classes' expressions are compared by their structure. One is never said to be
stronger than another, since that would take reasoning (`compare.ts` says so in its notes).

## 7. Import, export and migration

### 19. Models of format 3 and 4 cannot be opened by an older version of the app

**What.** A model saved now is format 4. An older build reads it without its domains, ranges and
class axioms.

**Data.** Kept in the file. Reading it with this version or later loses nothing. Older formats are
read by this version (`migration.test.ts`: formats 1 and 2 byte for byte, format 3 statement for
statement).

### 20. A format-3 model's disjoint-class expressions stay uneditable until re-imported

**What.** Format 3 had no place for `owl:disjointWith` with an expression, so it kept such a
statement whole with what the model had no place for. Opening that saved model converts its
expression text, not those kept statements.

**Data.** Kept and written back. Exporting and re-importing the ontology makes them axioms.

**Next.** On migration, read the kept statements again with today's reader.

### 21. A named superclass typed as an expression is not drawn until the file is read again

**What.** `SubClass Of: Person`, entered in the expression editor, is stored as a class axiom and
is not drawn as an "is a" line. Read back from the exported file, it becomes the line. A
duplicate of a drawn relationship is not detected either.

**Data.** Changed in how it is held; the ontology says the same.

**Next.** Turn a named class into the line, or refuse it with a pointer to *Asserted
superclasses*.

### 22. JSON-LD exports are checked with the RDF engine, not the OWL API

**What.** The OWL API in the local service does not read JSON-LD. That JSON-LD and Turtle exports
say the same is checked with Oxigraph, statement for statement.

## 8. Verification

### 23. The accessibility audit does not cover the expression dialog (done)

**What.** `e2e/ui-audit.mjs` checks contrast, target size and overflow on a fixed set of screens,
and the expression dialog was not among them.

**Done, 2026-10-15.** The dialog is measured with an error in its text, with an expression read
out in words, as blocks, and the class it defines after it is added, in both themes and at both
window sizes. It found text under 12 pixels (the hint under the text, the *and* between blocks),
which is 12 pixels now. A dialog is measured as a panel of its own: one opened from the side
panel used to count as sticking out of it. The CodeMirror completion list, which is CodeMirror's
own, is not a screen of its own in the audit.

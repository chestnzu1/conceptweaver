# Baselines

What the application does today, measured, so that Phase 1 can be judged against it. Recorded on
2026-10-14 against the application as of commit `d540164`; the measuring was added on top of it,
and no application code changed. Two kinds:

- **Performance** (roadmap task 1.2), with `pnpm bench`: Phase 1's "no task over 100 ms" (NFR-3,
  milestone MS-3) is judged against these numbers.
- **Fidelity** (task 1.3), with the round-trip test: milestone MS-2, "nothing lost" (NFR-1,
  FR-M1-8), is judged against what it records. See *The round trip of the corpus* below.

Companion documents: [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) §8,
[PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) (NFR-1, NFR-3, NFR-4).

**Where.** A 13th Gen Intel Core i9-13900HX (32 logical cores, 55 GB) under WSL2
(Linux 5.15), Node 22.23.2, Chromium headless shell 151. Numbers from another machine, including
the GitHub runner of the weekly benchmark workflow, do not compare with these; compare a machine
with itself over time.

**How.** `pnpm bench` runs the two benchmark tests (`src/model/bench.test.ts`,
`src/structure/bench.test.ts`) and `scripts/main-thread.mjs`, which opens the 2,600-class stress
model in the built app and records every task over 50 ms with the browser's Long Tasks API. It
writes a report to `bench-results/` (not committed). `.github/workflows/benchmarks.yml` runs it
every Monday and on request, and keeps the report as an artifact for 90 days.

## The main thread, 2,600 classes

The stress model of 2,600 classes is 3,839 terms and 10,206 relationships. Each figure is the
longest single task between the action and the page settling, which includes work the action
sets off (the working copy is saved 300 ms after an edit). Three runs on the machine above
agreed to within about 10%.

| Operation | Longest task | Phase 1 target | Long tasks | Blocking time (over 50 ms) | On screen after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Edit: rename a class | **533 ms** | under 100 ms | 3 | 710 ms | 830 ms |
| Reasoner run (Validation → OWL, built-in reasoner) | **357 ms** | under 100 ms | 2 | 364 ms | 545 ms |
| Validation run (Validation → Run all checks) | **386 ms** | under 100 ms | 3 | 578 ms | 837 ms |
| Select a class in the sidebar | 117 ms | (NFR-3: 100 ms) | 1 | 67 ms | 233 ms |
| Open the model (JSON) | 697 ms | (NFR-3: 100 ms) | 2 | 1,282 ms | 1,002 ms |

The edit is close to the roadmap's estimate of about 570 ms, which it puts down to the reasoner
that runs after every edit: the model benchmark below times that reasoner at 472 ms for the
same model, outside the browser. Every operation measured is over the target, by a factor of 3.5
to 5.5 for the three that Phase 1 commits to.

## The model layer and the structure services

The figures that bear most on the targets, from the raw output below:

| Measure | 650 classes | 2,600 classes |
| --- | ---: | ---: |
| Fast reasoner | 115 ms | 472 ms |
| Model checks | 16 ms | 132 ms |
| Import Turtle | 81 ms | 419 ms |
| Export Turtle | 12 ms | 128 ms |
| Network layout | 118 ms | 416 ms |
| Slowest SPARQL query of the set (NOT EXISTS) | 162 ms | 2,248 ms |

| Structure service | 50,000 classes | 200,000 classes |
| --- | ---: | ---: |
| Build the hierarchy, list the top | 157 ms | 629 ms |
| Inferred hierarchy from direct links | 276 ms | 1,412 ms |
| Measure the hierarchy (*Analyze*, in stretches) | 241 ms | 1,029 ms |
| A search | 6.5 ms | 21 ms |

## The round trip of the corpus

`src/model/corpus.test.ts` opens each ontology of the corpus (`corpus/corpus.mjs`, each file at a
fixed version and checked by its SHA-256) as the app opens a file, saves it as Turtle with no
change, and has the OWL service compare the two with the OWL API: axioms by structural equality,
and the ontology's IRI, version IRI, annotations and imports. A statement is *lost* when the
original has it and the saved file does not, *added* the other way round. The complete lists are
in `corpus/expected/`, and the test fails when one changes, so that every fix (or new loss)
shows as a change there; `pnpm exec vitest run src/model/corpus.test.ts -u` records it.

| Ontology | Read as | Axioms, original → saved | Lost | Added | Said to be left out on opening |
| --- | --- | ---: | ---: | ---: | --- |
| Pizza (2016) | RDF/XML | 801 → 1,175 | 72 | 436 | nothing |
| Wine | RDF/XML | 747 → 1,899 | 96 | 1,246 | nothing |
| Koala | RDF/XML | 70 → 107 | 0 | 38 | nothing |
| PROV-O | Turtle | 973 → 958 | 95 | 76 | 13 property chains, 8 annotations on an axiom |
| SKOS | RDF/XML | 205 → 146 | 69 | 4 | nothing |
| OWL-Time | Turtle | 1,064 → 971 | 151 | 37 | nothing |
| FOAF | RDF/XML | 551 → 472 | 239 | 159 | nothing |
| OWL 2 Primer example | RDF/XML | 93 → 95 | 36 | 39 | 2 property chains, 1 key, 1 annotation on an axiom, 3 negative property assertions |
| Relation Ontology, core | RDF/XML | 372 → 358 | 37 | 21 | 2 property chains, 2 annotations on an axiom, 4 SWRL rules |
| **All nine** | | | **795** | **2,056** | at most 36 of the lost |

**Since then.** Task 1.4 (stable identity, the same day) changed one line: FOAF has two object
properties labelled "account" (`foaf:account`, `foaf:holdsAccount`), and the reader kept only the
first. Both are kept now, and FOAF loses 234 statements and gains 161 (551 → 479 axioms); over
the nine, 790 are lost and 2,058 added. `corpus/expected/foaf.txt` shows the difference.

Only Koala comes back with nothing lost. What is lost, by cause, from the lists:

- **Changed, not dropped.** Every `rdfs:comment` on an entity comes back as `skos:definition`,
  and an annotation property the app does not know may come back under the ontology's own
  namespace (FOAF's `vs:term_status` as `:termStatus`). Each such statement counts once as lost
  and once as added. It is most of the annotations OWL-Time and RO lose, and about half of what
  FOAF and PROV-O lose.
- **The ontology's own header.** Version IRIs (Pizza, OWL-Time, RO), and annotations of the
  ontology beyond its name and description: `owl:versionInfo`, creators, contributors, licence,
  change notes.
- **Constructs the app names when it leaves them out:** property chains, keys, negative property
  assertions, SWRL rules, annotations on axioms.
- **Constructs it leaves out without a word:**
  - Wine's 61 classes defined by an `owl:intersectionOf` stated on the class itself (an
    equivalent class in RDF/XML's short form). The README says other class expressions are kept
    as text; these are not.
  - A property typed only by a characteristic (`owl:TransitiveProperty`, `owl:SymmetricProperty`
    and the like, without `owl:ObjectProperty`) is not taken for a property, and goes with all
    that is said of it (the Primer loses five this way).
  - Datatype definitions, `owl:sameAs`, class assertions of a class expression (Primer),
    sub-property axioms between annotation properties (SKOS), `rdfs:isDefinedBy` (SKOS, PROV-O).
- **Restated.** Disjointness and difference among more than two come back as pairs: Pizza's 9
  `DisjointClasses` as 393, Wine's five `AllDifferent` as 829 `DifferentIndividuals`. The meaning is
  the same; the axioms are not, and an editor of the file sees a different ontology.
- **Added.** Every entity is given an `rdfs:label` from its name, and a declaration where the
  original, in the style of OWL 1, used an entity without one (Koala's and Wine's individuals,
  the classes Wine takes from Food).

## Raw output of the benchmarks

### Main thread in the browser (scripts/main-thread.mjs)

The longest task over 50 ms while the operation runs and the page settles. Phase 1's target: under 100 ms for an edit, a reasoner run and a validation run.

```
Main thread, 2600 classes, Chromium 151.0.7922.34, 2026-10-14T09:10:30.519Z
operation                                     longest task  long tasks  blocking (>50 ms)  on screen after
open model.txt.2600.json                            697 ms           2            1282 ms          1002 ms
select a class (sidebar)                            117 ms           1              67 ms           233 ms
edit: rename the class                              533 ms           3             710 ms           830 ms
reasoner run (OWL checks, built-in reasoner)        357 ms           2             364 ms           545 ms
validation run (all checks)                         386 ms           3             578 ms           837 ms
```

### Model layer (src/model/bench.test.ts)

```
  350 classes  generate + hierarchy layout            16 ms
  350 classes  = 517 terms, 1373 relationships, 39 object properties
  350 classes  object properties (analysis)            3 ms
  350 classes  restrictions of every class             2 ms
  350 classes  model checks                           13 ms
  350 classes  reasoner                               72 ms
  350 classes  = 665 check results; reasoner: 840 stated, 5240 inferred, 4953 shown, 18 conflicts
      conflict: Inconsistent: “Individual 5” is an instance of both “Class 3” and “Class 4”, which cannot share members. | “Individual 5” is an instance of “Class 244”; “Class 244” is a kind of “Class 225”; “Class 225” is a kind of “Class 203”; “Class 203” is a kind of “Class 168”; 
      conflict: Inconsistent: “Individual 17” is an instance of both “Class 3” and “Class 4”, which cannot share members. | “Individual 105” relates 26 “Individual 17”; “relates 26” is the inverse of “relates 27”; “relates 27” applies to “Class 8”; “Class 8” is a kind of “Class 7”; “
      conflict: Inconsistent: “Individual 23” is an instance of both “Class 3” and “Class 4”, which cannot share members. | “Individual 23” is an instance of “Class 243”; “Class 243” is a kind of “Class 193”; “Class 193” is a kind of “Class 137”; “Class 137” is a kind of “Class 45”; 
      conflict: Inconsistent: “Individual 29” is an instance of both “Class 3” and “Class 4”, which cannot share members. | “Individual 95” relates 26 “Individual 29”; “relates 26” is the inverse of “relates 27”; “relates 27” applies to “Class 8”; “Class 8” is a kind of “Class 7”; “C
  350 classes  hierarchy layout                        7 ms
  350 classes  network layout                        115 ms
  350 classes  export Turtle                          12 ms
  350 classes  = Turtle: 2749 lines, 136 KB
  350 classes  export JSON-LD                         11 ms
  350 classes  triples table                          57 ms
  350 classes  import Turtle                          54 ms
  350 classes  = re-imported: 517 terms, 1373 relationships
  350 classes  JSON save                               1 ms
  350 classes  = JSON: 278 KB
  350 classes  JSON open                               8 ms
  350 classes  SPARQL all classes with labels                          15 ms  350 rows
  350 classes  SPARQL transitive ancestors (path +)                    49 ms  3856 rows
  350 classes  SPARQL count descendants per class                      17 ms  20 rows
  350 classes  SPARQL restrictions inherited through the hierarchy     98 ms  8717 rows
  350 classes  SPARQL individuals by inferred type (path)              16 ms  20 rows
  350 classes  SPARQL classes with no restriction (NOT EXISTS)         49 ms  129 rows
  350 classes  SPARQL two-hop facts between individuals                13 ms  662 rows
  350 classes  SPARQL union + optional + aggregate                      8 ms  39 rows
  350 classes  SPARQL construct the whole hierarchy                    10 ms  363 rows

  650 classes  generate + hierarchy layout            15 ms
  650 classes  = 960 terms, 2553 relationships, 72 object properties
  650 classes  object properties (analysis)            5 ms
  650 classes  restrictions of every class             2 ms
  650 classes  model checks                           16 ms
  650 classes  reasoner                              115 ms
  650 classes  = 1356 check results; reasoner: 1556 stated, 10149 inferred, 9620 shown, 0 conflicts
  650 classes  hierarchy layout                       10 ms
  650 classes  network layout                        118 ms
  650 classes  export Turtle                          12 ms
  650 classes  = Turtle: 5099 lines, 252 KB
  650 classes  export JSON-LD                         15 ms
  650 classes  triples table                          73 ms
  650 classes  import Turtle                          81 ms
  650 classes  = re-imported: 960 terms, 2552 relationships
  650 classes  JSON save                               1 ms
  650 classes  = JSON: 515 KB
  650 classes  JSON open                              13 ms
  650 classes  SPARQL all classes with labels                          17 ms  650 rows
  650 classes  SPARQL transitive ancestors (path +)                    73 ms  7434 rows
  650 classes  SPARQL count descendants per class                      26 ms  20 rows
  650 classes  SPARQL restrictions inherited through the hierarchy    165 ms  15264 rows
  650 classes  SPARQL individuals by inferred type (path)              21 ms  20 rows
  650 classes  SPARQL classes with no restriction (NOT EXISTS)        162 ms  252 rows
  650 classes  SPARQL two-hop facts between individuals                29 ms  1249 rows
  650 classes  SPARQL union + optional + aggregate                     12 ms  72 rows
  650 classes  SPARQL construct the whole hierarchy                    18 ms  675 rows

 1300 classes  generate + hierarchy layout            23 ms
 1300 classes  = 1920 terms, 5106 relationships, 144 object properties
 1300 classes  object properties (analysis)            6 ms
 1300 classes  restrictions of every class             3 ms
 1300 classes  model checks                           56 ms
 1300 classes  reasoner                              216 ms
 1300 classes  = 2888 check results; reasoner: 3112 stated, 19417 inferred, 18457 shown, 2 conflicts
      conflict: Inconsistent: “Individual 54” is an instance of both “Class 15” and “Class 16”, which cannot share members. | “Individual 54” relates 46 “Individual 276”; “relates 46” is the inverse of “relates 47”; “relates 47” points to “Class 15”; “Individual 54” is an instance of “
      conflict: Inconsistent: “Individual 428” is an instance of both “Class 15” and “Class 16”, which cannot share members. | “Individual 428” relates 76 “Individual 245”; “relates 76” is the inverse of “relates 77”; “relates 77” is symmetric; “relates 77” applies to “Class 28”; “Class
 1300 classes  hierarchy layout                       20 ms
 1300 classes  network layout                        227 ms
 1300 classes  export Turtle                          35 ms
 1300 classes  = Turtle: 10179 lines, 511 KB
 1300 classes  export JSON-LD                         37 ms
 1300 classes  triples table                         129 ms
 1300 classes  import Turtle                         188 ms
 1300 classes  = re-imported: 1920 terms, 5106 relationships
 1300 classes  JSON save                               2 ms
 1300 classes  = JSON: 1032 KB
 1300 classes  JSON open                              31 ms
 1300 classes  SPARQL all classes with labels                          35 ms  1300 rows
 1300 classes  SPARQL transitive ancestors (path +)                   143 ms  13744 rows
 1300 classes  SPARQL count descendants per class                      50 ms  20 rows
 1300 classes  SPARQL restrictions inherited through the hierarchy    226 ms  20342 rows
 1300 classes  SPARQL individuals by inferred type (path)              39 ms  20 rows
 1300 classes  SPARQL classes with no restriction (NOT EXISTS)        587 ms  510 rows
 1300 classes  SPARQL two-hop facts between individuals                53 ms  2448 rows
 1300 classes  SPARQL union + optional + aggregate                     27 ms  144 rows
 1300 classes  SPARQL construct the whole hierarchy                    38 ms  1350 rows

 2600 classes  generate + hierarchy layout            46 ms
 2600 classes  = 3839 terms, 10206 relationships, 289 object properties
 2600 classes  object properties (analysis)           10 ms
 2600 classes  restrictions of every class             7 ms
 2600 classes  model checks                          132 ms
 2600 classes  reasoner                              472 ms
 2600 classes  = 5766 check results; reasoner: 6224 stated, 39032 inferred, 37127 shown, 91 conflicts
      conflict: Inconsistent: “Individual 29” is an instance of both “Class 25” and “Class 26”, which cannot share members. | “Individual 29” relates 286 “Individual 132”; “relates 286” is the inverse of “relates 287”; “relates 287” points to “Class 25”; “Individual 29” is an instance 
      conflict: Inconsistent: “Individual 30” is an instance of both “Class 29” and “Class 30”, which cannot share members. | “Individual 615” relates 196 “Individual 30”; “relates 196” is the inverse of “relates 197”; “relates 197” applies to “Class 86”; “Class 86” is a kind of “Class
      conflict: Inconsistent: “Individual 33” is an instance of both “Class 25” and “Class 26”, which cannot share members. | “Individual 33” relates 286 “Individual 136”; “relates 286” is the inverse of “relates 287”; “relates 287” points to “Class 25”; “Individual 33” relates 146 “In
      conflict: Inconsistent: “Individual 37” is an instance of both “Class 23” and “Class 24”, which cannot share members. | “Individual 475” relates 276 “Individual 37”; “relates 276” is the inverse of “relates 277”; “relates 277” is a sub-property of “relates 276”; “relates 277” poi
 2600 classes  hierarchy layout                       38 ms
 2600 classes  network layout                        416 ms
 2600 classes  export Turtle                         128 ms
 2600 classes  = Turtle: 20338 lines, 1031 KB
 2600 classes  export JSON-LD                        134 ms
 2600 classes  triples table                         278 ms
 2600 classes  import Turtle                         419 ms
 2600 classes  = re-imported: 3839 terms, 10206 relationships
 2600 classes  JSON save                               5 ms
 2600 classes  = JSON: 2070 KB
 2600 classes  JSON open                              80 ms
 2600 classes  SPARQL all classes with labels                         116 ms  2600 rows
 2600 classes  SPARQL transitive ancestors (path +)                   345 ms  27593 rows
 2600 classes  SPARQL count descendants per class                     131 ms  20 rows
 2600 classes  SPARQL restrictions inherited through the hierarchy    541 ms  50986 rows
 2600 classes  SPARQL individuals by inferred type (path)             108 ms  20 rows
 2600 classes  SPARQL classes with no restriction (NOT EXISTS)       2248 ms  1046 rows
 2600 classes  SPARQL two-hop facts between individuals               142 ms  5000 rows
 2600 classes  SPARQL union + optional + aggregate                     84 ms  289 rows
 2600 classes  SPARQL construct the whole hierarchy                    94 ms  2696 rows
```

### Structure services (src/structure/bench.test.ts)

```
  10000 classes  generate                                                 4.2 ms  
  10000 classes  first question: build the hierarchy, list the top         38 ms  25 at the top
  10000 classes  subclasses of a class                                    0.0 ms  0 subclasses
  10000 classes  narrow to a search, first time                           2.4 ms  111 found
  10000 classes  narrow to the same search again                          0.0 ms  
  10000 classes  find classes by text                                     1.1 ms  11 found
  10000 classes  ways down to a deep class (12)                           0.3 ms  4 ways, the first 20 long
  10000 classes  inferred hierarchy from direct links: build, list the top      63 ms  
  10000 classes  sum up a class at the top (first: works out depths)       22 ms  0 below it
  10000 classes  sum up a deep class                                      0.2 ms  levels 20 to 22
  10000 classes  compare two deep classes                                 1.7 ms  58 superclasses between them
  10000 classes  measure the hierarchy                                     46 ms  deepest level 39, in 3 stretches
  10000 classes  measure it again (kept)                                  0.0 ms  
  10000 classes  the classes behind a number                              2.2 ms  4015 leaves
  10000 classes  open the hierarchy wide, to 10,000 lines                  23 ms  5512 branches open, 30 questions
  10000 classes  the lines to draw for that                                14 ms  10000 lines

  50000 classes  generate                                                  27 ms  
  50000 classes  first question: build the hierarchy, list the top        157 ms  125 at the top
  50000 classes  subclasses of a class                                    0.1 ms  1 subclasses
  50000 classes  narrow to a search, first time                           6.5 ms  111 found
  50000 classes  narrow to the same search again                          0.0 ms  
  50000 classes  find classes by text                                     4.0 ms  111 found
  50000 classes  ways down to a deep class (12)                           0.1 ms  1 ways, the first 20 long
  50000 classes  inferred hierarchy from direct links: build, list the top     276 ms  
  50000 classes  sum up a class at the top (first: works out depths)      125 ms  4 below it
  50000 classes  sum up a deep class                                      0.2 ms  levels 20 to 20
  50000 classes  compare two deep classes                                 0.5 ms  39 superclasses between them
  50000 classes  measure the hierarchy                                    241 ms  deepest level 39, in 13 stretches
  50000 classes  measure it again (kept)                                  0.1 ms  
  50000 classes  the classes behind a number                              6.5 ms  19683 leaves
  50000 classes  open the hierarchy wide, to 10,000 lines                  19 ms  5047 branches open, 28 questions
  50000 classes  the lines to draw for that                               7.7 ms  10001 lines

 200000 classes  generate                                                 144 ms  
 200000 classes  first question: build the hierarchy, list the top        629 ms  500 at the top
 200000 classes  subclasses of a class                                    0.0 ms  0 subclasses
 200000 classes  narrow to a search, first time                            21 ms  1111 found
 200000 classes  narrow to the same search again                          0.1 ms  
 200000 classes  find classes by text                                     7.5 ms  1111 found
 200000 classes  ways down to a deep class (12)                           0.1 ms  2 ways, the first 11 long
 200000 classes  inferred hierarchy from direct links: build, list the top    1412 ms  
 200000 classes  sum up a class at the top (first: works out depths)      526 ms  0 below it
 200000 classes  sum up a deep class                                      0.1 ms  levels 11 to 13
 200000 classes  compare two deep classes                                 0.4 ms  33 superclasses between them
 200000 classes  measure the hierarchy                                   1029 ms  deepest level 38, in 50 stretches
 200000 classes  measure it again (kept)                                  0.0 ms  
 200000 classes  the classes behind a number                               34 ms  78892 leaves
 200000 classes  open the hierarchy wide, to 10,000 lines                  28 ms  5044 branches open, 29 questions
 200000 classes  the lines to draw for that                               9.4 ms  10005 lines

  10000 classes  inferred hierarchy from every entailed link              123 ms  202176 links given

  30000 classes  inferred hierarchy from every entailed link              547 ms  627734 links given

    650 classes  generate a model (with its layout)                        18 ms  960 terms, 2553 relationships
    650 classes  first question: read the model, build the hierarchy       10 ms  
    650 classes  measure the asserted hierarchy (asks the fast reasoner)     277 ms  reasoner: current
    650 classes  inferred hierarchy, list the top                         0.1 ms  current, 8 at the top
    650 classes  sum up a class (asserted and inferred parts)             0.1 ms  

   2600 classes  generate a model (with its layout)                        71 ms  3839 terms, 10206 relationships
   2600 classes  first question: read the model, build the hierarchy       36 ms  
   2600 classes  measure the asserted hierarchy (asks the fast reasoner)     547 ms  reasoner: inconsistent
   2600 classes  inferred hierarchy, list the top                         0.0 ms  inconsistent, 0 at the top
   2600 classes  sum up a class (asserted and inferred parts)             0.1 ms  

   5200 classes  generate a model (with its layout)                       125 ms  7677 terms, 20406 relationships
   5200 classes  first question: read the model, build the hierarchy       55 ms  
   5200 classes  measure the asserted hierarchy (asks the fast reasoner)    1387 ms  reasoner: inconsistent
   5200 classes  inferred hierarchy, list the top                         0.0 ms  inconsistent, 0 at the top
   5200 classes  sum up a class (asserted and inferred parts)             0.1 ms
```

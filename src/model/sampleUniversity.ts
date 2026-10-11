import { parseOutline } from './bulk';
import { hierarchyLayout } from './layout';
import { emptyModel, newRelation, newTerm, type Model, type ObjProp, type Quantifier } from './types';

const CLASSES = `Agent
  Person
    Student
      Undergraduate student
      Graduate student
        MSc student
        PhD candidate
      Exchange student
    Employee
      Academic staff
        Professor
          Full professor
          Associate professor
          Assistant professor
        Lecturer
        Postdoctoral researcher
        Teaching assistant
      Support staff
        Administrator
        Librarian
        Technician
    Alumnus
    Visiting scholar
  Organisation
    University
    Academic unit
      Faculty
      Department
      Institute
      Research group
    Funding body
    Company
    Publisher
Educational offering
  Programme
    BSc programme
    MSc programme
    PhD programme
  Course
    Lecture course
    Seminar
    Laboratory course
    Thesis project
  Course edition
Assessment
  Exam
    Written exam
    Oral exam
  Assignment
  Thesis
    BSc thesis
    MSc thesis
    Doctoral dissertation
Research output
  Publication
    Journal article
    Conference paper
    Book
    Book chapter
    Technical report
  Dataset
  Software
  Patent
Research project
  Funded project
  Internal project
Grant
Place
  Campus
  Building
    Library
    Laboratory building
  Room
    Lecture hall
    Office
    Laboratory
Academic period
  Academic year
  Semester
Research field
Degree
  BSc degree
  MSc degree
  Doctorate`;

/** name | description | characteristics | inverse | parent | domain | range ("" leaves domain and range to follow use) */
const OBJECT_PROPERTIES = `member of | Belongs to an organisation in any capacity. | | | | Person | Organisation
employed by | Has a contract of employment with. | | | member of | |
enrolled in | Is registered as a student of a programme. | | | | Student | Programme
takes | Attends an edition of a course. | | | | Student | Course edition
teaches | Gives an edition of a course. | | taught by | | Academic staff | Course edition
taught by | | | teaches | | |
edition of | The course this edition is a run of. | functional | | | Course edition | Course
part of | Is a component of a larger whole. | transitive | has part | | |
has part | | transitive | part of | | |
located in | Is physically inside. | transitive | | | Place | Place
supervises | Guides the research or thesis work of. | asymmetric,irreflexive | supervised by | | Academic staff | Student
supervised by | | | supervises | | |
authored by | Was written or created by. | | author of | | Research output | Person
author of | | | authored by | | |
published by | | functional | | | Publication | Publisher
cites | Refers to another publication. | | | | Publication | Publication
funded by | | | | | Research project | Funding body
participates in | Takes part in a research project. | | | | Person | Research project
leads | Is the principal investigator of. | | | participates in | |
collaborates with | Works together with. | symmetric | | | Person | Person
has prerequisite | Must be completed first. | transitive,asymmetric | | | Course | Course
awards | The degree a programme leads to. | | | | Programme | Degree
has field | The research field something is about. | | | | |
takes place in | | | | | Course edition | Room
held during | | functional | | | Course edition | Academic period
assessed by | | | | | Course | Assessment`;

/** from | property | to | quantifier | n — relationships between classes; with a declared property each is a restriction. */
const CLASS_RELATIONS = `Student | enrolled in | Programme | some
Student | takes | Course edition | some
Academic staff | teaches | Course edition | some
Course edition | edition of | Course | exactly | 1
Course edition | takes place in | Room | some
Course edition | held during | Semester | exactly | 1
Employee | employed by | Organisation | some
Department | part of | Faculty | some
Faculty | part of | University | exactly | 1
Research group | part of | Department | some
Institute | part of | University | some
Room | located in | Building | exactly | 1
Building | located in | Campus | some
PhD candidate | supervised by | Professor | min | 1
Professor | supervises | PhD candidate | some
Publication | authored by | Person | min | 1
Journal article | published by | Publisher | some
Book | published by | Publisher | some
Publication | cites | Publication | only
Funded project | funded by | Funding body | some
Research project | has field | Research field | some
Course | has field | Research field | some
Professor | leads | Research project | some
PhD candidate | participates in | Research project | some
BSc programme | awards | BSc degree | only
MSc programme | awards | MSc degree | only
PhD programme | awards | Doctorate | only
Course | has prerequisite | Course | only
Course | assessed by | Assessment | some
Thesis project | assessed by | Thesis | only
Alumnus | graduated from | University
Company | sponsors | Research project
Librarian | works at | Library
Visiting scholar | hosted by | Academic unit`;

/** name | datatype | description | attached to (comma-separated) | domain set by hand */
const DATA_PROPERTIES = `Full name | xsd:string | The name a person is formally known by. | Person |
Birth date | xsd:date | | Person |
Email | xsd:string | Contact address. | Person, Organisation | Agent
Student number | xsd:string | | Student |
Enrolment date | xsd:date | | Student |
Employee number | xsd:string | | Employee |
Salary scale | xsd:integer | | Employee |
Start date | xsd:date | When an appointment or project begins. | Employee, Research project |
End date | xsd:date | | Research project |
Budget | xsd:decimal | Total budget in euros. | Research project, Grant |
Course code | xsd:string | | Course |
Credits | xsd:integer | Study load in ECTS. | Course, Programme |
Title | rdf:langString | | Course, Publication, Thesis |
Capacity | xsd:integer | Maximum number of participants or seats. | Course edition, Room |
Publication year | xsd:gYear | | Publication |
DOI | xsd:anyURI | | Publication, Dataset |
Room number | xsd:string | | Room |
Exam date | xsd:dateTime | | Exam |
Duration | xsd:duration | | Exam |
Founded | xsd:gYear | | Organisation |
Peer reviewed | xsd:boolean | | Publication |`;

/** individual | type */
const INDIVIDUALS = `Northfield University | University
Faculty of Science | Faculty
Department of Computer Science | Department
Data Systems Group | Research group
National Science Fund | Funding body
Meridian Press | Publisher
Ada Moreno | Full professor
Ben Okafor | Assistant professor
Chloe Tan | PhD candidate
David Kim | MSc student
Elena Rossi | Postdoctoral researcher
Farid Haddad | Undergraduate student
Gita Novak |
MSc Computer Science | MSc programme
Databases | Lecture course
Advanced Databases | Lecture course
Distributed Systems | Seminar
Databases autumn 2026 | Course edition
Autumn 2026 | Semester
Hall A1 | Lecture hall
Science Building | Building
North Campus | Campus
Project Atlas | Funded project
Indexing at Scale | Journal article
Query Planning Revisited | Conference paper`;

/** subject | property | object — facts about individuals, chosen so that the reasoner has something to do */
const FACTS = `Faculty of Science | part of | Northfield University
Department of Computer Science | part of | Faculty of Science
Data Systems Group | part of | Department of Computer Science
Ada Moreno | employed by | Department of Computer Science
Ben Okafor | employed by | Department of Computer Science
Ada Moreno | supervises | Chloe Tan
Gita Novak | supervises | David Kim
Ada Moreno | collaborates with | Elena Rossi
Ada Moreno | leads | Project Atlas
Chloe Tan | participates in | Project Atlas
Project Atlas | funded by | National Science Fund
Advanced Databases | has prerequisite | Databases
Distributed Systems | has prerequisite | Advanced Databases
Databases autumn 2026 | edition of | Databases
Databases autumn 2026 | held during | Autumn 2026
Databases autumn 2026 | takes place in | Hall A1
Ben Okafor | teaches | Databases autumn 2026
David Kim | takes | Databases autumn 2026
Farid Haddad | takes | Databases autumn 2026
David Kim | enrolled in | MSc Computer Science
Hall A1 | located in | Science Building
Science Building | located in | North Campus
Indexing at Scale | authored by | Ada Moreno
Indexing at Scale | authored by | Chloe Tan
Indexing at Scale | published by | Meridian Press
Query Planning Revisited | authored by | Elena Rossi
Query Planning Revisited | cites | Indexing at Scale`;

const rows = (text: string) => text.split('\n').map((line) => line.split('|').map((c) => c.trim()));

/**
 * A larger example: a university ontology with about 85 classes in a hierarchy up to six
 * levels deep, 26 object properties (with characteristics, inverses and sub-properties),
 * 21 data properties, restrictions on classes, a few disjoint classes, some relationships
 * left unclassified, and 25 individuals with facts for the reasoner to work on.
 */
export function universitySample(): Model {
  const m = emptyModel('University ontology');
  m.description = 'A larger example ontology about a university: people, organisation, teaching and research.';
  m.lang = 'en';
  m.vocab.enabled = true;
  const id: Record<string, string> = {};
  const term = (name: string, patch: Parameters<typeof newTerm>[0] = {}) => {
    const t = newTerm({ name, ...patch });
    id[name] = t.id;
    m.terms.push(t);
    return t;
  };
  const rel = (from: string, to: string, patch: Partial<ReturnType<typeof newRelation>> = {}) => {
    if (!id[from] || !id[to]) throw new Error(`University sample: unknown term in ${from} -> ${to}`);
    m.relations.push(newRelation({ from: id[from], to: id[to], ...patch }));
  };

  const outline = parseOutline(CLASSES);
  const palette: Record<string, string> = { Agent: 'blue', 'Educational offering': 'green', Assessment: 'amber', 'Research output': 'purple', 'Research project': 'teal', Place: 'pink' };
  for (const name of outline.terms) term(name);
  for (const r of outline.rels) rel(r.from, r.to, { kind: 'generalization' });
  // Colour each branch after its top class.
  const parentOf = new Map(outline.rels.map((r) => [r.from, r.to]));
  for (const t of m.terms) {
    let top = t.name;
    while (parentOf.has(top)) top = parentOf.get(top)!;
    t.color = palette[top] ?? '';
  }
  // A few classes sit under two parents.
  rel('PhD candidate', 'Academic staff', { kind: 'generalization' });
  rel('Teaching assistant', 'Graduate student', { kind: 'generalization' });
  rel('Doctoral dissertation', 'Publication', { kind: 'generalization' });
  m.terms.find((t) => t.name === 'Person')!.description = 'A human being with a role at or around the university.';
  m.terms.find((t) => t.name === 'Course edition')!.description = 'One run of a course in a particular academic period.';
  m.terms.find((t) => t.name === 'PhD candidate')!.description = 'A doctoral researcher, who is both a student and a member of academic staff.';

  for (const [name, description, chars, inverseOf, parent, domain, range] of rows(OBJECT_PROPERTIES)) {
    const p: ObjProp = { name, description, chars: chars ? chars.split(',') : [] };
    if (inverseOf) p.inverses = [inverseOf];
    if (parent) p.parents = [parent];
    if (domain) p.domain = [id[domain]];
    if (range) p.range = [id[range]];
    m.props.push(p);
  }
  for (const [from, label, to, quantifier, n] of rows(CLASS_RELATIONS)) {
    rel(from, to, { label, ...(quantifier && quantifier !== 'some' ? { restriction: quantifier as Quantifier } : {}), ...(n ? { restrictionN: Number(n) } : {}) });
  }

  for (const [name, range, description, owners, domain] of rows(DATA_PROPERTIES)) {
    term(name, { type: 'property', range, description, ...(domain ? { domain: [id[domain]] } : {}) });
    for (const owner of owners.split(',')) rel(owner.trim(), name, { kind: 'property' });
  }

  // A class that has a data property is restricted by it ("some" unless said otherwise):
  // an edition has exactly one capacity, a person at least one full name.
  const attach = (owner: string, property: string) => m.relations.find((r) => r.from === id[owner] && r.to === id[property])!;
  Object.assign(attach('Course edition', 'Capacity'), { restriction: 'exactly', restrictionN: 1 });
  Object.assign(attach('Person', 'Full name'), { restriction: 'min', restrictionN: 1 });

  rel('Person', 'Organisation', { predicate: 'owl:disjointWith' });
  rel('Undergraduate student', 'Graduate student', { predicate: 'owl:disjointWith' });
  rel('Written exam', 'Oral exam', { predicate: 'owl:disjointWith' });
  rel('Place', 'Agent', { predicate: 'owl:disjointWith' });

  for (const [name, type] of rows(INDIVIDUALS)) {
    term(name, { type: 'instance' });
    if (type) rel(name, type, { kind: 'generalization' });
  }
  for (const [subject, label, object] of rows(FACTS)) rel(subject, object, { label });

  const pos = hierarchyLayout(m);
  for (const t of m.terms) Object.assign(t, pos.get(t.id));
  return m;
}

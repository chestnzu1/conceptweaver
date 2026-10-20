/**
 * The mapping core (roadmap task 2.4, ADR-019): how rows of named columns become entities of an
 * ontology. It does not know where the rows came from (a CSV file, a sheet of a workbook, or, at
 * stage DI-2, the rows of a database table), so that file import and database mapping use one
 * implementation: IRI templates, column rules, value conversion, and a preview that says, row by
 * row, what would be made, what would not, and why. Everything here is plain data.
 */

/** Rows of named columns, wherever they came from. */
export interface Table {
  columns: string[];
  rows: string[][];
  /** For each row, the number its source knows it by: the line of a file, the row of a sheet. */
  rowNumbers: number[];
}

/** What each row makes: a class (in a SKOS-like vocabulary, a concept), or an individual. */
export type RowKind = 'class' | 'individual';

/** What a column's values become. A column with no rule is left out. */
export type ColumnUse =
  /** The entity's name (its label). */
  | { as: 'name' }
  /** A superclass (in a vocabulary, a broader concept): another row, or an entity of the model. */
  | { as: 'parent' }
  /** For an individual: a class it is an instance of. */
  | { as: 'type' }
  | { as: 'description'; lang?: string }
  | { as: 'synonyms'; lang?: string }
  /** An annotation, by the property's prefixed name or IRI (skos:notation, rdfs:seeAlso). */
  | { as: 'annotation'; property: string; lang?: string }
  /** For an individual: a value of a data property (by its IRI), converted to the property's datatype or the one given. */
  | { as: 'value'; property: string; datatype?: string }
  /** A link by an object property (by its IRI) to another row or an entity of the model. */
  | { as: 'link'; property: string };

export interface TabularMapping {
  rows: RowKind;
  /** For individuals: the class each is an instance of, unless a column says (by IRI). */
  classIri?: string;
  /**
   * What each row's IRI is: text with placeholders for columns. {Code} is the value as written,
   * with what an IRI cannot hold percent-encoded; {Name:name} is the value made into a name, as
   * the editor makes an IRI from a name ("Running time" becomes RunningTime).
   */
  iri: string;
  /** The column whose values a reference (a parent, a class, a link) is first looked for among. */
  key?: string;
  /** What separates several values in one cell, for the columns that may have several ("; "). None: one value a cell. */
  split?: string;
  /**
   * Update mode (FR-M7-6): a row whose IRI the model has already is matched to that entity, and
   * what its columns say replaces what the entity said about those fields. A row whose IRI the
   * model does not have is made, as in an ordinary import. Off: such rows are left as they are.
   */
  update?: true;
  /** What each column becomes, by its name. */
  columns: Record<string, ColumnUse>;
}

/** One thing an update would change about an entity, as it was and as the row would leave it. */
export interface RowChange {
  /** What is changed: the name, the description, a superclass, an annotation, a value, a link. */
  what: string;
  from: string;
  to: string;
}

/** What becomes of one row. */
export interface RowOutcome {
  /** The number its source knows it by. */
  row: number;
  /**
   * create: it is made. update: the model has it, and the row changes it. unchanged: the model has
   * it and already says what the row says. exists: the model has its IRI, and it is left as it is
   * (an import that does not update). skip: nothing is made of it.
   */
  status: 'create' | 'update' | 'unchanged' | 'exists' | 'skip';
  iri?: string;
  name?: string;
  /** Why it is skipped, or what it is in the model already. */
  reason?: string;
  /** For an update: each change, in the order they are applied. */
  changes?: RowChange[];
  /** Values of a row that is made or changed but that are left out, each with why. */
  notes: string[];
}

/** Something a row refers to: another row of the table, by its index, or an entity, by its IRI. */
export type Reference = { row: number } | { iri: string };

/** What an update replaces with what the columns say. The rest of the entity is left alone. */
export interface Replaced {
  /** The description, with its language. */
  description?: true;
  /** The synonyms in the column's language (the model's own, or the language given). */
  synonyms?: true;
  /** Annotation properties: every field of each is replaced by what the file says. */
  annotations: string[];
  /** Data properties, by IRI: every value of each is replaced. */
  values: string[];
  /** Object properties, by IRI: every link by each is replaced. */
  links: string[];
  /** Superclasses (for a class) or classes (for an individual). */
  parents?: true;
}

/** An entity a row makes, with what it says, ready to be added; or the entity it updates. */
export interface PlannedEntity {
  /** Index of its row in the table. */
  index: number;
  iri: string;
  name: string;
  kind: RowKind;
  /** For an update: the id of the term it changes. Absent: the entity is made. */
  target?: string;
  /** For an update: set the name to the row's. Absent or true for an entity that is made. */
  setName?: boolean;
  /** For an update: what the row replaces; what it does not say stays as it was. */
  replace?: Replaced;
  /** Superclasses (for a class) or classes (for an individual). */
  parents: Reference[];
  description?: { value: string; lang?: string };
  synonyms?: { value: string; lang?: string };
  annotations: { property: string; value: string; lang?: string }[];
  /** Data property values, by the property's IRI, converted. */
  values: { property: string; value: string; datatype?: string; lang?: string }[];
  links: { property: string; to: Reference }[];
}

/** What an import would do: row by row, and the entities it would make and change. */
export interface Plan {
  rows: RowOutcome[];
  entities: PlannedEntity[];
  counts: { create: number; update: number; unchanged: number; exists: number; skip: number; notes: number };
}

import { baseIriOf } from '../model/iri';
import type { ColumnUse, TabularMapping } from '../mapping/contracts';
import type { Model } from '../model/types';

/**
 * A first mapping for a table, from what its columns are called: a code or id for the IRI, a
 * name or label, a parent or broader, a description, synonyms; and a column called as one of the
 * model's properties for that property. Everything else is left out until it is given a use.
 */
export function guessMapping(columns: string[], model: Model): TabularMapping {
  const find = (re: RegExp) => columns.find((c) => re.test(c.trim()));
  const code = find(/^(code|id|identifier|key|notation|nr|no\.?|number|sku|ref(erence)?)$/i);
  const name = find(/^(name|label|title|pref ?label|preferred ?(label|name)|term|concept|naam|nom|titel)$/i) ?? columns.find((c) => c !== code);
  const parent = find(/^(parent|broader|super ?class|parent ?(code|id|name|class)|is ?a|subclass ?of)$/i);
  const description = find(/^(description|definition|comment|desc|scope ?note)$/i);
  const synonyms = find(/^(synonyms?|alt(ernative)? ?labels?|aliases?|also ?known ?as)$/i);
  const uses: Record<string, ColumnUse> = {};
  if (name) uses[name] = { as: 'name' };
  if (parent) uses[parent] = { as: 'parent' };
  if (description) uses[description] = { as: 'description' };
  if (synonyms) uses[synonyms] = { as: 'synonyms' };
  // A column called as one of the model's properties: values of a data property, links by an object property.
  const lower = (s: string) => s.trim().toLowerCase();
  for (const c of columns) {
    if (uses[c] || c === code) continue;
    const data = model.terms.find((t) => t.type === 'property' && t.iri && lower(t.name) === lower(c));
    const object = model.props.find((p) => p.iri && lower(p.name) === lower(c));
    if (data) uses[c] = { as: 'value', property: data.iri! };
    else if (object) uses[c] = { as: 'link', property: object.iri! };
  }
  const ns = baseIriOf(model);
  const from = code ?? name ?? columns[0];
  return { rows: 'class', iri: code ? `${ns}{${code}}` : `${ns}{${from}:name}`, ...(from ? { key: from } : {}), columns: uses };
}

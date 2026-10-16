import { validateLiteral } from '../model/literals';

/**
 * Value conversion (ADR-019): a cell's text made into a literal of a datatype, written as the
 * datatype writes it ("yes" as true, "1,234.5" as 1234.5, "2026-10-16 09:30" as a date and time),
 * or the reason it cannot be one. Datatypes are by prefixed name, as the editor keeps them.
 */

const INTEGERS = new Set(['xsd:integer', 'xsd:int', 'xsd:long', 'xsd:short', 'xsd:byte', 'xsd:nonNegativeInteger', 'xsd:positiveInteger', 'xsd:negativeInteger', 'xsd:nonPositiveInteger', 'xsd:unsignedInt', 'xsd:unsignedLong', 'xsd:unsignedShort', 'xsd:unsignedByte']);
const NUMBERS = new Set(['xsd:decimal', 'xsd:double', 'xsd:float']);

/** Digits grouped with spaces, apostrophes or one kind of separator, and one decimal mark: as a number is written. */
function number(text: string, whole: boolean): string | undefined {
  const t = text.replace(/[\s  ']/g, '');
  if (!/^[+-]?[\d.,]+$/.test(t)) return undefined;
  const dots = (t.match(/\./g) ?? []).length;
  const commas = (t.match(/,/g) ?? []).length;
  let n = t;
  if (dots && commas) n = t.lastIndexOf('.') > t.lastIndexOf(',') ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
  else if (commas === 1 && !/^[+-]?\d{1,3},\d{3}$/.test(t)) n = t.replace(',', '.');
  else if (commas) n = t.replace(/,/g, '');
  else if (dots > 1) n = t.replace(/\./g, '');
  if (whole) return /^[+-]?\d+$/.test(n) ? n.replace(/^\+/, '') : /^[+-]?\d+\.0+$/.test(n) ? n.replace(/\.0+$/, '').replace(/^\+/, '') : undefined;
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(n) ? n.replace(/^\+/, '') : undefined;
}

/** A cell's value as a literal of the datatype; none given is text, as written. */
export function convert(raw: string, datatype?: string): { value: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'it is empty' };
  if (!datatype || datatype === 'xsd:string' || datatype === 'rdf:langString' || datatype === 'rdfs:Literal') return { value: text };
  let value = text;
  if (datatype === 'xsd:boolean') {
    const b = text.toLowerCase();
    const yes = ['true', 'yes', 'y', '1', 'ja', 'oui', 'si', 'sí', 'x'];
    const no = ['false', 'no', 'n', '0', 'nee', 'non', 'nein'];
    if (yes.includes(b)) value = 'true';
    else if (no.includes(b)) value = 'false';
  } else if (INTEGERS.has(datatype) || NUMBERS.has(datatype)) {
    value = number(text, INTEGERS.has(datatype)) ?? text;
  } else if (datatype === 'xsd:date') {
    value = text.replace(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/, (_m, y: string, m: string, d: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`).replace(/^(\d{4}-\d{2}-\d{2})[T ]00:00(:00)?$/, '$1');
  } else if (datatype === 'xsd:dateTime') {
    value = text.replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/, (_m, d: string, hm: string, s: string | undefined, _f, z: string | undefined) => `${d}T${hm}${s ?? ':00'}${z ?? ''}`);
  }
  const problem = validateLiteral(value, datatype);
  if (problem) return { error: problem.replace(/^“[^”]*” is/, `“${text}” is`).replace(/\.$/, '') };
  return { value };
}

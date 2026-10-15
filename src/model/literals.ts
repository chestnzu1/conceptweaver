import { quoted } from './words';

/**
 * Whether text can be a literal of a datatype: a whole number for xsd:integer, a date for
 * xsd:date. Used wherever a value is typed in: the values of individuals, and the values an
 * enumerated datatype lists.
 */

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const DOUBLE = /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/;
const ZONE = '(Z|[+-]\\d{2}:\\d{2})?';
const DATE = '-?\\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])';
const TIME = '([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?';
const SHAPES: Record<string, { test: RegExp; example: string; what: string }> = {
  'xsd:integer': { test: INTEGER, example: '42', what: 'a whole number' },
  'xsd:decimal': { test: DECIMAL, example: '3.14', what: 'a decimal number' },
  'xsd:double': { test: DOUBLE, example: '6.02e23', what: 'a number' },
  'xsd:boolean': { test: /^(true|false|1|0)$/, example: 'true', what: 'true or false' },
  'xsd:date': { test: new RegExp(`^${DATE}${ZONE}$`), example: '2024-05-17', what: 'a date' },
  'xsd:dateTime': { test: new RegExp(`^${DATE}T${TIME}${ZONE}$`), example: '2024-05-17T09:30:00', what: 'a date and time' },
  'xsd:time': { test: new RegExp(`^${TIME}${ZONE}$`), example: '09:30:00', what: 'a time' },
  'xsd:gYear': { test: new RegExp(`^-?\\d{4,}${ZONE}$`), example: '1999', what: 'a year' },
  'xsd:duration': { test: /^-?P(?=.)(\d+Y)?(\d+M)?(\d+D)?(T(?=.)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/, example: 'PT2H30M', what: 'a duration' },
  'xsd:anyURI': { test: /^[^\s<>"{}|\\^`]+$/, example: 'https://example.org/page', what: 'a link without spaces' },
};

/** What is wrong with a value as a literal of the datatype, in words; undefined when it is fine. */
export function validateLiteral(value: string, datatype?: string): string | undefined {
  if (!value.trim()) return 'Enter a value.';
  const shape = datatype ? SHAPES[datatype] : undefined;
  if (shape && !shape.test.test(value.trim())) return `${quoted(value.trim())} is not ${shape.what} (${datatype}). It should look like ${shape.example}.`;
  return undefined;
}

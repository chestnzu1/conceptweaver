import type { Table } from '../mapping/contracts';

/**
 * Tables from files (roadmap task 2.4, FR-M7-2): the text of a CSV or TSV file in the encoding it
 * was written in, its rows and cells as RFC 4180 has them (quoted cells may hold separators,
 * quotes and line breaks), and a header row chosen. Workbooks are read by xlsx.ts.
 */

/** The encodings offered for a text file; "auto" reads a byte order mark, then UTF-8, then Windows-1252. */
export const ENCODINGS = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'iso-8859-15', 'shift_jis', 'gbk', 'big5'] as const;

/** A file's text, in the encoding given or the one it shows. */
export function decodeText(bytes: Uint8Array, encoding: string = 'auto'): { text: string; encoding: string } {
  if (encoding !== 'auto') return { text: new TextDecoder(encoding).decode(bytes).replace(/^﻿/, ''), encoding };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // Not UTF-8: what spreadsheets on Windows write by default.
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

const SEPARATORS = [',', ';', '\t', '|'];

/** The separator a file uses: the one found the same number of times, and most, on its first lines, outside quotes. */
export function detectSeparator(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ',';
  let bestScore = -1;
  for (const s of SEPARATORS) {
    const counts = lines.map((l) => l.replace(/"[^"]*"/g, '').split(s).length - 1);
    if (!counts.length || !counts[0]) continue;
    const steady = counts.filter((c) => c === counts[0]).length / counts.length;
    const score = steady * 100 + counts[0];
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/** The rows of a delimited text, with the line each begins on. */
export function parseDelimited(text: string, separator: string = detectSeparator(text)): { rows: string[][]; lines: number[]; separator: string } {
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let any = false;
  const end = () => {
    row.push(cell);
    if (any || row.some((c) => c !== '')) {
      rows.push(row);
      lines.push(start);
    }
    row = [];
    cell = '';
    any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      any = true;
    } else if (c === separator) {
      row.push(cell);
      cell = '';
      any = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      end();
      line++;
      start = line;
    } else cell += c;
  }
  if (cell !== '' || row.length) end();
  return { rows, lines, separator };
}

/** Rows as a table: the header row (1-based; 0 for none) names the columns, and the rows after it are the data. */
export function tableOf(rows: string[][], numbers: number[], header: number): Table {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const head = header > 0 ? (rows[header - 1] ?? []) : [];
  const seen = new Map<string, number>();
  const columns = Array.from({ length: width }, (_x, i) => {
    const name = head[i]?.trim() || `Column ${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
  const data = rows.slice(header > 0 ? header : 0);
  const nums = numbers.slice(header > 0 ? header : 0);
  const keep = data.map((r, i) => ({ r, n: nums[i] })).filter(({ r }) => r.some((c) => c.trim()));
  return { columns, rows: keep.map(({ r }) => Array.from({ length: width }, (_x, i) => r[i] ?? '')), rowNumbers: keep.map(({ n }) => n) };
}

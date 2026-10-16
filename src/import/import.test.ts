import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeText, detectSeparator, parseDelimited, tableOf } from './delimited';
import { readWorkbook } from './xlsx';

/** Tables from files (roadmap task 2.4, FR-M7-2): CSV and TSV in their encodings, and Excel workbooks. */

describe('a delimited text file', () => {
  it('is read as RFC 4180 has it: quoted cells hold separators, quotes and line breaks', () => {
    const text = 'Code,Name,Note\r\nF1,"Parasite, the film","He said ""yes"""\r\nF2,Amélie,"two\nlines"\r\n\r\nF3,,\r\n';
    const { rows, lines, separator } = parseDelimited(text);
    expect(separator).toBe(',');
    expect(rows).toEqual([
      ['Code', 'Name', 'Note'],
      ['F1', 'Parasite, the film', 'He said "yes"'],
      ['F2', 'Amélie', 'two\nlines'],
      ['F3', '', ''],
    ]);
    // Each row by the line it begins on, as an editor shows the file.
    expect(lines).toEqual([1, 2, 3, 6]);
    const table = tableOf(rows, lines, 1);
    expect(table.columns).toEqual(['Code', 'Name', 'Note']);
    expect(table.rows).toHaveLength(3);
    expect(table.rowNumbers).toEqual([2, 3, 6]);
  });

  it('finds its separator, and takes a header row given, or none', () => {
    expect(detectSeparator('a;b;c\n1;2,5;3\n')).toBe(';');
    expect(detectSeparator('a\tb\n1\t2\n')).toBe('\t');
    const { rows, lines } = parseDelimited('Title\tYear\nAlien\t1979\n');
    expect(tableOf(rows, lines, 0).columns).toEqual(['Column 1', 'Column 2']);
    expect(tableOf(rows, lines, 0).rows).toHaveLength(2);
    // A header with a name twice, or none, still names every column apart.
    expect(tableOf([['Name', 'Name', '']], [1], 1).columns).toEqual(['Name', 'Name (2)', 'Column 3']);
  });

  it('is decoded in the encoding it was written in', () => {
    const latin = new Uint8Array([0x43, 0x61, 0x66, 0xe9]); // "Café" in Windows-1252
    expect(decodeText(latin)).toEqual({ text: 'Café', encoding: 'windows-1252' });
    expect(decodeText(new TextEncoder().encode('﻿Café'))).toEqual({ text: 'Café', encoding: 'utf-8' });
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toEqual({ text: 'A', encoding: 'utf-16le' });
    expect(decodeText(latin, 'iso-8859-15').text).toBe('Café');
  });
});

describe('an Excel workbook', () => {
  it('is read sheet by sheet: shared strings, numbers, dates, booleans, empty rows left out', async () => {
    const sheets = await readWorkbook(new Uint8Array(fs.readFileSync(new URL('./fixtures/films.xlsx', import.meta.url))));
    expect(sheets.map((s) => s.name)).toEqual(['Films', 'Genres']);
    const [films, genres] = sheets;
    expect(films.rows).toEqual([
      ['Code', 'Title', 'Genre', 'Released', 'Minutes', 'Awarded'],
      ['F1', 'Parasite', 'Drama', '2019-05-30', '132', 'true'],
      ['F2', 'Amélie & co', 'Comedy', '2001-04-25T20:30:00', '122.5', 'false'],
      ['F3', 'Line\nbreak', '', '', '', ''],
    ]);
    // Row numbers as Excel shows them: the empty row 4 is not there.
    expect(films.rowNumbers).toEqual([1, 2, 3, 5]);
    expect(genres.rows[2]).toEqual(['Comedy', 'Drama']);
  });

  it('says what it is not', async () => {
    await expect(readWorkbook(new TextEncoder().encode('Code,Name\n'))).rejects.toThrow(/not an Excel workbook/);
  });
});

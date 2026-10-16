/**
 * Excel workbooks (.xlsx), read in the page without a library (roadmap task 2.4, FR-M7-2): a
 * workbook is a zip archive of XML, which is unpacked with the browser's DecompressionStream and
 * read for its sheets, their cells, the strings they share and the formats that make a number a
 * date. Formulas give the value last calculated. The older binary format (.xls) is not read.
 */

export interface Sheet {
  name: string;
  /** Its rows, each as wide as the widest, and the row number Excel shows for each. */
  rows: string[][];
  rowNumbers: number[];
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** The files of a zip archive, by name, unpacked when asked for. */
function unzip(bytes: Uint8Array): Map<string, () => Promise<Uint8Array>> {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('It is not an Excel workbook (.xlsx): it is no zip archive. A workbook from an older Excel (.xls) has to be saved as .xlsx or CSV first.');
  const files = new Map<string, () => Promise<Uint8Array>>();
  let at = u32(bytes, eocd + 16);
  const count = u16(bytes, eocd + 10);
  for (let n = 0; n < count; n++) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error('The workbook is damaged: its list of files does not read.');
    const method = u16(bytes, at + 10);
    const size = u32(bytes, at + 20);
    const nameLength = u16(bytes, at + 28);
    const local = u32(bytes, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
    files.set(name, async () => {
      const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method !== 8) throw new Error(`The workbook uses a compression this reader does not know (${method}).`);
      const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m)));
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
/** The text of the <t> elements in a piece of XML, leaving out phonetic runs. */
const texts = (xml: string) => [...xml.replace(/<(\w+:)?rPh\b[\s\S]*?<\/(\w+:)?rPh>/g, '').matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => unescape(m[1])).join('');

/** Column letters as an index: A is 0, Z 25, AA 26. */
const columnIndex = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** Whether a number format shows a date or a time; builtin formats by number, others by their code. */
function dateFormat(id: number, code: string | undefined): 'date' | 'datetime' | 'time' | undefined {
  if ((id >= 14 && id <= 17) || id === 22 || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return id === 22 ? 'datetime' : 'date';
  if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return 'time';
  if (!code) return undefined;
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').toLowerCase();
  const date = /[dy]/.test(bare) || /(^|[^h:])m{3,}/.test(bare);
  const time = /[hs]/.test(bare);
  return date && time ? 'datetime' : date ? 'date' : time ? 'time' : undefined;
}

/** An Excel serial number as an ISO date, date and time, or time. */
function fromSerial(serial: number, as: 'date' | 'datetime' | 'time', date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86400000);
  const d = new Date(epoch + ms);
  const iso = d.toISOString();
  if (as === 'time') return iso.slice(11, 19);
  if (as === 'date' || ms % 86400000 === 0) return iso.slice(0, 10);
  return iso.slice(0, 19);
}

/** The sheets of a workbook, in order, with their cells as text. */
export async function readWorkbook(bytes: Uint8Array): Promise<Sheet[]> {
  const files = unzip(bytes);
  const read = async (name: string) => {
    const f = files.get(name) ?? files.get(name.replace(/^\//, ''));
    return f ? new TextDecoder().decode(await f()) : undefined;
  };
  const workbook = await read('xl/workbook.xml');
  if (!workbook) throw new Error('It is not an Excel workbook (.xlsx): it has no xl/workbook.xml.');
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\sdate1904="(1|true)"/.test(workbook);
  const rels = (await read('xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map([...rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id') ?? '', attr(m[0], 'Target') ?? '']));
  const shared = [...((await read('xl/sharedStrings.xml')) ?? '').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => texts(m[1]));
  const styles = (await read('xl/styles.xml')) ?? '';
  const codes = new Map([...styles.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), unescape(attr(m[0], 'formatCode') ?? '')]));
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(styles)?.[1] ?? '';
  const formats = [...xfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    return dateFormat(id, codes.get(id));
  });

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = unescape(attr(m[0], 'name') ?? `Sheet ${sheets.length + 1}`);
    const target = targets.get(attr(m[0], 'r:id') ?? '') ?? '';
    const xml = await read(target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, ''));
    if (!xml) continue;
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    for (const r of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const cells: string[] = [];
      let next = 0;
      for (const c of (r[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ref = attr(c[0], 'r');
        const at = ref ? columnIndex(/^[A-Z]+/.exec(ref)?.[0] ?? 'A') : next;
        next = at + 1;
        const type = attr(c[0], 't');
        const inner = c[2] ?? '';
        const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = texts(inner);
        else if (type === 'b') value = v === '1' ? 'true' : 'false';
        else if (type === 'str' || type === 'e' || type === 'd') value = unescape(v ?? '');
        else if (v !== undefined) {
          const as = formats[Number(attr(c[0], 's') ?? 0)];
          value = as && Number.isFinite(Number(v)) ? fromSerial(Number(v), as, date1904) : v;
        }
        cells[at] = value;
      }
      if (!cells.some((x) => x?.trim())) continue;
      rows.push(Array.from(cells, (x) => x ?? ''));
      rowNumbers.push(Number(attr(`<row ${r[1]}>`, 'r') ?? rows.length));
    }
    const width = Math.max(0, ...rows.map((x) => x.length));
    sheets.push({ name, rows: rows.map((x) => Array.from({ length: width }, (_y, i) => x[i] ?? '')), rowNumbers });
  }
  return sheets;
}

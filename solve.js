// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program): run(input) returns
// exactly what csv-reader 1.0.0 returns for {text, header}: {columns, rows, errors}.
//
// Same reading, written for speed instead of plainness:
//  - one pass, left to right, over the text;
//  - an unquoted field is found with one native regex search for its next delimiter
//    (comma, CR or LF) instead of one character at a time;
//  - a quoted field is found with indexOf for its closing quote (doubled quotes skipped
//    in the same scan) and its content taken as one slice when it holds no quote, CR
//    or LF at all, which is the common case;
//  - a record whose line holds no quote and no stray CR is split in one native call;
//  - fields are slices of the input, never built up a character at a time.
//
// The policy is csv-reader 1.0.0's own, kept exactly:
//  - a U+FEFF at the very start of the text is dropped;
//  - a record ends at LF or CRLF, and a line left with no characters is no record;
//  - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//  - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//    it one quote and each CRLF or lone CR inside it read as LF; what follows its closing
//    quote, up to the next comma or line break, is appended as it stands (quote_junk,
//    when the field ends); a quote that never closes is a literal character, and the text
//    after it is read again as unquoted (unterminated_quote);
//  - a quote inside an unquoted field is a literal character; fields stay strings,
//    never trimmed or converted;
//  - columns is the first record when header is true, else null; rows holds the records
//    after it (every record when header is false), each padded with "" (short_row, with
//    fields: its field count) or cut (long_row, with extra: the cut fields) to the first
//    record's width;
//  - each error is {code, line, row}: line the 1-based line its record starts on
//    (every LF, CRLF and lone CR inside a quoted field counted), row its record's index
//    in rows (null for the header), in the order met.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: 0 at a comma (the record goes on), 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The next delimiter of an unquoted field: a comma, a CR or an LF. */
const DELIM = /[,\r\n]/g;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // What the last field read was, for the reader below: its value, how many characters
  // it kept after its start, and how it ended.
  let fValue = '';
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Returns how the field ended.
  function readUnquoted(value) {
    let v = value;
    let added = 0;
    let p = pos;
    for (;;) {
      DELIM.lastIndex = p;
      const m = DELIM.exec(text);
      if (m === null) {
        if (p < n) {
          const s = text.slice(p);
          v = v === '' ? s : v + s;
          added += n - p;
        }
        pos = n;
        fValue = v;
        fAdded = added;
        return END;
      }
      const i = m.index;
      const c = text.charCodeAt(i);
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          if (i > p) {
            const s = text.slice(p, i);
            v = v === '' ? s : v + s;
            added += i - p;
          }
          pos = i + 2;
          line += 1;
          fValue = v;
          fAdded = added;
          return LINE_BREAK;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (i > p) {
          const s = text.slice(p, i);
          v = v === '' ? s : v + s;
          added += i - p;
        }
        p = i + 1;
        continue;
      }
      if (i > p) {
        const s = text.slice(p, i);
        v = v === '' ? s : v + s;
        added += i - p;
      }
      if (c === 44) {
        pos = i + 1;
        fValue = v;
        fAdded = added;
        return COMMA;
      }
      pos = i + 1;
      line += 1;
      fValue = v;
      fAdded = added;
      return LINE_BREAK;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns how the field ended.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let q = text.indexOf('"', pos + 1);
    while (q !== -1 && text.charCodeAt(q + 1) === 34) q = text.indexOf('"', q + 2);
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after it is
      // read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    let v = text.slice(open + 1, q);
    if (v.indexOf('"') !== -1 || v.indexOf('\r') !== -1 || v.indexOf('\n') !== -1) {
      // Doubled quotes become one quote; each CRLF or lone CR becomes one LF.
      v = v.replaceAll('""', '"').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      let breaks = 0;
      let i = v.indexOf('\n');
      while (i !== -1) {
        breaks += 1;
        i = v.indexOf('\n', i + 1);
      }
      line += breaks;
    }
    pos = q + 1;
    if (pos >= n) {
      fValue = v;
      fAdded = 0;
      return END;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = v;
      fAdded = 0;
      return COMMA;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = v;
      fAdded = 0;
      return LINE_BREAK;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = v;
      fAdded = 0;
      return LINE_BREAK;
    }
    // What follows the closing quote is appended as it stands, up to the next comma
    // or line break.
    const ended = readUnquoted(v);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return ended;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted = false;
    // Fast path: the whole record is unquoted fields on one line (no quote and no
    // stray CR before its line break).
    const eol = text.indexOf('\n', pos);
    const lineEnd = eol === -1 ? n : eol;
    let end = lineEnd;
    if (eol !== -1 && end > pos && text.charCodeAt(end - 1) === 13) end -= 1;
    const seg = text.slice(pos, end);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      fields = seg.split(',');
      pos = eol === -1 ? n : eol + 1;
      if (eol !== -1) line += 1;
    } else {
      fields = [];
      let ended;
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) {
          ended = readQuoted();
        } else {
          ended = readUnquoted('');
        }
        fields.push(fValue);
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

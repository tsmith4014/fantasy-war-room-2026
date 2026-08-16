/**
 * Parse RFC 4180-style CSV without a runtime dependency.
 *
 * Upstream values are always returned as strings. Callers are responsible for
 * type and bounds validation before using them.
 */
export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be text");

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV input ended inside a quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length < 2) throw new Error("CSV input has no data rows");

  const headers = rows.shift().map((header, index) => {
    const value = index === 0 ? header.replace(/^\uFEFF/, "") : header;
    if (!value) throw new Error(`CSV header ${index + 1} is empty`);
    return value;
  });
  if (new Set(headers).size !== headers.length) throw new Error("CSV headers are not unique");

  return rows.map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

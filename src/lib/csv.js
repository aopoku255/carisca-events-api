/**
 * CSV generation for participant and attendance exports.
 *
 * Two things this gets right that a naive join(',') does not:
 *
 *   Formula injection. A participant can put `=HYPERLINK(...)` in a free-text
 *   answer. Excel executes leading =, +, -, @ and TAB/CR when the file is
 *   opened, which turns an export of your own data into code execution on a
 *   staff laptop. Those values are prefixed with an apostrophe.
 *
 *   Encoding. Excel assumes the system codepage unless a UTF-8 BOM is present,
 *   which mangles names like Adjei-Bræmpong. The BOM is included.
 */

const DANGEROUS = /^[=+\-@\t\r]/;

export function escapeCell(value) {
  if (value === null || value === undefined) return '';

  let text = value instanceof Date ? value.toISOString() : String(value);

  // Neutralise a formula without altering what the reader sees as the value.
  if (DANGEROUS.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * @param columns [{ key, header, map? }]
 * @param rows    array of records
 */
export function toCsv(columns, rows) {
  const header = columns.map((c) => escapeCell(c.header)).join(',');
  const body = rows.map((row) => columns
    .map((c) => escapeCell(c.map ? c.map(row) : row[c.key]))
    .join(','));

  // \r\n because Excel on Windows still cares.
  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}

/** Safe, dated filename — no participant data in the name. */
export function exportFilename(prefix, extension = 'csv') {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const safe = String(prefix).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${safe || 'export'}-${stamp}.${extension}`;
}

export function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Exports contain personal data; never let a proxy or the browser keep them.
  res.setHeader('Cache-Control', 'no-store, private');
  return res.send(csv);
}

export default { toCsv, escapeCell, exportFilename, sendCsv };

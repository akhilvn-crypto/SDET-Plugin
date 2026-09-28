/**
 * The test cases as an Excel workbook in Emvigo's controlled-document layout - the same three
 * sheets the qa-analyst plugin's `/generate-test-cases --xlsx` produces, so a suite looks the same
 * whichever plugin wrote it:
 *
 *   1. "Document Version Control"  - project logo (Branding/project-logo.png, when present),
 *                                    heading, bordered label/value form of document_control.
 *   2. "Document Release History"  - one bordered row per release_history entry.
 *   3. "Test Cases"                - one row per test case, steps merged into numbered multi-line
 *                                    cells, plus the automation and execution-tracking columns.
 *
 * It is rendered from the same JSON document as the sibling .md, so the two never disagree; like
 * the .md it is output only and is never read back - edit the JSON (or record results through
 * sdet.js), then re-export.
 */
const fs = require('fs');
const path = require('path');
const ex = require('./execution');
const { writeXlsx, colLetter, columnWidthToPx, pngSize } = require('./xlsx');

const DEFAULT_COLUMN_WIDTH = 16;
const POINTS_PER_LINE = 15;
const LOGO_WIDTH_PX = 150;
// A real blank margin before the front-matter tables, so they don't start in the A1 corner.
const AUDIT_LEFT_MARGIN_COLS = 3;
const AUDIT_TOP_MARGIN_ROWS = 3;
const LOGO_PATH = path.join('Branding', 'project-logo.png');

const DOCUMENT_CONTROL_FIELDS = [
  ['Document Title', 'title'],
  ['Project ID', 'project_id'],
  ['Document ID', 'document_id'],
  ['Description', 'description'],
  ['Version', 'version'],
  ['Prepared By', 'prepared_by'],
  ['Prepared Date', 'prepared_date'],
  ['Approved Date', 'approved_date'],
  ['Master Template ID', 'master_template_id'],
];
// Description is the one free-text field; everything else reads better centered.
const VERSION_CONTROL_LEFT_FIELDS = new Set(['Description']);
const VERSION_CONTROL_WIDTHS = { label: 22, value: 55 };

const RELEASE_HISTORY_COLUMNS = ['Version', 'Date', 'Author', 'Reviewed By', 'Reviewed On', 'Approved By', 'Approved On', 'Reasons'];
const RELEASE_HISTORY_WIDTHS = { Version: 10, Date: 14, Author: 18, 'Reviewed By': 22, 'Reviewed On': 14, 'Approved By': 22, 'Approved On': 14, Reasons: 40 };

// qa-analyst's review columns, plus this pipeline's Status / Automation Status / Test Status.
const TEST_CASE_COLUMNS = [
  'Requirement ID',
  'Requirement',
  'Test Case Key',
  'Test Case Name',
  'Objective',
  'Precondition',
  'Priority',
  'Test Type',
  'Status',
  'Automation Status',
  'Steps',
  'Test Data',
  'Expected Result',
  'Actual Result',
  'Execution Status',
  'Test Status',
  'Linked Issue',
];
const TEST_CASE_WRAP = new Set(['Requirement', 'Test Case Name', 'Objective', 'Precondition', 'Steps', 'Test Data', 'Expected Result', 'Actual Result', 'Linked Issue']);
const TEST_CASE_WIDTHS = {
  'Requirement ID': 16,
  Requirement: 36,
  'Test Case Key': 16,
  'Test Case Name': 26,
  Objective: 28,
  Precondition: 20,
  Priority: 10,
  'Test Type': 12,
  Status: 10,
  'Automation Status': 15,
  Steps: 36,
  'Test Data': 20,
  'Expected Result': 32,
  'Actual Result': 32,
  'Execution Status': 15,
  'Test Status': 12,
  'Linked Issue': 28,
};

/**
 * Visual lines `text` wraps onto in a column of `width` chars. Excel wraps at word boundaries, so
 * this word-wraps greedily (a word longer than a line is broken) and errs tall - never clipped.
 */
function lineCount(text, width) {
  if (!text) return 1;
  const perLine = Math.max(1, Math.floor(width) - 2);
  let total = 0;
  for (const line of String(text).split('\n')) {
    let lines = 1;
    let used = 0;
    for (const word of line.split(/\s+/).filter(Boolean)) {
      const need = used ? used + 1 + word.length : word.length;
      if (need <= perLine) used = need;
      else {
        lines += used ? 1 : 0;
        lines += Math.floor((word.length - 1) / perLine);
        used = ((word.length - 1) % perLine) + 1;
      }
    }
    total += lines;
  }
  return Math.max(1, total);
}

function rowHeight(values, columns, wrap, widths) {
  const lines = Math.max(1, ...values.map((v, i) => (wrap.has(columns[i]) ? lineCount(v, widths[columns[i]] || DEFAULT_COLUMN_WIDTH) : 1)));
  return POINTS_PER_LINE * lines;
}

/** Header + data rows at (startRow, startCol), with widths, heights, freeze and autofilter. */
function table(sheet, columns, rows, { wrap, widths, bordered = false, center = new Set(), startRow = 1, startCol = 1 }) {
  const header = {};
  columns.forEach((c, i) => {
    header[startCol + i] = { v: c, s: bordered ? 'headerBordered' : 'header' };
    sheet.cols[startCol + i] = widths[c] || DEFAULT_COLUMN_WIDTH;
  });
  sheet.rows[startRow] = { cells: header };
  rows.forEach((values, r) => {
    const cells = {};
    values.forEach((v, i) => {
      const col = columns[i];
      cells[startCol + i] = { v, s: bordered ? (center.has(col) ? 'bodyBorderedCenter' : 'bodyBorderedWrap') : wrap.has(col) ? 'bodyWrap' : 'body' };
    });
    sheet.rows[startRow + 1 + r] = { height: rowHeight(values, columns, wrap, widths), cells };
  });
  const last = startRow + Math.max(rows.length, 0);
  sheet.freeze = `${colLetter(startCol)}${startRow + 1}`;
  sheet.autoFilter = `${colLetter(startCol)}${startRow}:${colLetter(startCol + columns.length - 1)}${last}`;
  return last;
}

/** The project logo, horizontally centered over the given columns; none when the file is absent. */
function logo(cwd, sheet, cols, row) {
  const file = path.resolve(cwd, LOGO_PATH);
  let png;
  try {
    png = fs.readFileSync(file);
  } catch {
    return; // no Branding/project-logo.png - the workbook simply has no logo
  }
  let size;
  try {
    size = pngSize(png);
  } catch {
    return;
  }
  const widths = cols.map((c) => columnWidthToPx(sheet.cols[c] || DEFAULT_COLUMN_WIDTH));
  let offset = Math.max(0, Math.floor((widths.reduce((a, b) => a + b, 0) - LOGO_WIDTH_PX) / 2));
  let col = cols[0] - 1; // 0-based anchor column
  for (const w of widths) {
    if (offset < w) break;
    offset -= w;
    col += 1;
  }
  sheet.image = { png, col, row, colOffPx: offset, widthPx: LOGO_WIDTH_PX, heightPx: Math.round((LOGO_WIDTH_PX * size.height) / size.width) };
}

function versionControlSheet(doc, cwd) {
  const control = doc.document_control || {};
  const sheet = { name: 'Document Version Control', cols: {}, rows: {}, merges: [] };
  const labelCol = AUDIT_LEFT_MARGIN_COLS + 1;
  const valueCol = labelCol + 1;
  sheet.cols[labelCol] = VERSION_CONTROL_WIDTHS.label;
  sheet.cols[valueCol] = VERSION_CONTROL_WIDTHS.value;
  logo(cwd, sheet, [labelCol, valueCol], AUDIT_TOP_MARGIN_ROWS);

  let row = AUDIT_TOP_MARGIN_ROWS + 9; // room for the logo above
  sheet.rows[row] = { cells: { [labelCol]: { v: sheet.name, s: 'heading' }, [valueCol]: { v: '', s: 'heading' } } };
  sheet.merges.push(`${colLetter(labelCol)}${row}:${colLetter(valueCol)}${row}`);
  row += 2;
  for (const [label, key] of DOCUMENT_CONTROL_FIELDS) {
    const value = key === 'version' ? control.version || (doc.meta && doc.meta.version) : control[key];
    sheet.rows[row] = {
      height: POINTS_PER_LINE * Math.max(lineCount(label, VERSION_CONTROL_WIDTHS.label), lineCount(value, VERSION_CONTROL_WIDTHS.value)),
      cells: {
        [labelCol]: { v: label, s: 'label' },
        [valueCol]: { v: value, s: VERSION_CONTROL_LEFT_FIELDS.has(label) ? 'bodyBorderedWrap' : 'bodyBorderedCenter' },
      },
    };
    row += 1;
  }
  return sheet;
}

function releaseHistorySheet(doc) {
  const sheet = { name: 'Document Release History', cols: {}, rows: {} };
  const rows = (doc.release_history || []).map((e) => [e.version, e.date, e.author, e.reviewed_by, e.reviewed_on, e.approved_by, e.approved_on, e.reasons]);
  table(sheet, RELEASE_HISTORY_COLUMNS, rows, {
    wrap: new Set(RELEASE_HISTORY_COLUMNS),
    widths: RELEASE_HISTORY_WIDTHS,
    bordered: true,
    center: new Set(RELEASE_HISTORY_COLUMNS.filter((c) => c !== 'Reasons')),
    startRow: AUDIT_TOP_MARGIN_ROWS + 1,
    startCol: AUDIT_LEFT_MARGIN_COLS + 1,
  });
  return sheet;
}

/** Steps / Test Data / Expected Result as numbered lines; Test Data lists only steps that have data. */
function mergeSteps(tc) {
  const steps = tc.steps || [];
  return [
    steps.map((s) => `${s.step_number}. ${s.action}`).join('\n'),
    steps.filter((s) => String(s.test_data || '').trim()).map((s) => `${s.step_number}. ${s.test_data}`).join('\n'),
    steps.map((s) => `${s.step_number}. ${s.expected_result}`).join('\n'),
  ];
}

/** Linked issues as plain text, one per line, with the bug's live title/status like the .md shows. */
function issueText(tc, cwd) {
  return ex
    .linkedIssuesOf(tc)
    .map((l) => {
      const meta = ex.bugMeta(cwd, l);
      if (meta && meta.missing) return `${l.id} (bug file missing)`;
      const info = meta ? [meta.status, meta.severity].filter(Boolean).join(', ') : '';
      return `${l.id}${meta && meta.title ? ` — ${meta.title}` : ''}${info ? ` (${info})` : ''}${l.url ? ` ${l.url}` : l.path ? ` [${l.path}]` : ''}`;
    })
    .join('\n');
}

function testCasesSheet(doc, cwd) {
  const sheet = { name: 'Test Cases', cols: {}, rows: {} };
  const rows = doc.test_cases.map((tc) => {
    const e = tc.last_execution;
    const [steps, data, expected] = mergeSteps(tc);
    return [
      tc.req_id,
      tc.spec_scenario || '',
      tc.tc_id,
      tc.title,
      tc.objective,
      tc.preconditions || '',
      tc.priority,
      tc.test_type,
      tc.status,
      tc.automation_status,
      steps,
      data,
      expected,
      ex.actualResultOf(e),
      ex.executionStatusOf(e),
      ex.testStatusOf(e),
      issueText(tc, cwd),
    ];
  });
  const last = table(sheet, TEST_CASE_COLUMNS, rows, { wrap: TEST_CASE_WRAP, widths: TEST_CASE_WIDTHS });
  // Real dropdowns for the two status columns, so manual execution is recorded with valid values.
  if (last >= 2) {
    const col = (name) => colLetter(TEST_CASE_COLUMNS.indexOf(name) + 1);
    sheet.validations = [
      { sqref: `${col('Execution Status')}2:${col('Execution Status')}${last}`, list: ex.EXECUTION_STATUSES },
      { sqref: `${col('Test Status')}2:${col('Test Status')}${last}`, list: ex.TEST_STATUSES },
    ];
  }
  return sheet;
}

function xlsxPathFor(jsonFile) {
  return jsonFile.replace(/\.json$/, '.xlsx');
}

/** Write <SPEC_ID>.test-cases.xlsx next to the test-case JSON. Returns its path. */
function writeWorkbook(jsonFile, doc, { cwd = process.cwd() } = {}) {
  const file = xlsxPathFor(jsonFile);
  writeXlsx(file, { sheets: [versionControlSheet(doc, cwd), releaseHistorySheet(doc), testCasesSheet(doc, cwd)], active: 0 });
  return file;
}

module.exports = { writeWorkbook, xlsxPathFor, TEST_CASE_COLUMNS, LOGO_PATH };

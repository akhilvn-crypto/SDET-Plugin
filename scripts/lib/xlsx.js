/**
 * Minimal zero-dependency .xlsx writer - just enough SpreadsheetML for the controlled-document
 * workbooks this plugin produces (see testcase-workbook.js): inline strings, a fixed set of named
 * cell styles, column widths, row heights, merged cells, a frozen header, an autofilter, list
 * data-validations (dropdowns) and one floating PNG per sheet. Written by hand so scripts/ keeps
 * running on plain Node with no npm install.
 *
 *   writeXlsx(file, { sheets: [sheet, ...], active: 0 })
 *   sheet = {
 *     name, cols: { <1-based col>: width }, rows: { <1-based row>: { height?, cells: { <col>: { v, s } } } },
 *     merges: ['D12:E12'], freeze: 'A2', autoFilter: 'A1:N20',
 *     validations: [{ sqref: 'M2:M20', list: ['Pass', 'Fail'] }],
 *     image: { png: <Buffer>, col, row, colOffPx, widthPx, heightPx }   // 0-based anchor cell
 *   }
 * Cell style `s` is one of the STYLES keys; values are written as text.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HEADER_FILL = '1F3864';
const HEADER_FONT_COLOR = 'FFFFFF';

// fonts: 0 default, 1 bold, 2 bold white (header), 3 bold 14pt navy (sheet heading)
const FONTS = [
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
  `<font><b/><sz val="11"/><color rgb="FF${HEADER_FONT_COLOR}"/><name val="Calibri"/><family val="2"/></font>`,
  `<font><b/><sz val="14"/><color rgb="FF${HEADER_FILL}"/><name val="Calibri"/><family val="2"/></font>`,
];
// fills 0 and 1 are reserved by Excel (none, gray125); 2 is the navy header fill
const FILLS = [
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  `<fill><patternFill patternType="solid"><fgColor rgb="FF${HEADER_FILL}"/><bgColor indexed="64"/></patternFill></fill>`,
];
// borders: 0 none, 1 thin black on all four sides
const BORDERS = [
  '<border><left/><right/><top/><bottom/><diagonal/></border>',
  '<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>',
];

// name -> [fontId, fillId, borderId, horizontal|null, vertical|null, wrap]
const STYLE_DEFS = {
  default: [0, 0, 0, null, null, false],
  header: [2, 2, 0, null, 'center', true],
  headerBordered: [2, 2, 1, 'center', 'center', true],
  body: [0, 0, 0, null, 'top', false],
  bodyWrap: [0, 0, 0, null, 'top', true],
  bodyBorderedWrap: [0, 0, 1, null, 'top', true],
  bodyBorderedCenter: [0, 0, 1, 'center', 'top', true],
  label: [1, 0, 1, 'center', 'top', true],
  heading: [3, 0, 0, 'center', null, true],
};
const STYLE_NAMES = Object.keys(STYLE_DEFS);
const STYLES = Object.fromEntries(STYLE_NAMES.map((n, i) => [n, i]));

function stylesXml() {
  const xfs = STYLE_NAMES.map((n) => {
    const [font, fill, border, h, v, wrap] = STYLE_DEFS[n];
    const attrs = [`numFmtId="0"`, `fontId="${font}"`, `fillId="${fill}"`, `borderId="${border}"`, `xfId="0"`];
    if (font) attrs.push('applyFont="1"');
    if (fill) attrs.push('applyFill="1"');
    if (border) attrs.push('applyBorder="1"');
    const align = [h && `horizontal="${h}"`, v && `vertical="${v}"`, wrap && 'wrapText="1"'].filter(Boolean);
    if (!align.length) return `<xf ${attrs.join(' ')}/>`;
    return `<xf ${attrs.join(' ')} applyAlignment="1"><alignment ${align.join(' ')}/></xf>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<fonts count="${FONTS.length}">${FONTS.join('')}</fonts>` +
    `<fills count="${FILLS.length}">${FILLS.join('')}</fills>` +
    `<borders count="${BORDERS.length}">${BORDERS.join('')}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

// ---------------------------------------------------------------- helpers

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function esc(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // not allowed in XML 1.0
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Approximate pixel width of a column of `width` character units (ECMA-376: chars*7 + 5). */
function columnWidthToPx(width) {
  return Math.round(width * 7) + 5;
}

/** Width/height of a PNG from its IHDR chunk. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const EMU_PER_PX = 9525;

// ---------------------------------------------------------------- sheet xml

function sheetXml(sheet, isActive) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
  ];
  const freeze = sheet.freeze && sheet.freeze.match(/^([A-Z]+)(\d+)$/);
  const selected = isActive ? ' tabSelected="1"' : '';
  if (freeze) {
    const [, col, row] = freeze;
    const ySplit = Number(row) - 1;
    const xSplit = col.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const pane = ySplit && xSplit ? 'bottomRight' : ySplit ? 'bottomLeft' : 'topRight';
    parts.push(
      `<sheetViews><sheetView workbookViewId="0"${selected}><pane${xSplit ? ` xSplit="${xSplit}"` : ''}${ySplit ? ` ySplit="${ySplit}"` : ''} topLeftCell="${sheet.freeze}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${sheet.freeze}" sqref="${sheet.freeze}"/></sheetView></sheetViews>`
    );
  } else {
    parts.push(`<sheetViews><sheetView workbookViewId="0"${selected}/></sheetViews>`);
  }
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  const cols = Object.entries(sheet.cols || {})
    .map(([c, w]) => [Number(c), w])
    .sort((a, b) => a[0] - b[0]);
  if (cols.length) parts.push(`<cols>${cols.map(([c, w]) => `<col min="${c}" max="${c}" width="${w}" customWidth="1"/>`).join('')}</cols>`);

  parts.push('<sheetData>');
  const rows = Object.entries(sheet.rows || {})
    .map(([r, row]) => [Number(r), row])
    .sort((a, b) => a[0] - b[0]);
  for (const [r, row] of rows) {
    const ht = row.height ? ` ht="${row.height}" customHeight="1"` : '';
    const cells = Object.entries(row.cells || {})
      .map(([c, cell]) => [Number(c), cell])
      .sort((a, b) => a[0] - b[0])
      .map(([c, cell]) => {
        const ref = `${colLetter(c)}${r}`;
        const s = STYLES[cell.s || 'default'];
        if (s === undefined) throw new Error(`unknown cell style "${cell.s}"`);
        const sAttr = s ? ` s="${s}"` : '';
        const v = cell.v === undefined || cell.v === null ? '' : String(cell.v);
        if (v === '') return `<c r="${ref}"${sAttr}/>`;
        return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      });
    parts.push(`<row r="${r}"${ht}>${cells.join('')}</row>`);
  }
  parts.push('</sheetData>');

  if (sheet.autoFilter) parts.push(`<autoFilter ref="${sheet.autoFilter}"/>`);
  if ((sheet.merges || []).length) parts.push(`<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`);
  const validations = sheet.validations || [];
  if (validations.length) {
    parts.push(`<dataValidations count="${validations.length}">`);
    for (const v of validations) {
      parts.push(`<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${v.sqref}"><formula1>"${esc(v.list.join(','))}"</formula1></dataValidation>`);
    }
    parts.push('</dataValidations>');
  }
  parts.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>');
  if (sheet.image) parts.push('<drawing r:id="rId1"/>');
  parts.push('</worksheet>');
  return parts.join('');
}

function drawingXml(image) {
  const cx = image.widthPx * EMU_PER_PX;
  const cy = image.heightPx * EMU_PER_PX;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<xdr:oneCellAnchor>' +
    `<xdr:from><xdr:col>${image.col}</xdr:col><xdr:colOff>${(image.colOffPx || 0) * EMU_PER_PX}</xdr:colOff><xdr:row>${image.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${cx}" cy="${cy}"/>` +
    '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>'
  );
}

// A bare type name is an officeDocument relationship; a full URI is used as given.
const rels = (items) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.includes('://') ? type : `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}`}" Target="${target}"/>`)
    .join('') +
  '</Relationships>';

function buildParts({ sheets, active = 0 }) {
  const files = [];
  const add = (name, data) => files.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });
  const hasImage = sheets.some((s) => s.image);
  let drawingNo = 0;

  const overrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
  ];
  sheets.forEach((sheet, i) => {
    const n = i + 1;
    overrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    add(`xl/worksheets/sheet${n}.xml`, sheetXml(sheet, i === active));
    if (sheet.image) {
      drawingNo += 1;
      overrides.push(`<Override PartName="/xl/drawings/drawing${drawingNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      add(`xl/worksheets/_rels/sheet${n}.xml.rels`, rels([['rId1', 'drawing', `../drawings/drawing${drawingNo}.xml`]]));
      add(`xl/drawings/drawing${drawingNo}.xml`, drawingXml(sheet.image));
      add(`xl/drawings/_rels/drawing${drawingNo}.xml.rels`, rels([['rId1', 'image', `../media/image${drawingNo}.png`]]));
      add(`xl/media/image${drawingNo}.png`, sheet.image.png);
    }
  });

  add(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      (hasImage ? '<Default Extension="png" ContentType="image/png"/>' : '') +
      overrides.join('') +
      '</Types>'
  );
  add(
    '_rels/.rels',
    rels([
      ['rId1', 'officeDocument', 'xl/workbook.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
      ['rId3', 'extended-properties', 'docProps/app.xml'],
    ])
  );
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  add(
    'docProps/core.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
  );
  add(
    'docProps/app.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>sdet-pipeline</Application></Properties>'
  );

  const definedNames = sheets
    .map((s, i) => (s.autoFilter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${s.name.replace(/'/g, "''")}'!${s.autoFilter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : ''))
    .join('');
  add(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<bookViews><workbookView activeTab="${active}"/></bookViews>` +
      `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      (definedNames ? `<definedNames>${definedNames}</definedNames>` : '') +
      '</workbook>'
  );
  add(
    'xl/_rels/workbook.xml.rels',
    rels([...sheets.map((s, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`]), [`rId${sheets.length + 1}`, 'styles', 'styles.xml']])
  );
  add('xl/styles.xml', stylesXml());
  return files;
}

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

function writeXlsx(file, workbook) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename, like util.writeJson: a file open in Excel fails the rename, not half-way through.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, zip(buildParts(workbook)));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

module.exports = { writeXlsx, colLetter, columnWidthToPx, pngSize, STYLES };

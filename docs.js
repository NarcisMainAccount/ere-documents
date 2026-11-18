// Builds the invoice PDF and the salaries .xlsx entirely in the browser.
// The invoice layout mirrors the original Word template (A4, positions in points).
'use strict';

window.Docs = (() => {
  const BLUE = [46, 117, 182];
  const money = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const eur = n => '€' + money.format(n || 0);
  const dmy = (iso, sep = '/') => iso ? iso.split('-').reverse().join(sep) : '';

  // ------------------------------------------------------------------ invoice PDF
  // inv: { number, date (yyyy-mm-dd), billTo, attention, project, lines: [{ description, amount }], total, company }
  function invoicePdf(inv) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const c = inv.company || {};
    const L = 72.6, R = 543, DESC_W = 360, PAD = 6, LINE = 11.5;
    const PAGE_BOTTOM = 770;

    const font = (style = 'normal', size = 10, color = [0, 0, 0], face = 'helvetica') => {
      doc.setFont(face, style); doc.setFontSize(size); doc.setTextColor(...color);
    };
    // "Label: value" with a bold label, like the template.
    const labelled = (x, y, label, value) => {
      font('bold'); doc.text(label, x, y);
      const w = doc.getTextWidth(label) + 3;
      font('normal'); doc.text(String(value ?? ''), x + w, y);
    };

    // Header: company block on the left, contact block on the right.
    font('bold', 18, BLUE); doc.text(c.name || '', L, 101);
    font('normal', 9, [128, 128, 128]);
    doc.text(`VAT Reg # ${c.vat || ''}`, L, 127);
    doc.text(`Company Number ${c.number || ''}`, L, 138);

    const RX = 314;
    font('normal', 10); doc.text(`Date: ${dmy(inv.date)}`, RX, 96);
    font('bold'); doc.text(c.name || '', RX, 119);
    labelled(RX, 130.5, 'Mobile:', c.mobile);
    labelled(RX, 142, 'Email:', c.email);
    labelled(RX, 153.5, 'Address:', c.address1);
    font('normal'); doc.text(c.address2 || '', RX, 165);

    // Invoice title with blue rule.
    font('normal', 11, [0, 0, 0], 'times'); doc.text(`Invoice ${inv.number}`, L, 220);
    doc.setDrawColor(...BLUE); doc.setLineWidth(0.75); doc.line(71.3, 224.5, 528, 224.5);

    // Project / attention / bill-to block.
    let y = 259;
    const PX = 145;
    labelled(PX, y, 'Project:', inv.project); y += LINE;
    if (inv.attention) { labelled(PX, y, 'Attention:', inv.attention); y += LINE; }
    labelled(PX, y, 'Bill To:', inv.billTo);

    // Line items table.
    const header = top => {
      doc.setFillColor(...BLUE); doc.rect(L, top, R - L, 24, 'F');
      font('bold', 10, [255, 255, 255]);
      doc.text('Description', L + PAD, top + 15.5);
      doc.text('Amount', R - PAD, top + 15.5, { align: 'right' });
      return top + 24;
    };
    y = header(y + 18);
    doc.setDrawColor(204, 204, 204); doc.setLineWidth(0.5);
    for (const line of inv.lines) {
      font('normal', 10);
      const text = doc.splitTextToSize(String(line.description), DESC_W - 2 * PAD);
      const h = 2 * PAD + text.length * LINE + 0.5;
      if (y + h > PAGE_BOTTOM) { doc.addPage(); y = header(72); doc.setDrawColor(204, 204, 204); doc.setLineWidth(0.5); font('normal', 10); }
      doc.text(text, L + PAD, y + PAD + 8.5, { lineHeightFactor: LINE / 10 });
      doc.text(eur(line.amount), R - PAD, y + PAD + 8.5, { align: 'right' });
      y += h;
      doc.line(L, y, R, y);
    }
    // Total cell (grey, right column only).
    const TX = L + DESC_W + 1;
    if (y + 24 > PAGE_BOTTOM) { doc.addPage(); y = 72; }
    doc.setFillColor(242, 242, 242); doc.rect(TX, y, R - TX, 23.5, 'F');
    doc.setDrawColor(204, 204, 204); doc.line(TX, y + 23.5, R, y + 23.5);
    font('bold', 10); doc.text(eur(inv.total), R - PAD, y + PAD + 9, { align: 'right' });
    y += 23.5;

    // Footer: VAT note, bank box, closing rule.
    if (y + 130 > 841) { doc.addPage(); y = 40; }
    y += 40;
    font('bold', 10); doc.text(c.vatNote || '', L, y);
    const boxTop = y + 12, boxH = 44;
    doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.5); doc.rect(L, boxTop, 308.5 - L, boxH);
    font('normal', 9);
    doc.text(`Please remit to ${c.name || ''}`, L + 8, boxTop + 15);
    doc.text(`A/C No: ${c.account || ''} Sort Code: ${c.sortCode || ''}`, L + 8, boxTop + 25.5);
    doc.text(`IBAN: ${c.iban || ''}`, L + 8, boxTop + 36);
    doc.setDrawColor(...BLUE); doc.setLineWidth(0.75); doc.line(71.3, boxTop + boxH + 32, 528, boxTop + boxH + 32);

    doc.setProperties({ title: `Invoice ${inv.number}`, creator: c.name || '' });
    return doc.output('blob');
  }

  function invoiceFileName(inv) {
    return safe(`ERE_construction_Invoice_${dmy(inv.date, '_')} - ${inv.project}`) + '.pdf';
  }

  // ------------------------------------------------------------------ salaries XLSX
  // Cell style ids come from the original sheet's styles.xml.
  const S = { Header: 1, HeaderPlain: 2, HeaderMoney: 3, Text: 2, Date: 6, Money: 7, Site: 10, TotalLabel: 11, TotalMoney: 12, Payroll: 14 };
  const xmlEsc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  const TEMPLATE_URL = new URL('templates/salaries-template.xlsx', document.currentScript.src).href;
  let templateBytes;
  async function template() {
    if (!templateBytes) {
      const r = await fetch(TEMPLATE_URL);
      if (!r.ok) throw new Error('Could not load the salaries template.');
      templateBytes = await r.arrayBuffer();
    }
    return templateBytes;
  }

  // sal: { date (yyyy-mm-dd), site, workers: [{ name, pps, amount }], owner: { name, pps, amount } | null }
  async function salariesXlsx(sal) {
    const [y, m, d] = sal.date.split('-').map(Number);
    const serial = (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
    const strings = [];
    const str = t => { t = String(t ?? ''); let i = strings.indexOf(t); if (i < 0) { strings.push(t); i = strings.length - 1; } return i; };
    const cs = (ref, s, t) => `<c r="${ref}" s="${s}" t="s"><v>${str(t)}</v></c>`;
    const cn = (ref, s, n) => `<c r="${ref}" s="${s}"><v>${Number(n) || 0}</v></c>`;
    const row = (n, cells) => `<row r="${n}" ht="14.25" customHeight="1">${cells.join('')}</row>`;
    const person = (n, p, site) => row(n, [
      ...(site ? [cs(`A${n}`, S.Site, site)] : []),
      cs(`B${n}`, S.Text, p.pps), cs(`C${n}`, S.Text, p.name), cn(`D${n}`, S.Date, serial), cn(`E${n}`, S.Money, p.amount)
    ]);

    const rows = [row(1, [cs('A1', S.Header, 'Site No /  Name'), cs('B1', S.HeaderPlain, 'PPS No:'), cs('C1', S.HeaderPlain, 'Sub Name'),
                          cs('D1', S.Header, 'Date '), cs('E1', S.HeaderMoney, 'Gross Payment')])];
    let r = 4;
    for (const w of sal.workers) rows.push(person(r++, w));
    const last = r - 1, totalRow = last + 3;
    const sum = Math.round(sal.workers.reduce((s, w) => s + (Number(w.amount) || 0), 0) * 100) / 100;
    rows.push(row(totalRow, [cs(`C${totalRow}`, S.TotalLabel, 'Total '), `<c r="D${totalRow}" s="${S.TotalLabel}"/>`,
      `<c r="E${totalRow}" s="${S.TotalMoney}">${sal.workers.length ? `<f>SUM(E4:E${last})</f>` : ''}<v>${sum}</v></c>`]));
    if (sal.owner && sal.owner.name) {
      const pr = totalRow + 2;
      rows.push(row(pr, [cs(`C${pr}`, S.Payroll, 'PAYROLL')]));
      rows.push(person(pr + 2, sal.owner, sal.site));
    }
    const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
      strings.map(t => `<si><t xml:space="preserve">${xmlEsc(t)}</t></si>`).join('') + '</sst>';

    const zip = await JSZip.loadAsync(await template());
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    zip.file('xl/worksheets/sheet1.xml', sheet.replace('{{ROWS}}', rows.join('')));
    zip.file('xl/sharedStrings.xml', sst);
    const wb = await zip.file('xl/workbook.xml').async('string');
    zip.file('xl/workbook.xml', wb.replace('{{SHEET_NAME}}', dmy(sal.date, '.')));
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function salariesFileName(sal) { return `${dmy(sal.date, '.')}-E.R.E. Construction salaries.xlsx`; }

  function safe(s) { return String(s).replace(/[\\/:*?"<>|]/g, '-').trim(); }

  return { invoicePdf, invoiceFileName, salariesXlsx, salariesFileName, eur, money, dmy };
})();

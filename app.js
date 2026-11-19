// E.R.E Documents: forms, history and settings. Everything is stored on this device.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const { eur, money, dmy } = Docs;
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
const plain = n => String(+Number(n).toFixed(4));            // 2 -> "2", 1.6 -> "1.6"
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const ppsOk = s => /^\d{7}[A-Z]{1,2}$/i.test(String(s).replace(/\s/g, ''));
const byId = (list, id) => list.find(x => x.id === id);
const clone = o => JSON.parse(JSON.stringify(o));

// No personal details in here: this file is public. Real data is typed in Settings or imported from a backup file.
const DEFAULTS = {
  version: 1,
  company: { name: '', vat: '', number: '', mobile: '', email: '', address1: '', address2: '', account: '', sortCode: '', iban: '',
             vatNote: 'VAT on this supply to be accounted for by the principal contractor' },
  clients: [], defaultClient: null,
  sites: [], defaultSite: null,
  itemTypes: [{ id: 'block', name: 'Block', unit: 'block', rate: 2 }, { id: 'brick', name: 'Brick', unit: 'brick', rate: 1.6 }],
  workers: [],
  owner: { name: '', pps: '', lastAmount: '', pay: true },
  nextInvoiceNumber: 1,
  history: []
};
const LISTS = ['clients', 'sites', 'itemTypes', 'workers', 'history'];

function normalize(d) {
  const out = { ...clone(DEFAULTS), ...(d || {}) };
  out.company = { ...DEFAULTS.company, ...(d?.company || {}) };
  out.owner = { ...DEFAULTS.owner, ...(d?.owner || {}) };
  for (const k of LISTS) out[k] = Array.isArray(out[k]) ? out[k] : [];
  out.nextInvoiceNumber = Math.max(1, parseInt(out.nextInvoiceNumber) || 1);
  delete out.deleted; out.history.forEach(h => delete h.file);   // left over from the old Google Drive version
  return out;
}

// ------------------------------------------------------------------ storage (this device only)
const LS_DATA = 'ere.data';
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

let data = normalize(lsGet(LS_DATA));
// Call after every change to `data`.
const changed = () => lsSet(LS_DATA, data);

// Clear what the old Google Drive version left behind (sign-in token, sync state, upload queue).
try { ['ere.meta', 'ere.driveToken', 'ere.driveIds'].forEach(k => localStorage.removeItem(k)); indexedDB.deleteDatabase('ere-documents'); } catch { /* nothing to clear */ }

// ------------------------------------------------------------------ toast, tabs, misc
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

$$('nav button').forEach(b => b.onclick = () => showTab(b.dataset.go));
function showTab(name) {
  $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.go === name));
  $$('section[data-tab]').forEach(s => s.classList.toggle('active', s.dataset.tab === name));
  if (name === 'invoice') renderInvoiceForm(false);
  if (name === 'salaries') renderSalaries();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
$$('[data-close]').forEach(b => b.onclick = () => $('#' + b.dataset.close).classList.remove('open'));
$('[data-go-settings]').onclick = () => showTab('settings');

function renderBanner() { $('#setup-banner').hidden = !!data.company.name; }

const ADD = '__add__';
function fillSelect(sel, list, selected, addLabel) {
  sel.innerHTML = list.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') +
    `<option value="${ADD}">${addLabel}</option>`;
  sel.value = list.some(x => x.id === selected) ? selected : (list[0]?.id ?? ADD);
}
function addSite(name) {
  name = name.trim(); if (!name) return null;
  let s = data.sites.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!s) { s = { id: uid(), name }; data.sites.push(s); if (!data.defaultSite) data.defaultSite = s.id; changed(); }
  return s;
}

// Sharing / downloading a generated file.
async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadFile(blob, name);
}
function downloadFile(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const canShare = () => !!navigator.canShare && navigator.canShare({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] });

// Builds the file for a history entry (documents are re-created from the saved details).
async function fileFor(h) {
  if (h.type === 'invoice') return { blob: Docs.invoicePdf(h.doc), name: h.fileName };
  return { blob: await Docs.salariesXlsx(h.doc), name: h.fileName };
}

function uniqueName(name) {
  const taken = new Set(data.history.map(h => h.fileName));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  for (let n = 2; ; n++) { const c = `${name.slice(0, dot)} (${n})${name.slice(dot)}`; if (!taken.has(c)) return c; }
}

// ------------------------------------------------------------------ results panel
const results = {};   // tab -> { historyId, blob }
function showResult(tab, h, blob) { results[tab] = { historyId: h.id, blob }; refreshResults(); }
function refreshResults() {
  for (const [tab, r] of Object.entries(results)) {
    const h = byId(data.history, r.historyId); if (!h) continue;
    const el = $(`#${tab === 'invoice' ? 'inv' : 'sal'}-result`);
    const title = h.type === 'invoice' ? `Invoice ${h.number} created` : 'Salaries sheet created';
    const note = 'Downloaded to this device. You can download it again from History any time.';
    el.className = 'result ok';
    el.innerHTML = `<b>✓ ${esc(title)}</b><div class="muted" style="font-size:13px;word-break:break-word">${esc(h.fileName)}</div>
      <div class="files">
        ${canShare() ? `<button class="btn small" data-res-share="${tab}">Share…</button>` : ''}
        <button class="btn small" data-res-dl="${tab}">Download</button>
        ${tab === 'invoice' ? '<button class="btn small" data-newinv>New invoice</button>' : ''}
      </div>
      <div class="note">${note}</div>`;
  }
}
document.addEventListener('click', e => {
  const s = e.target.closest('[data-res-share],[data-res-dl]');
  if (s) {
    const tab = s.dataset.resShare || s.dataset.resDl, r = results[tab], h = byId(data.history, r.historyId);
    (s.dataset.resShare ? shareFile : downloadFile)(r.blob, h.fileName);
  }
  if (e.target.closest('[data-newinv]')) { renderInvoiceForm(true); window.scrollTo(0, 0); }
});

// ------------------------------------------------------------------ invoice
let items = [], numberTouched = false, dateTouched = false;

function newLine(type) {
  const t = type || data.itemTypes[0];
  return t ? { kind: 'type', typeId: t.id, qty: '', rate: t.rate, text: '', amount: '' } : { kind: 'custom', text: '', amount: '' };
}
const lineAmount = l => l.kind === 'custom' ? round2(num(l.amount)) : round2(num(l.qty) * num(l.rate));
function lineText(l) {
  if (l.kind === 'custom') return String(l.text || '').trim();
  const t = byId(data.itemTypes, l.typeId) || { name: l.typeName || '', unit: l.unit || '' };
  return `${plain(num(l.qty))} ${t.name} @ ${plain(num(l.rate))}/${t.unit}`;
}
const invoiceTotal = () => round2(items.reduce((s, l) => s + lineAmount(l), 0));

function renderInvoiceForm(reset) {
  if (reset || !items.length) {
    numberTouched = dateTouched = false;
    items = [newLine()];
    $('#inv-result').className = 'result'; delete results.invoice;
    fillSelect($('#inv-client'), data.clients, data.defaultClient, '＋ Add a new company…');
    fillSelect($('#inv-site'), data.sites, data.defaultSite, '＋ Add a new site…');
    $('#inv-attention').value = byId(data.clients, $('#inv-client').value)?.attention || '';
  } else {
    fillSelect($('#inv-client'), data.clients, $('#inv-client').value, '＋ Add a new company…');
    fillSelect($('#inv-site'), data.sites, $('#inv-site').value, '＋ Add a new site…');
  }
  if (!numberTouched) $('#inv-number').value = data.nextInvoiceNumber;
  if (!dateTouched) $('#inv-date').value = today();
  renderLines(); updateInvoice();
}

function renderLines() {
  const opts = sel => data.itemTypes.map(t => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('') +
                      `<option value="custom" ${sel === 'custom' ? 'selected' : ''}>Other (type it in)</option>`;
  $('#lines').innerHTML = items.map((l, i) => {
    const custom = l.kind === 'custom', t = byId(data.itemTypes, l.typeId);
    return `<div class="line ${custom ? 'custom' : ''}" data-i="${i}">
      <div class="c-type"><span class="lbl">Item</span><select data-k="type">${opts(custom ? 'custom' : l.typeId)}</select></div>
      ${custom
        ? `<div class="c-qty"><span class="lbl">Description</span><input data-k="text" value="${esc(l.text)}" placeholder="e.g. Day work, 3 days"></div>
           <div class="c-rate"></div>`
        : `<div class="c-qty"><span class="lbl">How many ${esc(t ? t.unit + 's' : '')}</span><input data-k="qty" type="number" min="0" step="any" inputmode="decimal" class="num" value="${esc(l.qty)}" placeholder="0"></div>
           <div class="c-rate"><span class="lbl">Rate (€)</span><input data-k="rate" type="number" min="0" step="any" inputmode="decimal" class="num" value="${esc(l.rate)}"></div>`}
      <div class="c-amt amt">${custom
        ? `<span class="lbl">Amount (€)</span><input data-k="amount" type="number" min="0" step="0.01" inputmode="decimal" class="num" value="${esc(l.amount)}" placeholder="0.00" style="max-width:150px">`
        : `<span class="lbl">Amount</span><span data-amt>${eur(lineAmount(l))}</span>`}</div>
      <div class="c-del"><button class="btn icon" data-del title="Remove line" aria-label="Remove line">×</button></div>
    </div>`;
  }).join('');
}

$('#lines').addEventListener('input', e => {
  const row = e.target.closest('[data-i]'); if (!row) return;
  const l = items[+row.dataset.i], k = e.target.dataset.k;
  if (k === 'type') {
    if (e.target.value === 'custom') {
      const had = lineAmount(l) > 0;
      Object.assign(l, { kind: 'custom', text: had ? lineText(l) : '', amount: had ? lineAmount(l) : '' });
    } else {
      const t = byId(data.itemTypes, e.target.value);
      Object.assign(l, { kind: 'type', typeId: t.id, rate: t.rate });
    }
    renderLines();
  } else {
    l[k] = e.target.value;
    const a = row.querySelector('[data-amt]'); if (a) a.textContent = eur(lineAmount(l));
  }
  updateInvoice();
});
$('#lines').addEventListener('click', e => {
  if (!e.target.closest('[data-del]')) return;
  items.splice(+e.target.closest('[data-i]').dataset.i, 1);
  if (!items.length) items.push(newLine());
  renderLines(); updateInvoice();
});
$('#add-item').onclick = () => {
  const last = items[items.length - 1];
  items.push(newLine(last?.kind === 'type' ? byId(data.itemTypes, last.typeId) : undefined));
  renderLines(); updateInvoice();
  $$('#lines .line').at(-1).querySelector('input')?.focus();
};

$('#inv-client').onchange = e => {
  if (e.target.value === ADD) { $('#add-client').classList.add('open'); $('#new-client-name').focus(); return; }
  $('#add-client').classList.remove('open');
  $('#inv-attention').value = byId(data.clients, e.target.value)?.attention || '';
  updateInvoice();
};
$('#new-client-save').onclick = () => {
  const name = $('#new-client-name').value.trim(); if (!name) return $('#new-client-name').focus();
  const c = { id: uid(), name, attention: $('#new-client-att').value.trim() };
  data.clients.push(c); if (!data.defaultClient) data.defaultClient = c.id; changed();
  fillSelect($('#inv-client'), data.clients, c.id, '＋ Add a new company…');
  $('#inv-attention').value = c.attention;
  $('#new-client-name').value = $('#new-client-att').value = '';
  $('#add-client').classList.remove('open'); updateInvoice(); toast(`Added ${name}`);
};
$('#inv-site').onchange = e => {
  if (e.target.value === ADD) { $('#add-site-inv').classList.add('open'); $('#new-site-inv').focus(); return; }
  $('#add-site-inv').classList.remove('open'); updateInvoice();
};
$('#new-site-inv-save').onclick = () => {
  const s = addSite($('#new-site-inv').value); if (!s) return $('#new-site-inv').focus();
  fillSelect($('#inv-site'), data.sites, s.id, '＋ Add a new site…');
  $('#new-site-inv').value = ''; $('#add-site-inv').classList.remove('open'); updateInvoice();
};
$('#inv-number').addEventListener('input', () => { numberTouched = true; updateInvoice(); });
$('#inv-date').addEventListener('input', () => { dateTouched = true; updateInvoice(); });
$('#inv-attention').addEventListener('input', updateInvoice);

function invoiceForm() {
  return {
    number: $('#inv-number').value.trim(), date: $('#inv-date').value,
    billTo: byId(data.clients, $('#inv-client').value)?.name || '',
    attention: $('#inv-attention').value.trim(),
    project: byId(data.sites, $('#inv-site').value)?.name || '',
    lines: items.filter(l => lineAmount(l) || (l.kind === 'custom' && String(l.text).trim()))
  };
}
const invoiceExists = n => data.history.some(h => h.type === 'invoice' && String(h.number) === String(n));

function updateInvoice() {
  const f = invoiceForm(), c = data.company, total = invoiceTotal();
  $('#inv-total').textContent = eur(total);
  $('#inv-number-warn').textContent = invoiceExists(f.number) ? `Invoice ${f.number} already exists (see History).` : '';
  $('#inv-filename').textContent = f.date && f.project ? `File name: ${Docs.invoiceFileName(f)}` : '';
  const rows = f.lines.length ? f.lines.map(l => `<tr><td>${esc(lineText(l))}</td><td>${eur(lineAmount(l))}</td></tr>`).join('')
                              : `<tr><td class="muted">No lines yet</td><td></td></tr>`;
  $('#preview').innerHTML = `
    <div class="top">
      <div><div class="co">${esc(c.name)}</div><div class="grey">VAT Reg # ${esc(c.vat)}</div><div class="grey">Company Number ${esc(c.number)}</div></div>
      <div><div>Date: ${esc(dmy(f.date))}</div><b>${esc(c.name)}</b><div><b>Mobile:</b> ${esc(c.mobile)}</div>
        <div><b>Email:</b> ${esc(c.email)}</div><div><b>Address:</b> ${esc(c.address1)}</div><div>${esc(c.address2)}</div></div>
    </div>
    <div class="inv">Invoice ${esc(f.number)}</div>
    <div class="proj"><div><b>Project:</b> ${esc(f.project)}</div>
    ${f.attention ? `<div><b>Attention:</b> ${esc(f.attention)}</div>` : ''}
    <div><b>Bill To:</b> ${esc(f.billTo)}</div></div>
    <table><tr><th>Description</th><th>Amount</th></tr>${rows}<tr><td class="blank"></td><td class="tot">${eur(total)}</td></tr></table>
    <div class="note">${esc(c.vatNote)}</div>
    <div class="bank">Please remit to ${esc(c.name)}<br>A/C No: ${esc(c.account)} Sort Code: ${esc(c.sortCode)}<br>IBAN: ${esc(c.iban)}</div>`;
}

$('#inv-generate').onclick = async () => {
  const out = $('#inv-result'), btn = $('#inv-generate');
  const fail = msg => { out.className = 'result err'; out.textContent = msg; };
  let f = invoiceForm();
  const problems = [];
  if (!f.number) problems.push('an invoice number');
  if (!f.date) problems.push('a date');
  if (!f.billTo) problems.push('a company to bill');
  if (!f.project) problems.push('a project / site');
  if (!f.lines.length) problems.push('at least one line with an amount');
  if (f.lines.some(l => l.kind === 'custom' && !String(l.text).trim())) problems.push('a description for every "Other" line');
  if (problems.length) return fail('Please add ' + problems.join(', ') + '.');

  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    if (invoiceExists(f.number)) {
      if (!numberTouched) {
        $('#inv-number').value = data.nextInvoiceNumber; updateInvoice();
        return fail(`Invoice ${f.number} already exists. The number is now ${data.nextInvoiceNumber}. Check it and press Create again.`);
      }
      if (!confirm(`Invoice ${f.number} already exists. Create another one with the same number?`)) return;
    }
    f = invoiceForm();
    const total = invoiceTotal();
    const doc = {
      number: f.number, date: f.date, billTo: f.billTo, attention: f.attention, project: f.project,
      lines: f.lines.map(l => ({ description: lineText(l), amount: lineAmount(l) })), total, company: clone(data.company)
    };
    const blob = Docs.invoicePdf(doc);
    const h = {
      id: uid(), type: 'invoice', createdAt: new Date().toISOString(), number: f.number, date: f.date,
      billTo: f.billTo, attention: f.attention, project: f.project, total,
      lines: f.lines.map(l => ({ ...l, typeName: byId(data.itemTypes, l.typeId)?.name, unit: byId(data.itemTypes, l.typeId)?.unit })),
      doc, fileName: uniqueName(Docs.invoiceFileName(doc))
    };
    data.history.unshift(h);
    if (+f.number >= data.nextInvoiceNumber) data.nextInvoiceNumber = +f.number + 1;
    changed();
    numberTouched = false;
    $('#inv-number').value = data.nextInvoiceNumber;
    updateInvoice();
    showResult('invoice', h, blob);
    downloadFile(blob, h.fileName);
  } catch (e) {
    fail(e.message);
  } finally { btn.disabled = false; btn.textContent = 'Create invoice PDF'; }
};

// ------------------------------------------------------------------ salaries
function renderSalaries() {
  if (!$('#sal-date').value) $('#sal-date').value = today();
  fillSelect($('#sal-site'), data.sites, $('#sal-site').value || data.defaultSite, '＋ Add a new site…');
  const row = (p, attrs, removable) => `
    <div class="person ${p.pay ? '' : 'off'}" ${attrs}>
      <input type="checkbox" data-k="pay" ${p.pay ? 'checked' : ''} aria-label="Pay ${esc(p.name)}">
      <div class="who"><b>${esc(p.name) || '<span class="muted">Set in Settings</span>'}</b>
        <span>${esc(p.pps)}${p.pps && !ppsOk(p.pps) ? ' <span class="warn" title="PPS numbers are usually 7 digits and 1–2 letters">⚠ check</span>' : ''}</span></div>
      <input data-k="amount" type="number" min="0" step="0.01" inputmode="decimal" class="num" placeholder="€" value="${esc(p.lastAmount ?? '')}" aria-label="Gross payment">
      ${removable ? `<button class="btn icon" data-delworker title="Remove worker" aria-label="Remove worker">×</button>` : '<span></span>'}
    </div>`;
  $('#workers').innerHTML = data.workers.length ? data.workers.map(w => row(w, `data-id="${esc(w.id)}"`, true)).join('')
    : '<div class="empty">No workers yet. Add one below.</div>';
  $('#owner').innerHTML = row(data.owner, 'data-owner', false);
  updateSalaries();
}
function updateSalaries() {
  const total = round2(data.workers.filter(w => w.pay).reduce((s, w) => s + num(w.lastAmount), 0));
  $('#sal-total').textContent = eur(total);
  const d = $('#sal-date').value;
  $('#sal-filename').textContent = d ? `File name: ${Docs.salariesFileName({ date: d })}` : '';
}
function personEdit(e) {
  const row = e.target.closest('.person'); if (!row) return;
  const p = row.hasAttribute('data-owner') ? data.owner : byId(data.workers, row.dataset.id);
  if (e.target.dataset.k === 'pay') { p.pay = e.target.checked; row.classList.toggle('off', !p.pay); }
  if (e.target.dataset.k === 'amount') p.lastAmount = e.target.value === '' ? '' : num(e.target.value);
  changed(); updateSalaries();
}
$('#workers').addEventListener('input', personEdit);
$('#owner').addEventListener('input', personEdit);
$('#workers').addEventListener('click', e => {
  const b = e.target.closest('[data-delworker]'); if (!b) return;
  const w = byId(data.workers, b.closest('.person').dataset.id);
  if (!confirm(`Remove ${w.name} from the list of workers?`)) return;
  data.workers = data.workers.filter(x => x !== w);
  changed(); renderSalaries();
});
$('#sal-date').addEventListener('input', updateSalaries);
$('#sal-site').onchange = e => $('#add-site-sal').classList.toggle('open', e.target.value === ADD);
$('#new-site-sal-save').onclick = () => {
  const s = addSite($('#new-site-sal').value); if (!s) return $('#new-site-sal').focus();
  fillSelect($('#sal-site'), data.sites, s.id, '＋ Add a new site…');
  $('#new-site-sal').value = ''; $('#add-site-sal').classList.remove('open');
};
$('#add-worker-open').onclick = () => { $('#add-worker').classList.add('open'); $('#new-worker-name').focus(); };
$('#new-worker-save').onclick = () => {
  const name = $('#new-worker-name').value.trim(), pps = $('#new-worker-pps').value.replace(/\s/g, '').toUpperCase();
  if (!name) return $('#new-worker-name').focus();
  if (pps && !ppsOk(pps) && !confirm(`"${pps}" doesn't look like a PPS number (7 digits + 1–2 letters). Add anyway?`)) return;
  const amt = $('#new-worker-amount').value;
  data.workers.push({ id: uid(), name, pps, lastAmount: amt === '' ? '' : num(amt), pay: true });
  changed();
  $('#new-worker-name').value = $('#new-worker-pps').value = $('#new-worker-amount').value = '';
  $('#add-worker').classList.remove('open'); renderSalaries(); toast(`Added ${name}`);
};

$('#sal-generate').onclick = async () => {
  const out = $('#sal-result'), btn = $('#sal-generate');
  const date = $('#sal-date').value, site = byId(data.sites, $('#sal-site').value)?.name || '';
  const workers = data.workers.filter(w => w.pay), o = data.owner;
  const missing = v => v === '' || v == null;
  const problems = [];
  if (!date) problems.push('a date');
  if (!workers.length && !o.pay) problems.push('at least one person to pay');
  const noAmount = workers.filter(w => missing(w.lastAmount)).map(w => w.name);
  if (noAmount.length) problems.push('an amount for ' + noAmount.join(', '));
  if (o.pay && !o.name) problems.push("the owner's name (Settings)");
  if (o.pay && missing(o.lastAmount)) problems.push('an amount for the owner');
  if (o.pay && !site) problems.push('a site');
  if (problems.length) { out.className = 'result err'; out.textContent = 'Please add ' + problems.join(', ') + '.'; return; }
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const doc = {
      date, site,
      workers: workers.map(w => ({ name: w.name, pps: w.pps, amount: num(w.lastAmount) })),
      owner: o.pay ? { name: o.name, pps: o.pps, amount: num(o.lastAmount) } : null
    };
    const blob = await Docs.salariesXlsx(doc);
    const h = {
      id: uid(), type: 'salaries', createdAt: new Date().toISOString(), date, site,
      total: round2(doc.workers.reduce((s, w) => s + w.amount, 0)), doc,
      fileName: uniqueName(Docs.salariesFileName(doc))
    };
    data.history.unshift(h);
    changed();
    showResult('salaries', h, blob);
    downloadFile(blob, h.fileName);
  } catch (e) {
    out.className = 'result err'; out.textContent = e.message;
  } finally { btn.disabled = false; btn.textContent = 'Create salaries sheet'; }
};

// ------------------------------------------------------------------ history
function renderHistory() {
  const q = $('#hist-search').value.trim().toLowerCase(), type = $('#hist-type').value;
  const list = data.history.filter(h => (!type || h.type === type) &&
    (!q || JSON.stringify([h.number, h.billTo, h.project, h.site, dmy(h.date), h.fileName, h.doc?.workers?.map(p => p.name), h.doc?.owner?.name]).toLowerCase().includes(q)));
  $('#history').innerHTML = list.length ? list.map(h => {
    const inv = h.type === 'invoice';
    const people = inv ? 0 : (h.doc?.workers?.length || 0) + (h.doc?.owner ? 1 : 0);
    return `<div class="hist">
      <span class="badge ${inv ? 'inv' : 'sal'}">${inv ? 'Invoice' : 'Salaries'}</span>
      <div class="main"><b>${inv ? 'Invoice ' + esc(h.number) : esc(dmy(h.date)) + ' · ' + people + ' people'}</b>
        <div>${inv ? esc(dmy(h.date)) + ' · ' + esc(h.billTo) + ' · ' + esc(h.project) : esc(h.site)}</div></div>
      <div class="amount">${eur(h.total)}</div>
      <div class="btns">
        ${canShare() ? `<button class="btn small" data-hshare="${esc(h.id)}">Share…</button>` : ''}
        <button class="btn small" data-hdl="${esc(h.id)}">Download</button>
        <button class="btn small" data-again="${esc(h.id)}" title="Start a new document with the same details">Copy</button>
      </div></div>`;
  }).join('') : `<div class="empty">${data.history.length ? 'Nothing matches your search.' : 'Documents you create will show up here.'}</div>`;
}
$('#hist-search').addEventListener('input', renderHistory);
$('#hist-type').onchange = renderHistory;
$('#history').addEventListener('click', async e => {
  const b = e.target.closest('[data-hshare],[data-hdl],[data-again]'); if (!b) return;
  const h = byId(data.history, b.dataset.hshare || b.dataset.hdl || b.dataset.again);
  if (b.dataset.again) return copyFromHistory(h);
  try { const { blob, name } = await fileFor(h); (b.dataset.hshare ? shareFile : downloadFile)(blob, name); }
  catch (err) { toast(err.message); }
});
function copyFromHistory(h) {
  if (h.type === 'invoice') {
    renderInvoiceForm(true);
    const c = data.clients.find(x => x.name === h.billTo), s = data.sites.find(x => x.name === h.project);
    if (c) $('#inv-client').value = c.id;
    if (s) $('#inv-site').value = s.id;
    $('#inv-attention').value = h.attention || '';
    items = (h.lines || []).map(l => {
      const copy = { ...l };
      if (copy.kind === 'type' && !byId(data.itemTypes, copy.typeId)) Object.assign(copy, { kind: 'custom', text: lineText(l), amount: lineAmount(l) });
      return copy;
    });
    if (!items.length) items = [newLine()];
    showTab('invoice');
    toast('Copied. Check the lines and press Create.');
  } else {
    for (const w of data.workers) {
      const p = h.doc.workers.find(x => x.name === w.name && x.pps === w.pps);
      w.pay = !!p; if (p) w.lastAmount = p.amount;
    }
    if (h.doc.owner) Object.assign(data.owner, { pay: true, lastAmount: h.doc.owner.amount }); else data.owner.pay = false;
    changed();
    $('#sal-date').value = today();
    const s = data.sites.find(x => x.name === h.site);
    showTab('salaries');
    if (s) $('#sal-site').value = s.id;
    toast('Copied the amounts from that sheet.');
  }
}

// ------------------------------------------------------------------ settings
const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
function setPath(o, p, v) { const ks = p.split('.'), last = ks.pop(); ks.reduce((x, k) => x[k], o)[last] = v; }

function renderSettings() {
  $$('[data-bind]').forEach(i => i.value = getPath(data, i.dataset.bind) ?? '');
  const del = '<button class="btn icon" data-del title="Remove" aria-label="Remove">×</button>';
  $('#set-clients').innerHTML = data.clients.map(c => `
    <div class="srow clients" data-id="${esc(c.id)}"><input data-k="name" value="${esc(c.name)}" aria-label="Company">
      <input data-k="attention" value="${esc(c.attention)}" aria-label="Attention">
      <span class="def"><input type="radio" name="defclient" ${data.defaultClient === c.id ? 'checked' : ''} aria-label="Default"></span>${del}</div>`).join('')
    || '<div class="empty">No companies yet.</div>';
  $('#set-sites').innerHTML = data.sites.map(s => `
    <div class="srow sites" data-id="${esc(s.id)}"><input data-k="name" value="${esc(s.name)}" aria-label="Site">
      <span class="def"><input type="radio" name="defsite" ${data.defaultSite === s.id ? 'checked' : ''} aria-label="Default"></span>${del}</div>`).join('')
    || '<div class="empty">No sites yet.</div>';
  $('#set-items').innerHTML = data.itemTypes.map(t => `
    <div class="srow items" data-id="${esc(t.id)}"><input data-k="name" value="${esc(t.name)}" aria-label="Item name">
      <input data-k="unit" value="${esc(t.unit)}" aria-label="Unit">
      <input data-k="rate" type="number" min="0" step="any" inputmode="decimal" class="num" value="${esc(t.rate)}" aria-label="Price">${del}</div>`).join('');
}

$$('[data-bind]').forEach(i => i.addEventListener('input', () => {
  let v = i.value;
  if (i.type === 'number') v = Math.max(1, parseInt(v) || 1);
  setPath(data, i.dataset.bind, v); changed();
  if (i.dataset.bind.startsWith('company')) renderBanner();
}));

function wireList(sel, listKey, defKey, label) {
  const box = $(sel);
  box.addEventListener('input', e => {
    const row = e.target.closest('[data-id]'); if (!row) return;
    const item = byId(data[listKey], row.dataset.id);
    if (e.target.type === 'radio') data[defKey] = item.id;
    else item[e.target.dataset.k] = e.target.dataset.k === 'rate' ? num(e.target.value) : e.target.value;
    changed();
  });
  box.addEventListener('click', e => {
    if (!e.target.closest('[data-del]')) return;
    const id = e.target.closest('[data-id]').dataset.id, item = byId(data[listKey], id);
    if (listKey === 'itemTypes' && data.itemTypes.length === 1) return toast(`Keep at least one ${label}.`);
    if (!confirm(`Remove "${item.name}"?`)) return;
    data[listKey] = data[listKey].filter(x => x.id !== id);
    if (defKey && data[defKey] === id) data[defKey] = data[listKey][0]?.id ?? null;
    changed(); renderSettings();
  });
}
wireList('#set-clients', 'clients', 'defaultClient', 'company');
wireList('#set-sites', 'sites', 'defaultSite', 'site');
wireList('#set-items', 'itemTypes', null, 'item');
function addAndFocus(listKey, item, defKey, sel) {
  data[listKey].push(item);
  if (defKey && !data[defKey]) data[defKey] = item.id;
  changed(); renderSettings();
  $$(`${sel} input[data-k=name]`).at(-1).select();
}
$('#set-add-client').onclick = () => addAndFocus('clients', { id: uid(), name: 'New company', attention: '' }, 'defaultClient', '#set-clients');
$('#set-add-site').onclick = () => addAndFocus('sites', { id: uid(), name: 'New site' }, 'defaultSite', '#set-sites');
$('#set-add-item').onclick = () => addAndFocus('itemTypes', { id: uid(), name: 'New item', unit: 'piece', rate: 0 }, null, '#set-items');

$('#backup-download').onclick = () => {
  downloadFile(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `ERE-documents-backup-${dmy(today(), '-')}.json`);
};
$('#backup-import').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!imported || typeof imported !== 'object' || !imported.company) throw new Error('This file is not an ERE Documents data file.');
    if (!confirm('Replace all lists, settings and history on this device with the contents of this file?')) return;
    data = normalize(imported);
    changed();
    numberTouched = false;
    renderSettings(); renderBanner();
    toast('Data imported.');
  } catch (err) { toast(err.message); }
};

// ------------------------------------------------------------------ start
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !dateTouched && $('#inv-date').value !== today()) { $('#inv-date').value = today(); updateInvoice(); }
});

renderBanner();
renderInvoiceForm(true);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// MyPACS home page. Data comes from the backend (/api/studies, /api/orders, /api/patients via MyApi in api.js)
// when the page is served by it, else from MockStore (mockstore.js). Motion helpers from MyFx (fx.js).
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize);
const ROW = 12.386;                       // row height in rem (Figma pitch)

let filter = MockStore.settings().tab || '', query = '', state = '', selected = null, shown = [];
let rows = [], live = false, loadError = '';   // rows: one per study, same shape live or offline (see fromStudy)
const home = $('#home'), wl = $('#wl'), inner = $('#wl-in');
const hl = el('div', 'wl-hl');

// ---- Backend -> worklist rows ----
// DICOM modality code -> the app's tabs (same map as upload.js). Unknown codes keep their own name (All tab only).
const MOD = { CT: 'CT', MR: 'MRI', CR: 'X-Ray', DX: 'X-Ray', US: 'USG', PT: 'PET' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SEX = { 'Laki-laki': 'M', 'Perempuan': 'F' };            // patients.GENDERS in the backend
const PRI = { CITO: 'STAT', Biasa: 'ROUTINE' };                 // order.data.priority: 'Biasa' (default) or 'CITO'
function ageOf(birth) {
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(birth || ''); if (!b) return null;
  const t = new Date(); let a = t.getFullYear() - b[1];
  if (t.getMonth() + 1 < +b[2] || (t.getMonth() + 1 === +b[2] && t.getDate() < +b[3])) a--;
  return a >= 0 ? a : null;
}
// long exam names break at the space nearest the middle, like the two-line exams in the design
function twoLines(t) {
  if (t.length <= 16 || t.includes('\n')) return t;
  let best = -1; for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - t.length / 2) < Math.abs(best - t.length / 2))) best = i;
  return best < 0 ? t : t.slice(0, best) + '\n' + t.slice(best + 1);
}
// Unread: images in, no reading yet. Draft: a reading saved but not sent (study.draft, from the viewer's Save Draft;
// or reading fields stored at upload). Final: sent to SATUSEHAT.
const stateOf = (s) => s.sent ? 'Final' : (s.draft || s.icd10 || s.diagnosis || s.finding) ? 'Draft' : 'Unread';
function fromStudy(s, orderOf, patientOf) {
  const p = patientOf[s.nik] || {}, o = orderOf[s.order_id] || null, d = (o && o.data) || {};
  const sex = SEX[s.gender || p.gender] || '', age = ageOf(s.birthDate || p.birthDate);
  const c = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s.created || '');
  const kind = /\.nii(\.gz)?$/i.test(s.file || '') ? 'NIfTI' : 'DICOM';
  return {
    key: s.id, id: s.id, name: s.name || p.name || '-', mrn: s.nik || '-', sex, mod: MOD[s.modality] || s.modality || '',
    ageSex: age == null && !sex ? '-' : (age == null ? '-' : age) + ' / ' + (sex || '-'),
    pri: PRI[d.priority] || 'ROUTINE', exam: twoLines(s.description || s.modality || '-'),
    date: c ? +c[3] + ' ' + MONTHS[c[2] - 1] + ' ' + c[1] : '-', clock: c ? c[4] + '.' + c[5] + ' WIB' : '-',
    state: stateOf(s),
    seriesText: s.file ? (s.modality ? s.modality + ' · ' : '') + '1 ' + kind + ' file' : 'No images yet',
    history: s.clinical || (d.indication && d.indication.text) || '-',
    referrer: s.doctor || d.requester || '-',
  };
}
async function load() {
  live = await MyApi.ready;
  if (!live) {
    rows = MockStore.all().map(r => ({ ...r, key: r.mrn }));
    setOrders(MockStore.orders().filter(o => o.status === 'Requested').length);
    return;
  }
  $('#q').placeholder = 'Search name or NIK'; $('#l-mrn').textContent = 'NIK';
  const [st, od, pt] = await Promise.allSettled([MyApi.get('studies'), MyApi.get('orders'), MyApi.get('patients')]);
  const orders = od.status === 'fulfilled' ? od.value : [];
  const orderOf = Object.fromEntries(orders.map(o => [o.id, o]));
  const patientOf = pt.status === 'fulfilled' ? Object.fromEntries(pt.value.map(p => [p.nik, p])) : {};
  setOrders(od.status === 'fulfilled' ? orders.filter(o => o.status === 'requested').length : '-');
  if (st.status === 'fulfilled') { rows = st.value.map(s => fromStudy(s, orderOf, patientOf)); loadError = ''; }
  else {
    rows = [];
    loadError = st.reason && st.reason.status === 403 ? 'Your account cannot open the worklist.' : 'Could not load the worklist from the server.';
  }
}
function setOrders(n) { $('#n-orders').textContent = n; }

// ---- Reading queue numbers + modalities table ----
function renderStats() {
  const c = { Unread: 0, Draft: 0, Final: 0 }; rows.forEach(r => c[r.state]++);
  MyFx.count($('#n-unread'), c.Unread); MyFx.count($('#n-draft'), c.Draft, 2); MyFx.count($('#n-final'), c.Final, 2);
}
function modalities() {                                       // unread studies by modality and sex
  const out = [['CT-Scan', 'CT'], ['MRI', 'MRI'], ['X-Ray', 'X-Ray'], ['Ultrasound', 'USG'], ['PET', 'PET']];
  const n = (mod, sex) => rows.filter(r => r.state === 'Unread' && r.mod === mod && r.sex === sex).length;
  return out.map(([label, mod]) => [label, n(mod, 'F'), n(mod, 'M'), mod]);
}
function renderMods() {
  const box = $('#mods'); box.textContent = '';
  const nameTop = [34.2, 38.1, 41.9, 45.8, 49.7], cy = [34.2, 38.1, 42, 45.9, 49.8];
  const sqTop = [33.1, 36.9, 40.8, 44.7, 48.6];
  modalities().forEach(([name, f, m, mod], i) => {
    const hit = el('button', 'mod-hit'); hit.style.top = cy[i] - 1.8 + 'rem'; hit.title = 'Show ' + name + ' in the worklist';
    hit.addEventListener('click', () => setTab(mod));
    const sq = el('i', 'sq'); sq.style.cssText = `top:${sqTop[i]}rem;height:2.3rem;background-image:url(assets/mod/${({ CT: 'ct', MRI: 'mri', 'X-Ray': 'xray', USG: 'usg', PET: 'pet' })[mod]}.svg)`;
    const n = el('span', 't', name); n.style.cssText = `left:142.1rem;top:${nameTop[i]}rem;font-size:2rem;pointer-events:none`;
    const fn = el('span', 'num', '0'); fn.style.cssText = `left:159.7rem;top:${cy[i]}rem`;
    const fl = el('span', 't xl', 'Female'); fl.style.cssText = `left:160.5rem;top:${cy[i] + .05}rem;font-size:2rem;pointer-events:none`;
    const mn = el('span', 'num', '0'); mn.style.cssText = `left:172.8rem;top:${cy[i]}rem`;
    const ml = el('span', 't xl', 'Male'); ml.style.cssText = `left:${i ? 173.6 : 173.7}rem;top:${cy[i] + .05}rem;font-size:2rem;pointer-events:none`;
    box.append(hit, sq, n, fn, fl, mn, ml);
    MyFx.count(fn, f); MyFx.count(mn, m);
  });
}

// ---- Worklist ----
function visibleRows() {
  const q = query.trim().toLowerCase();
  return rows.filter(r => (state ? r.state === state : r.state !== 'Final') && (!filter || r.mod === filter) &&
    (!q || r.name.toLowerCase().includes(q) || r.mrn.toLowerCase().includes(q)));
}
// a 16-digit NIK is wider than the design's MRN: a smaller size keeps it clear of the age column
const mrnCell = (v) => { const s = el('span', 'c mrn', v); if (v.length > 10) s.style.fontSize = '1.6rem'; return s; };
function renderList(keep) {                                // keep: a quiet refresh (no entrance, scroll stays)
  shown = visibleRows();
  const top = wl.scrollTop;
  inner.textContent = '';
  if (!shown.length) { inner.append(el('p', 'empty', loadError || 'No studies match.')); selected = null; clearPreview(); syncBars(); return; }
  if (!shown.some(r => r.key === selected)) selected = shown[0].key;
  inner.append(hl);
  shown.forEach((r, i) => {
    const b = el('button', 'row'); b.type = 'button'; b.dataset.key = r.key; b.style.setProperty('--r', Math.min(i, 9));
    if (keep) b.style.animation = 'none';
    const name = el('span', 'c name', r.name), exam = el('span', 'c exam', r.exam);
    name.title = r.name; exam.title = r.exam.replace('\n', ' ');          // long ones are cut short (mypacs.css)
    if (r.name.length > 14) name.style.fontSize = '2.6rem';                 // a little smaller first, so most names still fit
    b.append(el('span', 'hl'), el('span', 'pri ' + r.pri.toLowerCase(), r.pri),
      name, mrnCell(r.mrn), el('span', 'c age', r.ageSex),
      exam, el('span', 'c date', r.date), el('span', 'c time', r.clock), el('span', 'c state', r.state === 'Final' ? 'Finalized' : r.state));
    b.addEventListener('click', () => select(r.key));
    b.addEventListener('dblclick', () => { location.href = viewerUrl(r); });
    inner.append(b);
  });
  wl.scrollTop = keep ? top : 0;
  select(selected, true);
}
// live: the archive study id (the viewer reads ?study=); offline: the dummy MRN, as before
const viewerUrl = (r, extra) => 'viewer.html?' + (r.id ? 'study=' + encodeURIComponent(r.id) : 'mrn=' + encodeURIComponent(r.mrn)) + (extra || '');
function select(key, quiet) {
  selected = key;
  const i = shown.findIndex(r => r.key === key);
  inner.querySelectorAll('.row').forEach((b, n) => {
    b.classList.toggle('sel', n === i); b.classList.toggle('pre-sel', n === i - 1);
    b.setAttribute('aria-pressed', n === i);
  });
  hl.style.translate = '0 ' + i * ROW + 'rem';
  if (!quiet) {                                           // keep the selected row in view
    const top = i * ROW * rem(), h = ROW * rem();
    if (top < wl.scrollTop) wl.scrollTop = top; else if (top + h > wl.scrollTop + wl.clientHeight - 6 * rem()) wl.scrollTop = top + h - wl.clientHeight + 6 * rem();
  }
  renderPreview(); syncBars();
}
wl.addEventListener('keydown', (e) => {
  const i = shown.findIndex(r => r.key === selected);
  if (e.key === 'ArrowDown' && i < shown.length - 1) { e.preventDefault(); select(shown[i + 1].key); }
  if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); select(shown[i - 1].key); }
  if (e.key === 'Enter' && i >= 0) location.href = viewerUrl(shown[i]);
});

// ---- Preview ----
function renderPreview() {
  const r = shown.find(x => x.key === selected); if (!r) return;
  MyFx.swap($('#p-name'), r.name); MyFx.swap($('#p-mrn'), r.mrn);
  MyFx.swap($('#p-series'), r.seriesText); MyFx.swap($('#p-hist'), r.history); MyFx.swap($('#p-ref'), r.referrer);
  const th = $('#thumbs');
  if (th.dataset.key !== r.key) {
    th.dataset.key = r.key; th.textContent = '';
    if (live) {                                           // the backend has no thumbnail route: one plain tile
      const ph = el('div'); ph.setAttribute('role', 'img'); ph.setAttribute('aria-label', 'No preview image');
      ph.style.cssText = 'flex:none;width:16.6rem;height:16.6rem;border-radius:1rem;background:var(--glass-5)'; th.append(ph);
    } else for (let i = 0; i < r.series; i++) { const im = el('img'); im.src = r.thumb || 'assets/ct-thumb.jpg'; im.alt = 'Series ' + (i + 1); im.style.setProperty('--r', i); th.append(im); }
    th.scrollLeft = 0;
  }
  $('#b-view').href = viewerUrl(r);
  $('#b-edit').href = viewerUrl(r, '&report=1');
}
function clearPreview() {
  ['#p-name', '#p-mrn', '#p-series', '#p-hist', '#p-ref'].forEach(s => { $(s).textContent = ''; });
  const th = $('#thumbs'); th.textContent = ''; th.dataset.key = '';
}

// ---- Tabs ----
function moveSel() {
  const tabs = $('#tabs'), on = tabs.querySelector('[aria-selected="true"]'), sel = tabs.querySelector('.sel'), r = rem();
  const w = (on.offsetWidth - .8 * r) + 4.8 * r;                // label width + 48 Figma px, like the "All" pill
  sel.style.width = w / r + 'rem';
  sel.style.left = Math.max(0, Math.min(tabs.offsetWidth - w, on.offsetLeft - w / 2)) / r + 'rem';
}
function setTab(mod) {
  filter = mod;
  document.querySelectorAll('#tabs button').forEach(x => x.setAttribute('aria-selected', x.dataset.m === mod));
  moveSel(); renderList();
}
document.querySelectorAll('#tabs button').forEach(b => {
  b.setAttribute('aria-selected', b.dataset.m === filter);
  b.addEventListener('click', () => setTab(b.dataset.m));
});

// ---- Reading queue tiles filter by report state ----
document.querySelectorAll('[data-state]').forEach(b => {
  if (b === home) return;
  b.addEventListener('click', () => { state = state === b.dataset.state ? '' : b.dataset.state; home.dataset.state = state; renderList(); });
});

// ---- Search ----
const search = $('#search'), q = $('#q');
search.addEventListener('click', () => { search.classList.add('open'); q.focus(); });
q.addEventListener('input', () => { query = q.value; renderList(); });
q.addEventListener('blur', () => { if (!q.value) search.classList.remove('open'); });
q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; query = ''; renderList(); q.blur(); } });
addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); search.click(); } });

// ---- Scroll bars (Figma sizes; they follow the scroll, and the tall one can be dragged) ----
const vbar = $('#vbar'), V_TOP = 82.1, V_TRAVEL = 30;
function syncBars() {
  const max = wl.scrollHeight - wl.clientHeight, th = $('#thumbs'), h = $('#hbar');
  vbar.style.top = V_TOP + (max > 0 ? wl.scrollTop / max : 0) * V_TRAVEL + 'rem';
  vbar.style.opacity = max > 0 ? 1 : .35;
  wl.classList.toggle('scrolled', wl.scrollTop > 4);
  const hmax = th.scrollWidth - th.clientWidth;
  h.style.left = 139.5 + (hmax > 0 ? th.scrollLeft / hmax : 0) * (39 - 28.4) + 'rem';
  h.style.opacity = hmax > 0 ? 1 : .35;
}
wl.addEventListener('scroll', syncBars, { passive: true });
$('#thumbs').addEventListener('scroll', syncBars, { passive: true });
vbar.addEventListener('pointerdown', (e) => {
  vbar.setPointerCapture(e.pointerId); vbar.classList.add('drag');
  const y0 = e.clientY, s0 = wl.scrollTop, max = wl.scrollHeight - wl.clientHeight;
  wl.style.scrollBehavior = 'auto';
  const move = (ev) => { wl.scrollTop = s0 + (ev.clientY - y0) / (V_TRAVEL * rem()) * max; };
  const up = () => { vbar.classList.remove('drag'); wl.style.scrollBehavior = ''; vbar.removeEventListener('pointermove', move); vbar.removeEventListener('pointerup', up); };
  vbar.addEventListener('pointermove', move); vbar.addEventListener('pointerup', up);
});
$('#thumbs').addEventListener('wheel', (e) => { if (e.deltaY && !e.shiftKey) { e.preventDefault(); $('#thumbs').scrollLeft += e.deltaY; } }, { passive: false });
addEventListener('resize', moveSel);

load().then(() => { renderStats(); renderMods(); renderList(); seen = signature(); });

// Live: look again when the tab comes back (a report sent or images uploaded in another tab), at most every 5 s,
// and redraw only when something changed.
let seen = '', lastLook = Date.now();
const signature = () => JSON.stringify([$('#n-orders').textContent, rows.map(r => [r.key, r.state, r.pri, r.name, r.exam, r.history])]);
async function lookAgain() {
  if (!live || document.hidden || Date.now() - lastLook < 5000) return;
  lastLook = Date.now();
  await load();
  const now = signature(); if (now === seen) return;
  seen = now; renderStats(); renderMods(); renderList(true);
}
addEventListener('focus', lookAgain);
document.addEventListener('visibilitychange', lookAgain);
(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(moveSel);
moveSel();

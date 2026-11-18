// MyPACS home page. Data comes from MockStore (mockstore.js); motion helpers from MyFx (fx.js).
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize);
const ROW = 12.386;                       // row height in rem (Figma pitch)

let filter = MockStore.settings().tab || '', query = '', state = '', selected = null, shown = [];
const home = $('#home'), wl = $('#wl'), inner = $('#wl-in');
const hl = el('div', 'wl-hl');

// ---- Reading queue numbers + modalities table ----
function renderStats() {
  const c = MockStore.stats();
  MyFx.count($('#n-unread'), c.Unread); MyFx.count($('#n-draft'), c.Draft, 2); MyFx.count($('#n-final'), c.Final, 2);
}
(function mods() {
  const box = $('#mods');
  const nameTop = [34.2, 38.1, 41.9, 45.8, 49.7], cy = [34.2, 38.1, 42, 45.9, 49.8];
  const sqTop = [33.1, 36.9, 40.8, 44.7, 48.6], sqH = [2.2, 2.3, 2.3, 2.2, 2.2];
  MockStore.modalities().forEach(([name, f, m, mod], i) => {
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
})();

// ---- Worklist ----
function visibleRows() {
  const q = query.trim().toLowerCase();
  return MockStore.all().filter(r => (state ? r.state === state : r.state !== 'Final') && (!filter || r.mod === filter) &&
    (!q || r.name.toLowerCase().includes(q) || r.mrn.toLowerCase().includes(q)));
}
function renderList() {
  shown = visibleRows();
  inner.textContent = '';
  if (!shown.length) { inner.append(el('p', 'empty', 'No studies match.')); selected = null; syncBars(); return; }
  if (!shown.some(r => r.mrn === selected)) selected = shown[0].mrn;
  inner.append(hl);
  shown.forEach((r, i) => {
    const b = el('button', 'row'); b.type = 'button'; b.dataset.mrn = r.mrn; b.style.setProperty('--r', Math.min(i, 9));
    b.append(el('span', 'hl'), el('span', 'pri ' + r.pri.toLowerCase(), r.pri),
      el('span', 'c name', r.name), el('span', 'c mrn', r.mrn), el('span', 'c age', r.ageSex),
      el('span', 'c exam', r.exam), el('span', 'c date', r.date), el('span', 'c time', r.clock), el('span', 'c state', r.state === 'Final' ? 'Finalized' : r.state));
    b.addEventListener('click', () => select(r.mrn));
    b.addEventListener('dblclick', () => { location.href = 'viewer.html?mrn=' + r.mrn; });
    inner.append(b);
  });
  wl.scrollTop = 0;
  select(selected, true);
}
function select(mrn, quiet) {
  selected = mrn;
  const i = shown.findIndex(r => r.mrn === mrn);
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
  const i = shown.findIndex(r => r.mrn === selected);
  if (e.key === 'ArrowDown' && i < shown.length - 1) { e.preventDefault(); select(shown[i + 1].mrn); }
  if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); select(shown[i - 1].mrn); }
  if (e.key === 'Enter' && selected) location.href = 'viewer.html?mrn=' + selected;
});

// ---- Preview ----
function renderPreview() {
  const r = MockStore.get(selected); if (!r) return;
  MyFx.swap($('#p-name'), r.name); MyFx.swap($('#p-mrn'), r.mrn);
  MyFx.swap($('#p-series'), r.seriesText); MyFx.swap($('#p-hist'), r.history); MyFx.swap($('#p-ref'), r.referrer);
  const th = $('#thumbs');
  if (th.dataset.mrn !== r.mrn) {
    th.dataset.mrn = r.mrn; th.textContent = '';
    for (let i = 0; i < r.series; i++) { const im = el('img'); im.src = r.thumb || 'assets/ct-thumb.jpg'; im.alt = 'Series ' + (i + 1); im.style.setProperty('--r', i); th.append(im); }
    th.scrollLeft = 0;
  }
  $('#b-view').href = 'viewer.html?mrn=' + r.mrn;
  $('#b-edit').href = 'viewer.html?mrn=' + r.mrn + '&report=1';
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

renderStats();
renderList();
(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(moveSel);
moveSel();

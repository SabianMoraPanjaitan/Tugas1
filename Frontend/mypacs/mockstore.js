// MockStore — DUMMY DATA ONLY. Invented names and placeholder text for the design prototype;
// nothing here is clinical or comes from a real patient. Swap this file for API calls later:
// every page only talks to window.MockStore.
(function () {
  const KEY = 'mypacs.store.v2', SET_KEY = 'mypacs.settings.v1';

  // small seeded random, so everyone sees the same list
  let seed = 20261114;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const SUR = ['Wijaya', 'Pratama', 'Hidayat', 'Kusuma', 'Saputra', 'Lestari', 'Nugroho', 'Permana', 'Halim', 'Siregar', 'Tanjung', 'Maharani', 'Gunawan', 'Setiawan', 'Purnomo', 'Anggraini', 'Wibowo', 'Susanto', 'Hartono', 'Ramadhan', 'Utami', 'Kurniawan', 'Santika', 'Irawan'];
  const GIVEN = { F: ['Dewi', 'Ayu', 'Rina', 'Maya', 'Indah', 'Sari', 'Putri', 'Nadia', 'Laras', 'Citra', 'Wulan', 'Tiara', 'Fitri', 'Anisa'], M: ['Agus', 'Dimas', 'Rizky', 'Bayu', 'Eko', 'Fajar', 'Hendra', 'Joko', 'Yoga', 'Arif', 'Reza', 'Tono', 'Gilang', 'Iwan'] };
  const EXAMS = {
    CT: ['CT Thorax\nContrast', 'CT Abdomen', 'CT Head', 'CT Sinus'],
    MRI: ['MRI Brain', 'MRI Abdomen', 'MRI Lumbar', 'MRI Knee'],
    'X-Ray': ['X-Ray Femur', 'X-Ray Thorax', 'X-Ray Wrist', 'X-Ray Pelvis'],
    USG: ['ACL\nUltrasound', 'Abdomen\nUltrasound', 'Thyroid\nUltrasound'],
    PET: ['PET FDG-18'],
  };
  const HISTORY = ['Follow-up imaging, routine evaluation.', 'Persistent discomfort, further assessment requested.', 'Pre-operative assessment.', 'Post-treatment follow-up.', 'Screening requested by the referring unit.', 'Evaluation after a minor fall.'];
  const REFS = ['dr. John Mypechs, Sp.Rad', 'dr. Jane Doe, Sp.PD', 'dr. Josh Geez, Sp.OT', 'dr. Lorem Ipsum, Sp.B'];
  const MONTH = 'November';

  // the six rows drawn in the Figma file, kept exactly
  const FIGMA = [
    { pri: 'STAT', name: 'Santoso, Budi', mrn: 'MR-004921', age: 42, sex: 'M', mod: 'CT', exam: 'CT Thorax\nContrast', day: 14, time: '15.16', state: 'Unread', series: 4, images: 312, history: 'Chronic cough in 3 months, rule out pulmonary nodule.', referrer: REFS[0] },
    { pri: 'URGENT', name: 'Rahayu, Siti', mrn: 'MR-001615', age: 34, sex: 'F', mod: 'MRI', exam: 'MRI Brain', day: 14, time: '14.40', state: 'Draft' },
    { pri: 'ROUTINE', name: 'Lorem, Ipsum', mrn: 'MR-004551', age: 44, sex: 'M', mod: 'MRI', exam: 'MRI Abdomen', day: 14, time: '14.02', state: 'Unread' },
    { pri: 'URGENT', name: 'Hellena, Bella', mrn: 'MR-004527', age: 12, sex: 'F', mod: 'PET', exam: 'PET FDG-18', day: 14, time: '13.31', state: 'Draft' },
    { pri: 'ROUTINE', name: 'Ipsum, Lorem', mrn: 'MR-002364', age: 42, sex: 'M', mod: 'USG', exam: 'ACL\nUltrasound', day: 14, time: '13.00', state: 'Unread' },
    { pri: 'ROUTINE', name: 'Editha, Agnes', mrn: 'MR-007584', age: 42, sex: 'F', mod: 'X-Ray', exam: 'X-Ray Femur', day: 13, time: '16.37', state: 'Unread' },
  ];

  function build() {
    seed = 20261114;
    // Unread must add up to the Figma "Modalities" table: 30 unread in total
    const want = { CT: [8, 4], MRI: [4, 2], 'X-Ray': [3, 5], USG: [1, 1], PET: [2, 0] };
    FIGMA.filter(r => r.state === 'Unread').forEach(r => want[r.mod][r.sex === 'F' ? 0 : 1]--);
    const slots = [];
    Object.entries(want).forEach(([mod, [f, m]]) => { for (let i = 0; i < f; i++) slots.push([mod, 'F', 'Unread']); for (let i = 0; i < m; i++) slots.push([mod, 'M', 'Unread']); });
    slots.push(['CT', 'M', 'Draft']);                                   // 3 drafts with the two Figma ones
    for (let i = 0; i < 19; i++) slots.push([pick(Object.keys(EXAMS)), rnd() < .5 ? 'F' : 'M', 'Final']);
    shuffle(slots);

    const used = new Set(FIGMA.map(r => r.mrn)), names = new Set(FIGMA.map(r => r.name));
    let minutes = 13 * 24 * 60 + 16 * 60 + 10;                          // 13 Nov 16.10, going back in time
    const rows = FIGMA.map(r => ({ ...r }));
    slots.forEach(([mod, sex, state]) => {
      let mrn; do { mrn = 'MR-00' + String(1000 + Math.floor(rnd() * 8999)); } while (used.has(mrn)); used.add(mrn);
      let name; do { name = pick(SUR) + ', ' + pick(GIVEN[sex]); } while (names.has(name)); names.add(name);
      minutes -= 14 + Math.floor(rnd() * 34);
      const p = rnd(), day = Math.floor(minutes / 1440), hm = minutes % 1440;
      rows.push({ pri: state === 'Final' ? 'ROUTINE' : p < .08 ? 'STAT' : p < .32 ? 'URGENT' : 'ROUTINE', name, mrn, age: 8 + Math.floor(rnd() * 70), sex, mod,
        exam: pick(EXAMS[mod]), day, time: String(Math.floor(hm / 60)).padStart(2, '0') + '.' + String(hm % 60).padStart(2, '0'), state });
    });
    rows.forEach(r => {
      r.series = r.series || 1 + Math.floor(rnd() * 5);
      r.images = r.images || r.series * (40 + Math.floor(rnd() * 50));
      r.history = r.history || pick(HISTORY);
      r.referrer = r.referrer || pick(REFS);
      r.findings = r.state === 'Unread' ? '' : 'Draft findings (dummy text).';
      r.impression = r.state === 'Final' ? 'Impression (dummy text).' : '';
    });
    return rows;
  }

  let rows;
  try { rows = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { rows = null; }
  if (!Array.isArray(rows) || !rows.length) rows = build();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (_) {} };

  // ---- installations and radiology orders (dummy) ----
  const ORD_KEY = 'mypacs.orders.v1';
  // The other units of the hospital that send requests to Radiology. Rename to match the class SIMRS.
  const INST = [
    { id: 'igd', name: 'Emergency', local: 'IGD' }, { id: 'rajal', name: 'Outpatient', local: 'Rawat Jalan' },
    { id: 'ranap', name: 'Inpatient', local: 'Rawat Inap' }, { id: 'icu', name: 'Intensive Care', local: 'ICU' },
    { id: 'bedah', name: 'Surgery', local: 'Bedah' },
  ];
  const PATIENTS = [
    ['Halim, Citra', 'MR-009101', 29, 'F'], ['Nugroho, Bayu', 'MR-009102', 51, 'M'], ['Lestari, Wulan', 'MR-009103', 37, 'F'], ['Siregar, Hendra', 'MR-009104', 63, 'M'],
    ['Utami, Nadia', 'MR-009105', 18, 'F'], ['Gunawan, Reza', 'MR-009106', 45, 'M'], ['Maharani, Tiara', 'MR-009107', 56, 'F'], ['Purnomo, Gilang', 'MR-009108', 9, 'M'],
    ['Anggraini, Fitri', 'MR-009109', 71, 'F'], ['Hartono, Yoga', 'MR-009110', 33, 'M'], ['Tanjung, Laras', 'MR-009111', 24, 'F'], ['Wibowo, Arif', 'MR-009112', 40, 'M'],
  ].map(([name, mrn, age, sex]) => ({ name, mrn, age, sex }));
  function buildOrders() {
    const P = PATIENTS, mk = (n, dept, p, pri, mod, exam, status, time, extra) => ({ id: 'ORD-' + String(n).padStart(4, '0'), dept, ...p, pri, mod, exam, status,
      history: HISTORY[n % HISTORY.length], referrer: REFS[n % REFS.length], day: 14, time, files: [], ...extra });
    const list = [
      mk(1, 'igd', P[0], 'STAT', 'CT', 'CT Head', 'Requested', '15.42'),
      mk(2, 'rajal', P[1], 'ROUTINE', 'X-Ray', 'X-Ray Thorax', 'Requested', '15.20'),
      mk(3, 'ranap', P[2], 'URGENT', 'MRI', 'MRI Brain', 'Requested', '15.05'),
      mk(4, 'icu', P[3], 'URGENT', 'X-Ray', 'X-Ray Thorax', 'Accepted', '14.31'),
      mk(5, 'bedah', P[4], 'ROUTINE', 'CT', 'CT Abdomen', 'Accepted', '13.58'),
      mk(6, 'rajal', P[5], 'ROUTINE', 'USG', 'Abdomen\nUltrasound', 'Requested', '13.12'),
      mk(9, 'rajal', P[6], 'ROUTINE', 'PET', 'PET FDG-18', 'Rejected', '11.47', { note: 'Duplicate request (dummy text).' }),
    ];
    // two orders that already have a study in the worklist: one waiting to be read, one reported
    const link = (n, dept, r) => { if (!r) return; r.order = 'ORD-' + String(n).padStart(4, '0'); r.dept = dept;
      list.push({ id: r.order, dept, name: r.name, mrn: r.mrn, age: r.age, sex: r.sex, pri: r.pri, mod: r.mod, exam: r.exam, status: 'Imaged', study: r.mrn, history: r.history, referrer: r.referrer, day: r.day, time: r.time, files: [] }); };
    link(7, 'igd', rows.find(r => r.state === 'Unread' && !r.order && !FIGMA.some(f => f.mrn === r.mrn)));
    link(8, 'ranap', rows.find(r => r.state === 'Final' && !r.order));
    return list;
  }
  let orders;
  try { orders = JSON.parse(localStorage.getItem(ORD_KEY) || 'null'); } catch (_) { orders = null; }
  if (!Array.isArray(orders)) { orders = buildOrders(); save(); }
  const saveOrders = () => { try { localStorage.setItem(ORD_KEY, JSON.stringify(orders)); } catch (_) {} };
  const instOf = (id) => INST.find(i => i.id === id) || { id, name: id, local: '' };
  // what the sender sees: Requested, Accepted, Rejected, Imaged (waiting for the radiologist), Reported
  const orderView = (o) => { const st = o.study && rows.find(r => r.mrn === o.study); return { ...o, inst: instOf(o.dept), ageSex: o.age + ' / ' + o.sex, date: o.day + ' ' + MONTH + ' 2026', clock: o.time + ' WIB',
    status: st && st.state === 'Final' ? 'Reported' : o.status, impression: st && st.state === 'Final' ? st.impression : '', findings: st && st.state === 'Final' ? st.findings : '' }; };
  const nowTime = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + '.' + String(d.getMinutes()).padStart(2, '0'); };

  const DEFAULTS = { background: true, lighting: true, motion: true, size: '100', tab: '', name: 'John Doe', email: 'johndoe@gmail.com' };
  const view = (r) => ({ ...r, ageSex: r.age + ' / ' + r.sex, date: r.day + ' ' + MONTH + ' 2026', clock: r.time + ' WIB', seriesText: r.series + ' Series (' + r.images + ' Images)' });

  // another tab changed the data (an installation sent a request, Radiology accepted it): read it again
  if (typeof addEventListener === 'function') addEventListener('storage', (e) => {
    try { if (e.key === KEY) rows = JSON.parse(e.newValue) || rows; if (e.key === ORD_KEY) orders = JSON.parse(e.newValue) || orders; } catch (_) {}
  });

  window.MockStore = {
    all: () => rows.map(view),
    get: (mrn) => { const r = rows.find(x => x.mrn === mrn); return r ? view(r) : null; },
    update(mrn, patch) { const r = rows.find(x => x.mrn === mrn); if (r) { Object.assign(r, patch); save(); } return r ? view(r) : null; },
    stats() { const c = { Unread: 0, Draft: 0, Final: 0 }; rows.forEach(r => c[r.state]++); return c; },
    modalities() {                                                       // unread studies by modality and sex
      const out = [['CT-Scan', 'CT'], ['MRI', 'MRI'], ['X-Ray', 'X-Ray'], ['Ultrasound', 'USG'], ['PET', 'PET']];
      return out.map(([label, mod]) => [label, rows.filter(r => r.state === 'Unread' && r.mod === mod && r.sex === 'F').length,
        rows.filter(r => r.state === 'Unread' && r.mod === mod && r.sex === 'M').length, mod]);
    },
    reset() { rows = build(); orders = buildOrders(); save(); saveOrders(); },
    installations: () => INST.map(i => ({ ...i, open: orders.filter(o => o.dept === i.id && (o.status === 'Requested' || o.status === 'Accepted')).length })),
    installation: instOf,
    patients: () => PATIENTS.map(p => ({ ...p })),
    exams: () => JSON.parse(JSON.stringify(EXAMS)),
    referrers: () => REFS.slice(),
    orders: () => orders.map(orderView),
    order: (id) => { const o = orders.find(x => x.id === id); return o ? orderView(o) : null; },
    addOrder(o) {
      const n = orders.reduce((m, x) => Math.max(m, +x.id.slice(4)), 0) + 1;
      const rec = { id: 'ORD-' + String(n).padStart(4, '0'), status: 'Requested', day: 14, time: nowTime(), files: [], ...o };
      orders.unshift(rec); saveOrders(); return orderView(rec);
    },
    updateOrder(id, patch) { const o = orders.find(x => x.id === id); if (o) { Object.assign(o, patch); saveOrders(); } return o ? orderView(o) : null; },
    // images arrived for an order: the study joins the radiologist's worklist as Unread
    addStudy(orderId, info) {
      const o = orders.find(x => x.id === orderId); if (!o) return null;
      let mrn = o.mrn; if (rows.some(r => r.mrn === mrn)) mrn = o.mrn + '-' + o.id.slice(4);   // one worklist row per study
      const row = { pri: o.pri, name: o.name, mrn, age: o.age, sex: o.sex, mod: o.mod, exam: o.exam, day: 14, time: nowTime(), state: 'Unread',
        series: 1, images: 0, history: o.history, referrer: o.referrer, findings: '', impression: '', order: o.id, dept: o.dept, ...info };
      rows.unshift(row); o.status = 'Imaged'; o.study = mrn; save(); saveOrders(); return view(row);
    },
    settings() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SET_KEY) || '{}') }; } catch (_) { return { ...DEFAULTS }; } },
    setSetting(k, v) { const s = this.settings(); s[k] = v; try { localStorage.setItem(SET_KEY, JSON.stringify(s)); } catch (_) {} return s; },
  };
})();

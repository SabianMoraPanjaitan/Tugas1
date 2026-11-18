// MyPACS viewer: axial, sagittal and coronal views of a real volume plus a 3D pane, with reading tools.
// All image maths lives in pacs-engine.js; this file is the page: panes, tools, panels and the report.
(function () {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const E = PacsEngine, params = new URLSearchParams(location.search);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let study = MockStore.get(params.get('mrn')) || MockStore.all()[0];
  const dock = $('#dock'), grid = $('#grid');
  const DEFAULT = { CT: 'CT_phantom', PET: 'PET_phantom' };   // sample series shown for a dummy study of that modality

  const S = { vol: null, P: [0, 0, 0], lo: 0, hi: 1, preset: '', cmap: 'grey', invert: false, filter: '', slab: 0, tool: 'cross', layout: '2x2', big: 'ax', active: 'ax', ann: [], pending: null, hover: null, seriesId: '' };
  let metas = [], lut = new Uint32Array(65536), lutDirty = true, annId = 0;

  // ================= backend (live) =================
  // When the FastAPI backend serves this page, studies, images and the report come from it (MyApi).
  // Otherwise everything below falls back to MockStore and the sample series, as in the prototype.
  let live = false, me = null, canReport = true, archive = [], orderPri = {}, loadTok = 0;
  const REPORT_ROLES = ['radiolog', 'admin'];                     // backend: REPORTERS
  const IMP = '\n\nImpression: ';                                  // the backend keeps one reading text ("finding")
  const joinFinding = (f, imp) => imp ? f + IMP + imp : f;
  const splitFinding = (txt, diag) => { txt = txt || ''; const i = txt.indexOf(IMP); return i < 0 ? [txt, diag || ''] : [txt.slice(0, i), txt.slice(i + IMP.length)]; };
  // No backend route keeps a draft, so drafts stay in this browser (localStorage), per study.
  const DKEY = id => 'mypacs.viewer.draft.' + id;
  const getDraft = id => { try { return JSON.parse(localStorage.getItem(DKEY(id)) || 'null'); } catch (_) { return null; } };
  const putDraft = (id, d) => { try { localStorage.setItem(DKEY(id), JSON.stringify(d)); return true; } catch (_) { return false; } };
  const dropDraft = id => { try { localStorage.removeItem(DKEY(id)); } catch (_) {} };
  function ageOf(iso) {
    const d = new Date(iso); if (!iso || isNaN(d)) return '';
    const n = new Date(); let a = n.getFullYear() - d.getFullYear();
    if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--;
    return a;
  }
  // a backend study (GET /api/studies) -> the fields this page shows; "-" where the backend has nothing
  function view(a) {
    const sex = a.gender === 'Perempuan' ? 'F' : a.gender === 'Laki-laki' ? 'M' : '-', age = ageOf(a.birthDate), d = new Date(a.created), ok = a.created && !isNaN(d);
    const pri = orderPri[a.order_id] || '-', draft = a.sent ? null : getDraft(a.id);
    const [findings, impression] = a.sent ? splitFinding(a.finding, a.diagnosis) : draft ? [draft.findings || '', draft.impression || ''] : ['', ''];
    return {
      api: a, mrn: a.id, pri, priClass: pri.toUpperCase() === 'CITO' ? 'stat' : pri === '-' ? '' : 'routine',
      name: a.name || '-', ageSex: (age === '' ? '-' : age) + ' / ' + sex, exam: a.description || a.modality || '-', mod: a.modality || '',
      date: ok ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '-',
      clock: ok ? String(d.getHours()).padStart(2, '0') + '.' + String(d.getMinutes()).padStart(2, '0') : '',
      history: a.clinical || '-', referrer: a.doctor || '-', findings, impression, state: a.sent ? 'Final' : draft ? 'Draft' : 'Unread',
    };
  }
  function note(text, kind) { const n = $('#r-note'); n.hidden = !text; n.textContent = text || ''; n.className = 'note' + (kind ? ' ' + kind : ''); }
  function sentNote() {
    const a = study && study.api; if (!a || !a.sent) return '';
    return 'Sent to SATUSEHAT' + (a.reported_by ? ' by ' + a.reported_by : '') + '.' + (a.imaging_study_id ? '\nImagingStudy/' + a.imaging_study_id : '') + (a.diagnostic_report_id ? '\nDiagnosticReport/' + a.diagnostic_report_id : '');
  }
  async function startLive() {
    live = true;
    me = await MyApi.user();
    canReport = !!me && REPORT_ROLES.includes(me.role);
    try { archive = await MyApi.get('studies'); }
    catch (e) { blankStudy(); message(e.status === 403 ? 'Your account cannot open the image archive.' : 'Could not read the worklist: ' + e.message); return; }
    try { for (const o of await MyApi.get('orders')) orderPri[o.id] = (o.data && o.data.priority) || ''; } catch (_) {}   // priority lives on the request
    const want = params.get('study') || params.get('mrn'), a = archive.find(x => x.id === want) || archive[0];
    if (!a) { blankStudy(); message('The archive has no studies yet.\nPick a sample series on the left, or open a DICOM folder.'); return; }
    loadStudy(view(a), a.id !== want);
  }
  function blankStudy() {
    study = null; const pri = $('#v-pri'); pri.textContent = '-'; pri.className = 'pri';
    for (const id of ['#v-name', '#v-meta', '#v-exam', '#v-date', '#r-hist', '#r-ref']) $(id).textContent = '';
    $('#r-find').value = $('#r-imp').value = ''; setState('Unread'); paintSeries();
  }

  // ================= study header and report =================
  function loadStudy(s, push) {
    study = s;
    if (push) history.replaceState(null, '', s.api ? 'viewer.html?study=' + encodeURIComponent(s.api.id) : 'viewer.html?mrn=' + s.mrn);
    const pri = $('#v-pri'); pri.textContent = s.pri; pri.className = 'pri ' + (s.priClass != null ? s.priClass : s.pri.toLowerCase());
    MyFx.swap($('#v-name'), s.name); MyFx.swap($('#v-meta'), s.mrn + '   ·   ' + s.ageSex);
    MyFx.swap($('#v-exam'), s.exam.replace('\n', ' ')); MyFx.swap($('#v-date'), (s.date + '  ' + s.clock).trim());
    $('#r-hist').textContent = s.history; $('#r-ref').textContent = s.referrer;
    $('#r-find').value = s.findings || ''; $('#r-imp').value = s.impression || '';
    setState(s.state); document.title = 'MyPACS — ' + s.name;
    if (s.api) { openArchive(s.api); return; }
    const want = s.recon || DEFAULT[s.mod] || '';
    paintSeries();
    if (want && metas.some(m => m.id === want)) openSeries(want);
    else { S.vol = null; S.seriesId = ''; paintSeries(); message('No images are stored for this demo study (' + s.mod + ').\nPick a sample series on the left, or open a DICOM folder.'); }
  }
  function setState(st) {
    const e = $('#r-state'); e.textContent = st === 'Final' ? (live ? 'Sent' : 'Finalized') : st; e.dataset.s = st;
    const done = st === 'Final', ro = done || !canReport || !study;
    $('#r-find').readOnly = $('#r-imp').readOnly = ro;
    $('#r-final').textContent = done ? 'Reopen Report' : 'Finalize';
    $('#r-final').style.display = !canReport || !study || (live && done) ? 'none' : '';   // a sent study cannot be sent again
    $('#r-final').disabled = false;
    $('#r-draft').style.display = ro ? 'none' : '';
    note(!live ? '' : !canReport ? (sentNote() ? sentNote() + '\n' : '') + 'Read only: only a radiologist or admin can write the report.'
      : done ? sentNote() : study ? 'Drafts are kept in this browser only. Finalize sends the report to SATUSEHAT.' : '', done && live ? 'ok' : '');
  }
  $('#r-draft').addEventListener('click', () => {
    if (!study || !canReport) return;
    if (study.api) {
      const ok = putDraft(study.api.id, { findings: $('#r-find').value, impression: $('#r-imp').value });
      study.state = 'Draft'; study.findings = $('#r-find').value; study.impression = $('#r-imp').value;
      setState('Draft'); MyFx.toast(ok ? 'Draft saved in this browser' : 'This browser would not keep the draft'); return;
    }
    study = MockStore.update(study.mrn, { findings: $('#r-find').value, impression: $('#r-imp').value, state: 'Draft' });
    setState('Draft'); MyFx.toast('Draft saved');
  });
  $('#r-final').addEventListener('click', () => {
    if (!study || !canReport) return;
    if (study.api) { finalizeLive(); return; }
    if (study.state === 'Final') { study = MockStore.update(study.mrn, { state: 'Draft' }); setState('Draft'); MyFx.toast('Report reopened as draft'); return; }
    if (!$('#r-find').value.trim()) { $('#r-find').focus(); MyFx.toast('Write the findings first'); return; }
    study = MockStore.update(study.mrn, { findings: $('#r-find').value, impression: $('#r-imp').value, state: 'Final' });
    setState('Final'); MyFx.toast('Report finalized');
  });
  // Finalize = the old PACS page's "Kirim ke SATUSEHAT": POST /api/satusehat/send-study with the study and the reading.
  // Only fields the backend already takes; the ICD-10 code is sent only if the study already has one.
  const errorText = r => { try { const i = r.issue && r.issue[0]; return (i && ((i.details && i.details.text) || i.diagnostics)) || (r.fault && r.fault.faultstring) || JSON.stringify(r).slice(0, 220); } catch (_) { return ''; } };
  async function finalizeLive() {
    const a = study.api, f = $('#r-find').value.trim(), imp = $('#r-imp').value.trim();
    if (!f) { $('#r-find').focus(); MyFx.toast('Write the findings first'); return; }
    const body = { name: a.name || '', nik: a.nik || '', modality: a.modality || '', description: a.description || '', icd10: a.icd10 || '',
      diagnosis: imp, finding: joinFinding(f, imp), instalasi: a.instalasi || 'Instalasi Radiologi', archive_id: a.id };
    const btn = $('#r-final'); btn.disabled = true; btn.textContent = 'Sending…'; note('Sending to SATUSEHAT…');
    let r;
    try { r = await MyApi.post('satusehat/send-study', body); }
    catch (e) {
      if (!study || study.api !== a) return;
      btn.disabled = false; btn.textContent = 'Finalize';
      if (e.status === 409) { a.sent = true; study = view(a); setState('Final'); }   // already sent from elsewhere
      note(e.status === 403 ? 'Only a radiologist or admin can send the report.' : e.status === 409 ? e.detail : 'Could not send: ' + e.message, 'warn');
      return;
    }
    if (r && r.ok) {
      Object.assign(a, { sent: true, icd10: body.icd10, diagnosis: body.diagnosis, finding: body.finding, imaging_study_id: r.imaging_study_id || '', diagnostic_report_id: r.diagnostic_report_id || '', reported_by: me ? me.username : '' });
      dropDraft(a.id);
    }
    if (!study || study.api !== a) return;                          // moved to another study meanwhile
    if (r && r.ok) {
      study = view(a); setState('Final');
      note('Sent to SATUSEHAT (' + (r.mode || '?') + ').\nImagingStudy/' + a.imaging_study_id + '\nDiagnosticReport/' + a.diagnostic_report_id, 'ok');
      MyFx.toast('Report sent to SATUSEHAT (' + (r.mode || '?') + ')');
    } else {
      const bad = ((r && r.logs) || []).find(l => !(Number(l.status) >= 200 && Number(l.status) < 300));
      btn.disabled = false; btn.textContent = 'Finalize';
      note('Not sent (' + ((r && r.mode) || '?') + ')' + (bad ? ': ' + bad.step + ' answered ' + bad.status + (errorText(bad.response || {}) ? ', ' + errorText(bad.response || {}) : '') : '') + '.', 'warn');
    }
  }
  function step(d) {
    if (live) {
      if (!archive.length) return;
      const i = study && study.api ? archive.findIndex(x => x.id === study.api.id) : -1, n = archive[(i + d + archive.length) % archive.length];
      if (n) loadStudy(view(n), true); return;
    }
    const active = MockStore.all().filter(r => r.state !== 'Final' || r.mrn === study.mrn);
    const i = active.findIndex(r => r.mrn === study.mrn), n = active[(i + d + active.length) % active.length];
    if (n) loadStudy(n, true);
  }
  $('#v-prev').addEventListener('click', () => step(-1));
  $('#v-next').addEventListener('click', () => step(1));
  function tab(name) { $$('#tabs button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === name)); $$('#side .tab').forEach(t => t.hidden = t.dataset.tab !== name); }
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) tab(b.dataset.tab); });

  // ================= series =================
  function message(text) { const l = $('#loading'); l.classList.remove('off'); l.classList.toggle('msg', !!text); l.querySelector('span').textContent = text || 'Loading the series…'; }
  // the study's series from the backend: one archived file is one series (its size is known once loaded)
  const archiveMeta = a => ({ id: 'api:' + a.id, label: a.description || a.modality || 'Study', modality: a.modality || '', bodyPart: '', dims: null, archive: true, noFile: !a.file });
  function paintSeries() {
    const box = $('#series'); box.textContent = '';
    const own = [], cur = S.vol && S.vol.meta;
    if (live && study && study.api) own.push(cur && cur.archive && cur.id === 'api:' + study.api.id ? cur : archiveMeta(study.api));
    if (cur && cur.local && !cur.archive) own.push(cur);
    const item = m => {
      const b = document.createElement('button'); b.className = 's-item' + (m.id === S.seriesId ? ' on' : '');
      b.innerHTML = '<b></b><span></span><em></em>';
      b.querySelector('b').textContent = m.label; b.querySelector('span').textContent = (m.modality || '-') + ' ' + (m.bodyPart || '') + '\n' + (m.dims ? m.dims.join(' × ') : m.noFile ? 'No images yet' : '-');
      b.querySelector('span').style.whiteSpace = 'pre';
      const tag = b.querySelector('em'); tag.textContent = m.archive ? 'From the archive' : m.local ? 'From this computer' : m.synthetic ? 'Synthetic phantom' : 'Course data'; if (m.synthetic) tag.className = 'ph';
      if (m.archive) b.addEventListener('click', () => { if (study && study.api && m.id !== (S.vol && S.vol.meta.id)) openArchive(study.api); });
      else if (!m.local) b.addEventListener('click', () => openSeries(m.id));
      box.append(b);
    };
    own.forEach(item);
    if (live && metas.length) { const h = document.createElement('div'); h.className = 's-head'; h.textContent = 'Samples'; box.append(h); }
    metas.forEach(item);
  }
  async function openSeries(id) {
    const tok = ++loadTok;
    message(''); S.seriesId = id; paintSeries();
    try { const v = await E.load(id); if (tok === loadTok) setVolume(v); } catch (e) { if (tok === loadTok) message('Could not load the series: ' + e.message); }
  }
  // An archived study's images, fetched with this tab's login and built in the browser by the engine.
  const isNifti = b => { const u = new Uint8Array(b, 0, Math.min(b.byteLength, 4)); return (u[0] === 0x1F && u[1] === 0x8B) || (b.byteLength >= 348 && new DataView(b).getInt32(0, true) === 348); };
  async function openArchive(a) {
    const tok = ++loadTok, live3 = () => tok === loadTok;
    S.vol = null; S.seriesId = 'api:' + a.id; paintSeries();
    if (!a.file) { message('No images are stored for this study yet.\nPick a sample series on the left, or open a DICOM folder.'); return; }
    message(''); const say = t => { if (live3()) $('#loading span').textContent = t; };
    const prog = (x, n) => say('Building the volume: slice ' + x + ' of ' + n);
    try {
      const nii = /\.nii(\.gz)?$/i.test(a.file), id = encodeURIComponent(a.id);
      let urls = ['studies/' + id + '/file'];
      if (!nii && canReport) {                                     // /slices is for radiolog/admin; others read the one file
        try { const l = await MyApi.get('studies/' + id + '/slices'); if (l && l.urls && l.urls.length) urls = l.urls; }
        catch (e) { if (e.status !== 403) throw e; }
      }
      let done = 0; say(urls.length > 1 ? 'Downloading ' + urls.length + ' images…' : 'Downloading the image…');
      const bufs = await Promise.all(urls.map(async u => {
        const r = await MyApi.fetchRaw(u);
        if (!r.ok) { let d = ''; try { d = (await r.json()).detail || ''; } catch (_) {} throw new Error(r.status === 403 ? 'your account may not open these images' : (d || 'HTTP ' + r.status)); }
        const b = await r.arrayBuffer(); done++; if (urls.length > 1) say('Downloading image ' + done + ' of ' + urls.length); return b;
      }));
      if (!live3()) return;
      let v;
      if (bufs.length === 1 && (nii || isNifti(bufs[0]))) v = await E.fromNifti(bufs[0], a.file.replace(/^[0-9a-f]{12}_/, ''), prog);
      else {
        const items = []; let bad = '';
        bufs.forEach((b, i) => { const t = DicomLite.parse(b); if (t.rows && t.cols && t.pixelOffset) items.push({ file: { name: String(i + 1).padStart(4, '0') + '.dcm', arrayBuffer: async () => b }, tags: t }); else if (t.error) bad = t.error; });
        const groups = DicomLite.group(items).sort((x, y) => y.length - x.length);
        if (!groups.length) throw new Error(bad || 'no DICOM images in this study');
        v = await E.fromDicom(groups[0], prog);
      }
      if (!live3()) return;
      v.meta.id = 'api:' + a.id; v.meta.archive = true; v.meta.label = a.description || v.meta.label;
      setVolume(v);
    } catch (e) { if (live3()) message('Could not load the images: ' + e.message); }
  }
  function setVolume(v) {
    S.vol = v; S.seriesId = v.meta.id; S.P = v.size.map(x => x / 2); S.ann = []; S.pending = null; S.hover = null; S.slab = 0; S.filter = '';
    S.invert = invertByDefault(v); S.cmap = 'grey';
    if (v.meta.flat) { if (S.layout !== 'one') S.layoutBeforeFlat = S.layout; S.big = 'ax'; setLayout('one'); }   // one picture: one pane
    else if (S.layoutBeforeFlat) { setLayout(S.layoutBeforeFlat); S.layoutBeforeFlat = ''; }
    const ps = E.presets(v), first = ps[0]; S.lo = first.lo; S.hi = first.hi; S.preset = first.name;
    for (const k in panes) { panes[k].zoom = 1; panes[k].px = panes[k].py = 0; panes[k].off = null; }
    lutDirty = true;
    const f = $('#frame3d'), msg = $('#msg3d');
    if (v.meta.flat) { f.style.display = 'none'; f.src = 'about:blank'; msg.textContent = 'A single image has no 3D view.'; msg.classList.add('on'); }
    else if (v.meta.local) { f.style.display = ''; msg.classList.remove('on'); local3d = v; f.src = 'recon.html?embed=1&wait=1&t=' + Date.now(); }   // the 3D pane asks for the volume once it is ready
    else { f.style.display = ''; msg.classList.remove('on'); f.src = 'recon.html?embed=1&series=' + encodeURIComponent(v.meta.id); }
    $('#v-3d').href = 'recon.html' + (study ? '?mrn=' + encodeURIComponent(study.mrn) : '?') + (v.meta.local ? '' : '&series=' + encodeURIComponent(v.meta.id));
    paintSeries(); paintDisplay(); paintMeasures(); $('#loading').classList.add('off'); drawAll();
  }
  let local3d = null;
  const invertByDefault = v => v.modality === 'PET' || v.meta.photometric === 'MONOCHROME1';   // MONOCHROME1 files store white as the low value
  addEventListener('message', e => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'mypacs-3d-ready' || !local3d || S.vol !== local3d) return;
    const v = local3d; local3d = null;
    setTimeout(() => { try { $('#frame3d').contentWindow.postMessage(E.pack3d(v), location.origin); } catch (err) { $('#msg3d').textContent = 'Could not build the 3D model: ' + err.message; $('#msg3d').classList.add('on'); } }, 50);
  });
  // a folder from this computer, read in the browser
  async function openLocal(list) {
    const files = [...list].filter(f => !f.name.startsWith('.') && f.size > 132);
    if (!files.length) return;
    const tok = ++loadTok;
    message('Reading ' + files.length + (files.length > 1 ? ' files…' : ' file…')); $('#loading').classList.remove('msg');
    const step = (a, b) => { $('#loading span').textContent = 'Building the volume: slice ' + a + ' of ' + b; };
    try {
      const nii = files.find(f => /\.nii(\.gz)?$/i.test(f.name));
      if (nii) {
        const v = await E.fromNifti(await nii.arrayBuffer(), nii.name, step); if (tok !== loadTok) return; setVolume(v);
        MyFx.toast(v.meta.tilted ? 'Opened. The scan is tilted: it is shown straightened, so sizes are slightly off.' : v.meta.orientationAssumed ? 'Opened. The file does not say which way it faces: left and right may be swapped.' : 'Opened ' + nii.name);
        return;
      }
      const items = []; let bad = '';
      for (const f of files) { const t = DicomLite.parse(await f.slice(0, Math.min(f.size, 262144)).arrayBuffer()); if (t.rows && t.cols && t.pixelOffset) { t.ok = true; items.push({ file: f, tags: t }); } else if (t.error && t.error !== 'not a DICOM file') bad = t.error; }
      const groups = DicomLite.group(items).sort((a, b) => b.length - a.length);
      if (!groups.length) throw new Error(bad || 'no DICOM images there');
      const v = await E.fromDicom(groups[0], step);
      if (tok !== loadTok) return;
      setVolume(v);
      const what = v.meta.flat ? 'one image' : groups[0].length + ' slices', note = v.meta.lossy ? ' (lossy JPEG: values are approximate)' : v.meta.uncalibrated ? ' (no pixel size in the file: lengths are in pixels)' : v.meta.spacingAt === 'detector' ? ' (sizes are measured at the detector)' : '';
      MyFx.toast(v.meta.anonymised ? 'Opened ' + what + ' from this computer' + note : 'These files carry patient identity. They stay on this computer.');
    } catch (err) { if (tok === loadTok) message('Could not open it: ' + err.message); }
  }
  for (const id of ['#open-dir', '#open-files']) $(id).addEventListener('change', e => { const l = [...e.target.files]; e.target.value = ''; openLocal(l); });
  $('#d-ct').addEventListener('click', () => {
    const v = S.vol; if (!v || v.meta.format !== 'nifti') return;
    E.setModality(v, v.meta.modality === 'CT' ? '' : 'CT');
    const p = E.presets(v)[0]; lutDirty = true; setWindow(p.lo, p.hi, p.name); paintMeasures();
  });

  // ================= panes =================
  const panes = {};
  for (const el of $$('.pn')) {
    const k = el.dataset.pane; if (k === '3d') continue;
    const bar = document.createElement('input');                // slice slider: drag it, or click anywhere on the track
    bar.type = 'range'; bar.className = 'slicebar'; bar.min = 0; bar.max = 0; bar.step = 1; bar.tabIndex = -1;
    bar.title = E.PLANES[k].name + ' slice'; bar.setAttribute('aria-label', E.PLANES[k].name + ' slice'); bar.style.setProperty('--c', E.PLANES[k].color);
    el.appendChild(bar);
    bar.addEventListener('input', () => { if (!S.vol) return; const n = E.PLANES[k].n, mm = S.P.slice(); mm[n] = (+bar.value + .5) * S.vol.sp[n]; S.active = k; setP(mm); });
    bar.addEventListener('change', () => bar.blur());           // give the arrow keys back to the viewer
    panes[k] = { k, el, bar, cv: el.querySelector('canvas'), zoom: 1, px: 0, py: 0, off: null };
  }
  function geom(p) {
    const pl = E.PLANES[p.k], v = S.vol, W = p.el.clientWidth, H = p.el.clientHeight, mw = v.size[pl.u], mh = v.size[pl.v];
    const sc = Math.min(W / mw, H / mh) * .94 * p.zoom, x0 = W / 2 + p.px - mw * sc / 2, y0 = H / 2 + p.py - mh * sc / 2;
    return { pl, W, H, mw, mh, sc, x0, y0, S: (u, vv) => [x0 + u * sc, y0 + (pl.flip ? mh - vv : vv) * sc], M: (x, y) => { const vd = (y - y0) / sc; return [(x - x0) / sc, pl.flip ? mh - vd : vd]; } };
  }
  const sliceIdx = k => E.voxelAt(S.vol, S.P)[E.PLANES[k].n];
  const LEN = () => S.vol.meta.uncalibrated ? ' px' : ' mm';
  const UNIT = () => S.vol.unit === 'HU' ? ' HU' : S.vol.unit === 'SUV' ? '' : S.vol.unit ? ' ' + S.vol.unit : '';

  function annText(a) {
    const v = S.vol;
    if (a.type === 'len') return [Math.hypot(a.pts[1][0] - a.pts[0][0], a.pts[1][1] - a.pts[0][1]).toFixed(1) + LEN()];
    if (a.type === 'ang') {
      if (a.pts.length < 3) return [''];
      const [A, B, C] = a.pts, a1 = Math.atan2(A[1] - B[1], A[0] - B[0]), a2 = Math.atan2(C[1] - B[1], C[0] - B[0]); let d = Math.abs(a1 - a2) * 180 / Math.PI; if (d > 180) d = 360 - d;
      return [d.toFixed(1) + '°'];
    }
    const cu = (a.pts[0][0] + a.pts[1][0]) / 2, cv = (a.pts[0][1] + a.pts[1][1]) / 2, ru = Math.abs(a.pts[1][0] - a.pts[0][0]) / 2, rv = Math.abs(a.pts[1][1] - a.pts[0][1]) / 2;
    const r = E.roi(v, a.plane, a.idx, cu, cv, ru, rv); if (!r) return ['empty'];
    const f = v.format, area = v.meta.uncalibrated ? r.areaMm2.toFixed(0) + ' px²' : r.areaMm2 >= 100 ? (r.areaMm2 / 100).toFixed(1) + ' cm²' : r.areaMm2.toFixed(0) + ' mm²';
    if (v.unit === 'SUV') return ['SUVmax ' + f(r.max), 'SUVmean ' + f(r.mean) + ' ± ' + f(r.sd), area];
    if (v.unit === 'HU') return ['Mean ' + f(r.mean) + ' HU ± ' + f(r.sd), 'Min ' + f(r.min) + '  Max ' + f(r.max), area];
    return ['Mean ' + f(r.mean) + ' ± ' + f(r.sd) + UNIT(), 'Min ' + f(r.min) + '  Max ' + f(r.max), area];
  }

  function draw(p) {
    const v = S.vol; if (!v || !p.el.clientWidth) return;
    const g = geom(p), pl = g.pl, w = v.dims[pl.u], h = v.dims[pl.v], dpr = Math.min(devicePixelRatio || 1, 2), cv = p.cv, idx = sliceIdx(p.k);
    const last = v.dims[pl.n] - 1; p.bar.hidden = !last; const sb = p.bar.offsetHeight, flat = !!v.meta.flat;     // keep the slider in step; the bottom texts sit above it
    if (+p.bar.max !== last) p.bar.max = last; if (+p.bar.value !== idx) p.bar.value = idx; p.bar.style.setProperty('--f', (last ? idx / last * 100 : 0) + '%');
    if (cv.width !== Math.round(g.W * dpr) || cv.height !== Math.round(g.H * dpr)) { cv.width = Math.round(g.W * dpr); cv.height = Math.round(g.H * dpr); }
    if (!p.off || p.off.width !== w || p.off.height !== h) { p.off = document.createElement('canvas'); p.off.width = w; p.off.height = h; p.img = p.off.getContext('2d').createImageData(w, h); p.a = new Uint16Array(w * h); p.b = new Uint16Array(w * h); p.px32 = new Uint32Array(p.img.data.buffer); }
    if (lutDirty) { E.lut(v, S.lo, S.hi, S.cmap, S.invert, lut); lutDirty = false; }
    const slabVox = Math.round(S.slab / v.sp[pl.n] / 2);
    E.slice(v, p.k, idx, p.a, slabVox);
    const src = S.filter ? E.filter(p.a, w, h, S.filter, p.b) : p.a, out = p.px32;
    for (let i = 0; i < out.length; i++) out[i] = lut[src[i]];
    p.off.getContext('2d').putImageData(p.img, 0, 0);
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = '#000'; c.fillRect(0, 0, g.W, g.H);
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(p.off, g.x0, g.y0, g.mw * g.sc, g.mh * g.sc);

    // crosshair: each line is the colour of the view it stands for
    const [cx, cy] = g.S(S.P[pl.u], S.P[pl.v]), other = n => Object.values(E.PLANES).find(q => q.n === n).color, gap = 14;
    c.lineWidth = 1; c.globalAlpha = S.tool === 'cross' ? .85 : .4;
    c.strokeStyle = other(pl.u); c.beginPath(); c.moveTo(cx + .5, 0); c.lineTo(cx + .5, cy - gap); c.moveTo(cx + .5, cy + gap); c.lineTo(cx + .5, g.H); c.stroke();
    c.strokeStyle = other(pl.v); c.beginPath(); c.moveTo(0, cy + .5); c.lineTo(cx - gap, cy + .5); c.moveTo(cx + gap, cy + .5); c.lineTo(g.W, cy + .5); c.stroke();
    c.globalAlpha = 1;

    // measurements that sit on this slice
    const fs = Math.max(11, parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.45);
    c.font = '500 ' + fs + 'px "Google Sans Code", Consolas, monospace'; c.textBaseline = 'alphabetic';
    const label = (lines, x, y, col) => { lines.forEach((t, i) => { c.lineWidth = 3; c.strokeStyle = '#000'; c.strokeText(t, x, y + i * fs * 1.25); c.fillStyle = col; c.fillText(t, x, y + i * fs * 1.25); }); };
    const list = S.pending && S.pending.plane === p.k ? [...S.ann, S.pending] : S.ann;
    for (const a of list) {
      if (a.plane !== p.k || a.idx !== idx) continue;
      const col = a.id === S.hot ? '#fff' : '#9ff5d8', pts = a.pts.map(q => g.S(q[0], q[1]));
      c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.6;
      if (a.type === 'roi') {
        const x = (pts[0][0] + pts[1][0]) / 2, y = (pts[0][1] + pts[1][1]) / 2, rx = Math.abs(pts[1][0] - pts[0][0]) / 2, ry = Math.abs(pts[1][1] - pts[0][1]) / 2;
        c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.stroke(); label(annText(a), x + rx + 8, y - fs * .6, col);
      } else {
        c.beginPath(); pts.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.stroke();
        pts.forEach(q => { c.beginPath(); c.arc(q[0], q[1], 3, 0, Math.PI * 2); c.fill(); });
        const at = a.type === 'ang' ? pts[Math.min(1, pts.length - 1)] : [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
        label(annText(a), at[0] + 10, at[1] - 10, col);
      }
    }

    // text
    const pname = flat ? 'Image' : pl.name;
    c.fillStyle = pl.color; c.fillText(pname, 10, fs + 6);
    c.fillStyle = 'rgba(255,255,255,.85)'; if (!flat) c.fillText((idx + 1) + ' / ' + v.dims[pl.n] + (slabVox ? '   slab ' + ((slabVox * 2 + 1) * v.sp[pl.n]).toFixed(0) + ' mm' : ''), 10 + c.measureText(pname).width + 14, fs + 6);
    c.fillStyle = 'rgba(255,255,255,.6)';
    const ed = pl.edges, mid = (t, x, y) => c.fillText(t, x - c.measureText(t).width / 2, y);
    if (!flat) { mid(ed[0], 12, g.H / 2 + fs / 3); mid(ed[1], g.W - 12, g.H / 2 + fs / 3); mid(ed[2], g.W / 2, fs + 6); mid(ed[3], g.W / 2, g.H - 28 - sb); }
    // scale bar
    const bar = [2000, 1000, 500, 200, 100, 50, 20, 10, 5].find(x => x * g.sc <= g.W * .3) || 1, bw = bar * g.sc, bx = g.W / 2 - bw / 2, by = g.H - 16 - sb;
    c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(bx, by - 5); c.lineTo(bx, by); c.lineTo(bx + bw, by); c.lineTo(bx + bw, by - 5); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.8)'; c.fillText(bar + LEN(), bx + bw + 8, by + 3);
    if (S.hover && S.hover.k === p.k) {
      const val = E.valueAt(v, S.hover.mm);
      c.fillStyle = '#fff'; c.fillText((v.unit === 'SUV' ? 'SUV ' : '') + v.format(val) + UNIT(), 10, g.H - 12 - sb);
    }
    if (p.k === 'ax') {
      const t = 'W ' + v.format(S.hi - S.lo) + '  L ' + v.format((S.hi + S.lo) / 2) + (v.unit ? ' ' + v.unit : ''); c.fillStyle = 'rgba(255,255,255,.85)'; c.fillText(t, g.W - c.measureText(t).width - 10, fs + 6);
      const d = v.meta.label + (v.meta.local ? '' : v.meta.synthetic ? '  ·  phantom' : '  ·  sample data'); c.fillStyle = 'rgba(255,255,255,.6)'; c.fillText(d, g.W - c.measureText(d).width - 10, fs * 2.3 + 6);
    }
    p.el.classList.toggle('active', S.active === p.k && S.layout !== 'one');
  }
  let raf = 0;
  function drawAll() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; for (const k in panes) draw(panes[k]); }); }
  new ResizeObserver(drawAll).observe($('#port'));

  function setP(mm) { S.P = mm.map((x, i) => clamp(x, 0, S.vol.size[i] - 1e-3)); drawAll(); }
  function scroll(k, d) { const pl = E.PLANES[k], mm = S.P.slice(); mm[pl.n] += d * S.vol.sp[pl.n]; setP(mm); }
  function setWindow(lo, hi, name) { S.lo = lo; S.hi = Math.max(hi, lo + 1e-6); S.preset = name || ''; lutDirty = true; paintDisplay(); drawAll(); }

  // ---- pointer ----
  for (const k in panes) {
    const p = panes[k], cv = p.cv;
    const at = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const mm3 = (g, xy) => { const [u, v] = g.M(xy[0], xy[1]), m = S.P.slice(); m[g.pl.u] = u; m[g.pl.v] = v; return m; };
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      if (!S.vol) return; cv.setPointerCapture(e.pointerId); S.active = k;
      const tool = e.button === 1 ? 'pan' : e.button === 2 ? 'zoom' : S.tool, g = geom(p), xy0 = at(e), m0 = g.M(xy0[0], xy0[1]), start = { px: p.px, py: p.py, zoom: p.zoom, lo: S.lo, hi: S.hi, P: S.P.slice() };
      let a = null;
      if (tool === 'cross') setP(mm3(g, xy0));
      else if (tool === 'len' || tool === 'roi') { a = { id: ++annId, type: tool, plane: k, idx: sliceIdx(k), pts: [m0, m0] }; S.ann.push(a); }
      else if (tool === 'ang') {
        if (!S.pending || S.pending.plane !== k || S.pending.idx !== sliceIdx(k)) S.pending = { id: ++annId, type: 'ang', plane: k, idx: sliceIdx(k), pts: [m0, m0] };
        else { S.pending.pts[S.pending.pts.length - 1] = m0; if (S.pending.pts.length === 3) { S.ann.push(S.pending); S.pending = null; paintMeasures(); } else S.pending.pts.push(m0); }
        drawAll(); return;
      }
      const move = ev => {
        const xy = at(ev), dx = xy[0] - xy0[0], dy = xy[1] - xy0[1];
        if (tool === 'cross') setP(mm3(geom(p), xy));
        else if (tool === 'pan') { p.px = start.px + dx; p.py = start.py + dy; }
        else if (tool === 'zoom') p.zoom = clamp(start.zoom * Math.exp(-dy / 200), .3, 20);
        else if (tool === 'scroll') { const pl = E.PLANES[k], m = start.P.slice(); m[pl.n] += Math.round(dy / 4) * S.vol.sp[pl.n]; setP(m); }
        else if (tool === 'wl') { const R = (S.vol.range.p999 - S.vol.range.min) || 1, w = Math.max(R / 2000, start.hi - start.lo + dx * R / 500), l = (start.hi + start.lo) / 2 + dy * R / 500; setWindow(l - w / 2, l + w / 2); }
        else if (a) a.pts[1] = geom(p).M(xy[0], xy[1]);
        drawAll();
      };
      const up = () => {
        cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
        if (a) { const d = Math.hypot(a.pts[1][0] - a.pts[0][0], a.pts[1][1] - a.pts[0][1]); if (d < S.vol.sp[0] * .5) S.ann.splice(S.ann.indexOf(a), 1); paintMeasures(); drawAll(); }
      };
      cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); drawAll();
    });
    cv.addEventListener('pointermove', e => {
      if (!S.vol) return; const g = geom(p), xy = at(e), m = mm3(g, xy);
      const inside = m.every((x, i) => x >= 0 && x < S.vol.size[i]);
      S.hover = inside ? { k, mm: m } : null; S.active = k;
      if (S.pending && S.pending.plane === k) S.pending.pts[S.pending.pts.length - 1] = g.M(xy[0], xy[1]);
      drawAll();
    });
    cv.addEventListener('pointerleave', () => { S.hover = null; drawAll(); });
    cv.addEventListener('wheel', e => {
      if (!S.vol) return; e.preventDefault();
      if (e.ctrlKey) { const g = geom(p), xy = at(e), z = clamp(p.zoom * Math.exp(-e.deltaY / 300), .3, 20), f = z / p.zoom; p.px = (xy[0] - g.W / 2) * (1 - f) + p.px * f; p.py = (xy[1] - g.H / 2) * (1 - f) + p.py * f; p.zoom = z; drawAll(); }
      else scroll(k, (e.deltaY > 0 ? 1 : -1) * (k === 'ax' ? -1 : 1));
    }, { passive: false });
    cv.addEventListener('dblclick', () => { if (S.tool === 'ang') return; if (S.layout === 'one') setLayout(S.prevLayout || '2x2'); else { S.prevLayout = S.layout; S.big = k; setLayout('one'); } });
  }
  function setLayout(l) {
    S.layout = l; grid.dataset.layout = l;
    $$('.pn').forEach(el => el.classList.toggle('big', l !== '2x2' && el.dataset.pane === S.big));
    drawAll();
  }

  // ================= tools =================
  function setTool(t) {
    S.tool = t; if (t !== 'ang') S.pending = null;
    const btn = dock.querySelector('[data-tool="' + t + '"]'), sel = dock.querySelector('.sel');
    dock.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b === btn));
    sel.style.translate = (btn.offsetLeft - sel.offsetLeft) + 'px 0';
    const cur = { cross: 'crosshair', wl: 'ns-resize', pan: 'grab', zoom: 'zoom-in', scroll: 'ns-resize', len: 'crosshair', ang: 'crosshair', roi: 'crosshair' }[t];
    for (const k in panes) panes[k].cv.style.cursor = cur;
    drawAll();
  }
  const ACT = {
    invert() { S.invert = !S.invert; lutDirty = true; flags(); drawAll(); },
    layout() { const order = ['2x2', '1+3', 'one'], n = order[(order.indexOf(S.layout) + 1) % 3]; if (n !== '2x2') S.big = S.active in panes ? S.active : 'ax'; setLayout(n); },
    wide() { document.body.classList.toggle('wide'); setTimeout(() => setTool(S.tool), 30); flags(); },
    reset() { if (!S.vol) return; for (const k in panes) { panes[k].zoom = 1; panes[k].px = panes[k].py = 0; } S.P = S.vol.size.map(x => x / 2); S.slab = 0; S.filter = ''; const p = E.presets(S.vol)[0]; S.invert = invertByDefault(S.vol); S.cmap = 'grey'; setWindow(p.lo, p.hi, p.name); flags(); },
    full() { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); },
  };
  function flags() { dock.querySelector('[data-act="invert"]').classList.toggle('flag', S.invert); dock.querySelector('[data-act="wide"]').classList.toggle('flag', document.body.classList.contains('wide')); }
  dock.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  dock.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => ACT[b.dataset.act]()));

  // ================= display panel =================
  Object.entries(E.COLORMAPS).forEach(([k, m]) => { const b = document.createElement('button'); b.dataset.v = k; b.textContent = m.name; $('#cmap').append(b); });
  function paintDisplay() {
    const v = S.vol; if (!v) return;
    $('#d-unit').textContent = v.unitName;
    const note = $('#d-note'); note.className = 'note';
    $('#d-as').hidden = v.meta.format !== 'nifti'; $('#d-ct').setAttribute('aria-pressed', v.meta.modality === 'CT');
    if (v.unit === 'HU' && v.meta.format === 'nifti') note.textContent = 'You marked this file as a CT, so its numbers are read as HU. The file itself does not say so.';
    else if (v.unit === 'HU') note.textContent = 'From the rescale slope and intercept in the files. Window presets are the usual textbook values.';
    else if (v.meta.modality === 'PT' && v.suv.ok) note.textContent = 'Computed from the weight, dose, half-life and times in the files.';
    else if (v.meta.modality === 'PT') { note.textContent = 'SUV is not available: ' + v.suv.missing.join(', ') + '.'; note.classList.add('warn'); }
    else if (v.meta.format === 'nifti') note.textContent = 'A .nii file does not say what the numbers mean. They are shown as stored.';
    else if (v.meta.modality === 'MR') note.textContent = 'MR signal has no physical unit; compare within one series only.';
    else note.textContent = 'These values have no physical unit.';
    const box = $('#presets'); box.textContent = '';
    E.presets(v).forEach(p => { const b = document.createElement('button'); b.textContent = p.name; b.setAttribute('aria-pressed', p.name === S.preset); b.addEventListener('click', () => setWindow(p.lo, p.hi, p.name)); box.append(b); });
    const dec = v.unit === 'SUV' ? 2 : 0, w = $('#d-w'), l = $('#d-l');
    if (document.activeElement !== w) w.value = (S.hi - S.lo).toFixed(dec); if (document.activeElement !== l) l.value = ((S.hi + S.lo) / 2).toFixed(dec);
    $$('#cmap button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.cmap));
    $$('#filter button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.filter));
    $('#slab').value = S.slab; $('#slab').max = 40; $('#slab-out').textContent = S.slab ? S.slab + ' mm' : 'Off';
    const m = v.meta, info = [['Series', m.label], ['Modality', m.modality + (m.bodyPart ? ' · ' + m.bodyPart : '')], ['Matrix', m.dims.join(' × ')], ['Voxel', m.uncalibrated ? 'not in the file' : m.spacing.map(x => +x.toFixed(2)).join(' × ') + ' mm' + (m.spacingAt === 'detector' ? ' (at the detector)' : '')],
      ['Range', v.format(v.range.min) + ' to ' + v.format(v.range.max) + (v.unit ? ' ' + v.unit : '')]];
    if (m.local) info.push(['File type', m.format === 'nifti' ? 'NIfTI' + (m.volumes > 1 ? ' (first of ' + m.volumes + ' volumes)' : '') : 'DICOM' + (m.compression ? ', ' + m.compression : '')]);
    if (m.tilted) info.push(['Tilted', 'yes: shown straightened']); if (m.orientationAssumed) info.push(['Directions', 'not in the file: assumed']);
    if (v.suv && v.suv.ok) info.push(['Weight', v.suv.weightKg + ' kg'], ['Injected dose', (v.suv.doseBq / 1e6).toFixed(1) + ' MBq'], ['Half-life', (v.suv.halfLifeS / 60).toFixed(1) + ' min'], ['Uptake time', v.suv.uptakeMin.toFixed(0) + ' min'], ['Dose at scan', (v.suv.doseAtScanBq / 1e6).toFixed(1) + ' MBq']);
    const kv = $('#d-info'); kv.textContent = ''; info.forEach(([a, b]) => { const x = document.createElement('span'), y = document.createElement('b'); x.textContent = a; y.textContent = b; kv.append(x, y); });
  }
  const wlInput = () => { const w = parseFloat($('#d-w').value), l = parseFloat($('#d-l').value); if (S.vol && w > 0 && isFinite(l)) setWindow(l - w / 2, l + w / 2); };
  $('#d-w').addEventListener('change', wlInput); $('#d-l').addEventListener('change', wlInput);
  $('#cmap').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.cmap = b.dataset.v; lutDirty = true; paintDisplay(); drawAll(); });
  $('#filter').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.filter = b.dataset.v; paintDisplay(); drawAll(); });
  $('#slab').addEventListener('input', e => { S.slab = +e.target.value; $('#slab-out').textContent = S.slab ? S.slab + ' mm' : 'Off'; drawAll(); });

  // ================= measurements =================
  const NAME = { len: 'Length', ang: 'Angle', roi: 'ROI' };
  const where = a => E.PLANES[a.plane].name.toLowerCase() + ', image ' + (a.idx + 1);
  function paintMeasures() {
    const box = $('#mlist'); box.textContent = '';
    if (!S.ann.length) { box.innerHTML = '<span class="none">Nothing measured yet. Use the ruler, angle or ROI tool on any view. Lengths are in mm; an ROI gives the mean, spread and maximum in the unit of the series (HU, SUV or signal).</span>'; return; }
    S.ann.forEach(a => {
      const d = document.createElement('div'); d.className = 'm'; d.innerHTML = '<div><b></b><small></small></div><button title="Delete" aria-label="Delete">×</button>';
      d.querySelector('b').textContent = NAME[a.type] + ': ' + annText(a).join('  ·  '); d.querySelector('small').textContent = where(a);
      d.addEventListener('click', () => { const pl = E.PLANES[a.plane], m = S.P.slice(); m[pl.n] = (a.idx + .5) * S.vol.sp[pl.n]; m[pl.u] = a.pts[0][0]; m[pl.v] = a.pts[0][1]; S.hot = a.id; setP(m); });
      d.querySelector('button').addEventListener('click', e => { e.stopPropagation(); S.ann.splice(S.ann.indexOf(a), 1); paintMeasures(); drawAll(); });
      box.append(d);
    });
  }
  $('#m-clear').addEventListener('click', () => { S.ann = []; S.pending = null; paintMeasures(); drawAll(); });
  $('#m-add').addEventListener('click', () => {
    if (!S.ann.length) { MyFx.toast('Nothing measured yet'); return; }
    if (!study || !canReport) { MyFx.toast('Only a radiologist or admin can edit the report'); return; }
    if (study.state === 'Final') { MyFx.toast(live ? 'This report is already sent' : 'Reopen the report first'); return; }
    const t = $('#r-find'), lines = S.ann.map(a => '- ' + NAME[a.type] + ' (' + where(a) + '): ' + annText(a).join(', '));
    t.value = (t.value.trim() ? t.value.trim() + '\n' : '') + lines.join('\n'); tab('report'); MyFx.toast(lines.length + ' measurement' + (lines.length > 1 ? 's' : '') + ' added to the findings');
  });

  // ================= keys =================
  addEventListener('keydown', e => {
    if (/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase(), map = { c: 'cross', w: 'wl', p: 'pan', z: 'zoom', s: 'scroll', m: 'len', a: 'ang', o: 'roi' }, act = S.active in panes ? S.active : 'ax';
    if (map[k]) setTool(map[k]);
    else if (k === 'i') ACT.invert(); else if (k === 'r') ACT.reset(); else if (k === 'f') ACT.full(); else if (k === 'g') ACT.layout(); else if (k === 'h') ACT.wide();
    else if (S.vol && (k === 'arrowup' || k === 'arrowdown' || k === 'pageup' || k === 'pagedown')) { e.preventDefault(); scroll(act, (k.endsWith('up') ? 1 : -1) * (k.startsWith('page') ? 5 : 1) * (act === 'ax' ? 1 : -1)); }
    else if (k === 'arrowleft') step(-1); else if (k === 'arrowright') step(1);
    else if (k === 'escape') { if (S.pending) { S.pending = null; drawAll(); } else if (S.layout === 'one') setLayout(S.prevLayout || '2x2'); }
  });

  // ================= start =================
  setTool('cross'); flags();
  addEventListener('resize', () => setTool(S.tool));
  E.list().then(async m => {
    metas = m;
    if (await MyApi.ready) await startLive(); else loadStudy(study);
    if (params.get('report') && !$('#r-find').readOnly) setTimeout(() => $('#r-find').focus(), 700);
  });
  window.Viewer = { S, panes, drawAll, setP, setWindow, setTool, annText, paintMeasures, geom, loadStudy, openArchive, get study() { return study; }, get live() { return live; }, get archive() { return archive; } };
})();

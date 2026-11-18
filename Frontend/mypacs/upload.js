// Upload page: reads dropped DICOM files in the browser, shows what they are, and attaches them to an order.
// With the backend (MyApi.ready): the orders are the SIMRS requests waiting for images, and "Send" uploads the file
// to the local PACS archive (POST /api/studies, as the old instalasi.html does); the backend takes the patient and the
// exam from the request. Without it: only a small preview picture and a few facts are kept (in the mock store);
// the files themselves stay on the computer.
(async function () {
  const $ = s => document.querySelector(s), params = new URLSearchParams(location.search);
  const MOD = { MR: 'MRI', CT: 'CT', CR: 'X-Ray', DX: 'X-Ray', US: 'USG', PT: 'PET' };   // DICOM modality code -> the app's modality tabs
  const API_MOD = { CR: 'DX', DR: 'DX' };          // DICOM modality code -> the backend's exam modality (DX, CT, MR, US), as instalasi.html
  const NII = /\.nii(\.gz)?$/i, CAN_UPLOAD = ['radiografer', 'admin'];
  const live = await MyApi.ready, me = live ? await MyApi.user() : null;
  let series = [], nii = [], skipped = 0, sent = false, apiOrders = [], loadErr = '';

  // ---- order picker ----
  const sel = $('#order');
  // the exam as shown: the modality code, unless the description already starts with it ("CT Head", "MRI Brain")
  const examText = ex => { const m = ex.modality || '', d = ex.description || ''; return (m && d.toUpperCase().startsWith(m) ? d : [m, d].filter(Boolean).join(' ')) || '-'; };
  const fromApi = o => { const d = o.data || {}, p = d.patient || {}, ex = d.exam || {};
    return { id: o.id, name: p.name || '-', mrn: p.nik || '-', nik: p.nik || '', mod: ex.modality || '', exam: examText(ex),
      description: ex.description || '', pri: d.priority === 'CITO' ? 'CITO' : 'ROUTINE', from: d.requester || o.created_by || '-' }; };
  const getOrder = id => live ? apiOrders.find(o => o.id === id) : MockStore.order(id);
  if (live) {
    $('#side .field .label').textContent = 'Waiting request';
    document.querySelector('.t.sub').textContent = 'Radiology · the file is read here first, then saved in the SIMRS archive when you send it';
    $('#drop small').textContent = 'The SIMRS archive keeps one file per request: one DICOM (.dcm, .ima) or one NIfTI (.nii, .nii.gz).';
    $('#send').textContent = 'Save in the archive';
  }
  async function fillOrders() {
    const want = params.get('order');
    let list;
    if (live) {
      try { apiOrders = (await MyApi.get('orders?status=requested')).map(fromApi); loadErr = ''; }
      catch (err) { apiOrders = []; loadErr = err.status === 403 ? 'Your account cannot see radiology requests.' : 'Requests could not be loaded: ' + err.message; }
      list = apiOrders;
    } else list = MockStore.orders().filter(o => o.status === 'Accepted');
    sel.textContent = '';
    if (loadErr) sel.add(new Option(loadErr, ''));
    else if (!list.length) sel.add(new Option(live ? 'No requests waiting for images.' : 'No accepted orders. Accept one in the inbox first.', ''));
    list.forEach(o => sel.add(new Option(o.id + '  ·  ' + o.name + '  ·  ' + o.exam.replace('\n', ' '), o.id)));
    if (list.some(o => o.id === want)) sel.value = want;
    orderInfo();
  }
  function orderInfo() {
    const o = getOrder(sel.value), box = $('#o-info'); box.textContent = '';
    if (o) (live ? [['Patient', o.name], ['NIK', o.mrn], ['From', o.from], ['Examination', o.exam], ['Priority', o.pri]]
      : [['Patient', o.name], ['MRN', o.mrn], ['From', o.inst.name + ' (' + o.inst.local + ')'], ['Examination', o.exam.replace('\n', ' ')], ['Priority', o.pri]]).forEach(([k, v]) => {
      const a = document.createElement('span'), b = document.createElement('b'); a.textContent = k; b.textContent = v; b.style.fontWeight = 400; box.append(a, b); });
    checks();
  }
  sel.addEventListener('change', orderInfo);

  // ---- getting the files ----
  const drop = $('#drop');
  async function walk(entry, out) {                   // a dropped folder
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const rd = entry.createReader();
      for (;;) { const batch = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!batch.length) break; for (const e of batch) await walk(e, out); }
    }
  }
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', async e => {
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean), files = [];
    if (entries.length) for (const en of entries) await walk(en, files); else files.push(...e.dataTransfer.files);
    read(files);
  });
  $('#pick-dir').addEventListener('change', e => read([...e.target.files]));
  $('#pick-files').addEventListener('change', e => read([...e.target.files]));
  $('#again').addEventListener('click', () => { series = []; nii = []; skipped = 0; show('drop'); checks(); });

  function show(what) {
    drop.style.display = what === 'drop' ? '' : 'none';
    $('#reading').style.display = what === 'reading' ? 'flex' : 'none';
    $('#series').hidden = what !== 'series'; $('#again').hidden = what !== 'series' || sent;
  }

  async function read(files) {
    files = files.filter(f => !f.name.startsWith('.') && f.size > 132);
    if (!files.length) { MyFx.toast('No files found'); return; }
    nii = live ? files.filter(f => NII.test(f.name)) : [];     // NIfTI: no preview here, the backend turns it into slices
    files = files.filter(f => !nii.includes(f));
    show('reading'); const items = []; skipped = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      // the header sits at the start; read the first part only, the pixels are fetched when a slice is shown
      const tags = DicomLite.parse(await f.slice(0, Math.min(f.size, 262144)).arrayBuffer());
      if (tags.ok || tags.pixelOffset) { if (tags.rows && tags.cols) { tags.ok = true; items.push({ file: f, tags }); } else skipped++; } else skipped++;
      if (i % 8 === 0 || i === files.length - 1) { $('#read-text').textContent = 'Reading ' + (i + 1) + ' of ' + files.length + ' files…'; $('#read-bar').style.width = (i + 1) / files.length * 100 + '%'; await new Promise(r => setTimeout(r)); }
    }
    series = DicomLite.group(items);
    if (!series.length && !nii.length) { show('drop'); MyFx.toast(live ? 'None of these files are DICOM or NIfTI images' : 'None of these files are DICOM images'); checks(); return; }
    await match(); paint(); show('series'); checks();
  }

  // is this series one that was already rebuilt for the 3D page?
  async function match() {
    let ids = []; try { ids = await (await fetch('data/index.json')).json(); } catch (_) {}
    const metas = (await Promise.all(ids.map(id => fetch('data/' + id + '/meta.json').then(r => r.json()).catch(() => null)))).filter(Boolean);
    for (const s of series) { const m = metas.find(m => m.tags.some(t => t[1] === 'Series UID' && t[2] === s[0].tags.seriesUid)); s.recon = m ? m.id : ''; }
  }

  async function drawSlice(canvas, item) {
    const t = item.tags, px = DicomLite.pixels(await item.file.arrayBuffer(), t);
    if (!px) return false;
    canvas.width = t.cols; canvas.height = t.rows;
    let lo, hi;
    if (t.windowWidth && t.windowWidth[0] > 1 && t.windowCenter && t.windowCenter.length) { lo = t.windowCenter[0] - t.windowWidth[0] / 2; hi = t.windowCenter[0] + t.windowWidth[0] / 2; }
    else { lo = Infinity; hi = -Infinity; for (let i = 0; i < px.length; i++) { if (px[i] < lo) lo = px[i]; if (px[i] > hi) hi = px[i]; } }
    const ctx = canvas.getContext('2d'), im = ctx.createImageData(t.cols, t.rows), d = im.data, k = 255 / (hi - lo || 1), inv = t.photometric === 'MONOCHROME1';
    for (let i = 0, q = 0; i < px.length; i++, q += 4) { let g = (px[i] - lo) * k; g = g < 0 ? 0 : g > 255 ? 255 : g; if (inv) g = 255 - g; d[q] = d[q + 1] = d[q + 2] = g; d[q + 3] = 255; }
    ctx.putImageData(im, 0, 0);
    const ps = t.pixelSpacing; if (ps && ps.length === 2 && ps[0] !== ps[1]) canvas.style.aspectRatio = (t.cols * ps[1]) + ' / ' + (t.rows * ps[0]);
    return true;
  }

  function paint() {
    const box = $('#series'); box.textContent = '';
    series.forEach((s, n) => {
      const t = s[0].tags, el = document.createElement('div'); el.className = 'ser'; el.style.animationDelay = n * 80 + 'ms';
      el.innerHTML = '<div class="pv"><div class="img"><canvas></canvas></div><input type="range" min="1" max="' + s.length + '" value="' + Math.ceil(s.length / 2) + '"><div class="label"></div></div>'
        + '<div class="facts"><h3></h3><div class="kvs"></div></div>';
      el.querySelector('h3').textContent = (t.modality || 'Unknown modality') + (t.bodyPart ? ' · ' + t.bodyPart : '') + (t.seriesDescription ? ' · ' + t.seriesDescription : '');
      const mm = x => +(+x).toFixed(2), kv = el.querySelector('.kvs');
      const rows = [['Images', s.length + (s.length > 1 ? ' slices' : '')], ['Size', t.cols + ' × ' + t.rows + ' pixels'],
        ['Pixel spacing', t.pixelSpacing && t.pixelSpacing.length ? t.pixelSpacing.map(mm).join(' × ') + ' mm' : 'not in the file'],
        ['Slice spacing', s.gap ? mm(s.gap) + ' mm' : t.sliceThickness ? mm(t.sliceThickness) + ' mm thick' : 'not in the file'],
        ['Study date', t.studyDate || 'not in the file'], ['Stored as', t.compressed ? 'compressed (' + t.syntax + ')' : 'uncompressed, ' + (t.bitsAllocated || '?') + ' bit'],
        ['3D', s.recon ? 'Ready: already rebuilt' : s.length > 20 && !t.compressed ? 'Possible after conversion' : 'Not for this series']];
      rows.forEach(([k, v]) => { const a = document.createElement('span'), b = document.createElement('b'); a.textContent = k; b.textContent = v; b.style.fontWeight = 400; kv.append(a, b); });
      const cv = el.querySelector('canvas'), range = el.querySelector('input'), cap = el.querySelector('.label');
      let busy = false, want = null;
      const go = async i => { if (busy) { want = i; return; } busy = true; const ok = await drawSlice(cv, s[i - 1]); busy = false;
        if (!ok) { el.querySelector('.img').textContent = 'Compressed image: kept, but no preview in this prototype.'; range.hidden = true; cap.hidden = true; return; }
        cap.textContent = 'Image ' + i + ' of ' + s.length; if (want !== null) { const w = want; want = null; go(w); } };
      range.addEventListener('input', () => go(+range.value)); if (s.length < 2) range.hidden = true;
      s.ready = go(+range.value).then(() => { s.canvas = cv; });
      box.append(el);
    });
    nii.forEach((f, n) => {                            // a NIfTI volume: facts only
      const el = document.createElement('div'); el.className = 'ser'; el.style.animationDelay = (series.length + n) * 80 + 'ms';
      el.innerHTML = '<div class="pv"><div class="img">NIfTI volume: no preview here. The archive turns it into slices for the viewer.</div></div><div class="facts"><h3></h3><div class="kvs"></div></div>';
      el.querySelector('h3').textContent = f.name;
      [['Format', 'NIfTI' + (/\.gz$/i.test(f.name) ? ' (compressed)' : '')], ['Size', (f.size / 1048576).toFixed(2) + ' MB']].forEach(([k, v]) => {
        const a = document.createElement('span'), b = document.createElement('b'); a.textContent = k; b.textContent = v; b.style.fontWeight = 400; el.querySelector('.kvs').append(a, b); });
      box.append(el);
    });
  }

  function checks() {
    const box = $('#checks'), o = getOrder(sel.value); box.textContent = '';
    const add = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; box.append(d); };
    if (sent) { add('', live ? 'Saved in the SIMRS archive.' : 'Sent to the worklist.'); return; }
    if (live && me && !CAN_UPLOAD.includes(me.role)) add('warn', 'Your account (' + me.role + ') cannot upload images. Sign in as a radiographer or an admin.');
    if (!series.length && !nii.length) { add('info', 'Waiting for files.'); $('#send').disabled = true; return; }
    const count = series.reduce((n, s) => n + s.length, 0), all = series.flat();
    let blocked = false;
    if (series.length) add('', count + ' DICOM images in ' + series.length + ' series' + (skipped ? ' (' + skipped + ' other files skipped)' : ''));
    if (nii.length) add('', nii.length + ' NIfTI volume' + (nii.length > 1 ? 's' : ''));
    if (series.length) {
      if (all.some(i => i.tags.patientName || i.tags.patientId)) add('warn', 'These files carry a patient name or ID. Use anonymised test data only in this demo.');
      else add('', 'No patient name or ID inside the files (anonymised).');
    }
    if (o && live) {
      const got = [...new Set(series.map(s => API_MOD[s[0].tags.modality] || s[0].tags.modality || '?'))];
      if (got.length && got.every(m => m === o.mod)) add('', 'Modality matches the request (' + o.mod + ').');
      else if (got.length) add('warn', 'The request asks for ' + o.mod + ', the files are ' + got.join(', ') + '. Check before saving.');
      if (nii.length) add('info', 'A NIfTI file carries no modality. Check it is the ' + o.mod + ' that was asked for.');
    } else if (o) { const got = [...new Set(series.map(s => MOD[s[0].tags.modality] || s[0].tags.modality || '?'))];
      if (got.every(m => m === o.mod)) add('', 'Modality matches the order (' + o.mod + ').'); else add('warn', 'The order asks for ' + o.mod + ', the files are ' + got.join(', ') + '. Check before sending.'); }
    else add('warn', live ? 'Pick a waiting request first.' : 'Pick an accepted order first.');
    if (series.some(s => s[0].tags.compressed)) add('info', 'Compressed images are kept but cannot be previewed yet.');
    if (series.some(s => s.recon)) add('', 'A 3D reconstruction is ready for this series.');
    if (live && count + nii.length > 1) { add('warn', 'The SIMRS archive keeps one file per request. Choose a single DICOM or NIfTI file.'); blocked = true; }
    if (live && me && !CAN_UPLOAD.includes(me.role)) blocked = true;
    $('#send').disabled = !o || blocked;
  }

  function doneCard(title, sub, links) {
    sent = true; show('series'); checks(); $('#send').hidden = true; $('#again').hidden = true; sel.disabled = true;
    const left = $('#left'); $('#series').hidden = true;
    const d = document.createElement('div'); d.className = 'done';
    d.innerHTML = '<div class="tick">✓</div><b></b><div class="sub"></div><div class="btns" style="width:80rem"></div>';
    d.querySelector('b').textContent = title; d.querySelector('.sub').textContent = sub;
    links.forEach(([cls, text, href]) => { const a = document.createElement('a'); a.className = 'pbtn ' + cls; a.textContent = text; a.href = href; d.querySelector('.btns').append(a); });
    left.append(d);
  }

  async function sendLive(o) {
    const file = series.length ? series[0][0].file : nii[0], btn = $('#send');
    // as the old instalasi.html: the file plus a JSON "meta" with the request id; the backend fills in the
    // patient and the exam from the request itself
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('meta', JSON.stringify({ order_id: o.id, name: o.name, nik: o.nik, modality: o.mod, description: o.description }));
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const st = await MyApi.post('studies', fd);
      doneCard('Saved in the archive as study ' + st.id, o.name + ' · ' + o.exam + ' · ' + o.id + ' now waits for the radiologist.',
        [['solid', 'Open the study', 'viewer.html?study=' + encodeURIComponent(st.id)], ['ghost', 'Back to the inbox', 'orders.html']]);
      MyFx.toast('Study ' + st.id + ' saved');
    } catch (err) {
      const why = err.status === 403 ? 'Your account cannot upload images. Sign in as a radiographer or an admin.'
        : err.status === 409 ? 'This request already has images.' : err.message;
      btn.textContent = 'Save in the archive'; checks();
      const w = document.createElement('div'); w.className = 'warn'; w.textContent = 'Not saved: ' + why; $('#checks').append(w);
      MyFx.toast('Not saved: ' + why);
      if (err.status === 409) fillOrders();
    }
  }

  $('#send').addEventListener('click', async () => {
    const o = getOrder(sel.value); if (!o || (!series.length && !nii.length)) return;
    if (live) return sendLive(o);
    const main = series.find(s => s.recon) || series.slice().sort((a, b) => b.length - a.length)[0]; await main.ready;
    let thumb = '';
    if (main.canvas && main.canvas.width) { const c = document.createElement('canvas'), k = 512 / Math.max(main.canvas.width, main.canvas.height); c.width = Math.round(main.canvas.width * k); c.height = Math.round(main.canvas.height * k);
      c.getContext('2d').drawImage(main.canvas, 0, 0, c.width, c.height); thumb = c.toDataURL('image/jpeg', .82); }
    const st = MockStore.addStudy(o.id, { series: series.length, images: series.reduce((n, s) => n + s.length, 0), thumb, recon: main.recon || '', uploaded: true });
    const links = [['solid', 'Open the study', 'viewer.html?mrn=' + encodeURIComponent(st.mrn)]];
    if (st.recon) links.push(['ghost', 'Open in 3D', 'recon.html?series=' + st.recon + '&mrn=' + encodeURIComponent(st.mrn)]);
    links.push(['ghost', 'Back to the inbox', 'orders.html']);
    doneCard(st.images + ' images are in the worklist', o.name + ' · ' + o.exam.replace('\n', ' ') + ' · ' + o.id + ' now shows as Imaged for ' + o.inst.name + '.', links);
    MyFx.toast('Study added to the worklist');
  });

  show('drop'); await fillOrders();
  window.Upload = { read };
})();

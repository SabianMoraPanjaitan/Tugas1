// Upload page: reads dropped DICOM files in the browser, shows what they are, and attaches them to an accepted order.
// Only a small preview picture and a few facts are kept (in the mock store); the files themselves stay on the computer.
(function () {
  const $ = s => document.querySelector(s), params = new URLSearchParams(location.search);
  const MOD = { MR: 'MRI', CT: 'CT', CR: 'X-Ray', DX: 'X-Ray', US: 'USG', PT: 'PET' };   // DICOM modality code -> the app's modality tabs
  let series = [], skipped = 0, sent = false;

  // ---- order picker ----
  const sel = $('#order');
  function fillOrders() {
    const list = MockStore.orders().filter(o => o.status === 'Accepted'), want = params.get('order');
    sel.textContent = '';
    if (!list.length) sel.add(new Option('No accepted orders. Accept one in the inbox first.', ''));
    list.forEach(o => sel.add(new Option(o.id + '  ·  ' + o.name + '  ·  ' + o.exam.replace('\n', ' '), o.id)));
    if (list.some(o => o.id === want)) sel.value = want;
    orderInfo();
  }
  function orderInfo() {
    const o = MockStore.order(sel.value), box = $('#o-info'); box.textContent = '';
    if (o) [['Patient', o.name], ['MRN', o.mrn], ['From', o.inst.name + ' (' + o.inst.local + ')'], ['Examination', o.exam.replace('\n', ' ')], ['Priority', o.pri]].forEach(([k, v]) => {
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
  $('#again').addEventListener('click', () => { series = []; skipped = 0; show('drop'); checks(); });

  function show(what) {
    drop.style.display = what === 'drop' ? '' : 'none';
    $('#reading').style.display = what === 'reading' ? 'flex' : 'none';
    $('#series').hidden = what !== 'series'; $('#again').hidden = what !== 'series' || sent;
  }

  async function read(files) {
    files = files.filter(f => !f.name.startsWith('.') && f.size > 132);
    if (!files.length) { MyFx.toast('No files found'); return; }
    show('reading'); const items = []; skipped = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      // the header sits at the start; read the first part only, the pixels are fetched when a slice is shown
      const tags = DicomLite.parse(await f.slice(0, Math.min(f.size, 262144)).arrayBuffer());
      if (tags.ok || tags.pixelOffset) { if (tags.rows && tags.cols) { tags.ok = true; items.push({ file: f, tags }); } else skipped++; } else skipped++;
      if (i % 8 === 0 || i === files.length - 1) { $('#read-text').textContent = 'Reading ' + (i + 1) + ' of ' + files.length + ' files…'; $('#read-bar').style.width = (i + 1) / files.length * 100 + '%'; await new Promise(r => setTimeout(r)); }
    }
    series = DicomLite.group(items);
    if (!series.length) { show('drop'); MyFx.toast('None of these files are DICOM images'); checks(); return; }
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
  }

  function checks() {
    const box = $('#checks'), o = MockStore.order(sel.value); box.textContent = '';
    const add = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; box.append(d); };
    if (sent) { add('', 'Sent to the worklist.'); return; }
    if (!series.length) { add('info', 'Waiting for files.'); $('#send').disabled = true; return; }
    const count = series.reduce((n, s) => n + s.length, 0), all = series.flat();
    add('', count + ' DICOM images in ' + series.length + ' series' + (skipped ? ' (' + skipped + ' other files skipped)' : ''));
    if (all.some(i => i.tags.patientName || i.tags.patientId)) add('warn', 'These files carry a patient name or ID. Use anonymised test data only in this demo.');
    else add('', 'No patient name or ID inside the files (anonymised).');
    if (o) { const got = [...new Set(series.map(s => MOD[s[0].tags.modality] || s[0].tags.modality || '?'))];
      if (got.every(m => m === o.mod)) add('', 'Modality matches the order (' + o.mod + ').'); else add('warn', 'The order asks for ' + o.mod + ', the files are ' + got.join(', ') + '. Check before sending.'); }
    else add('warn', 'Pick an accepted order first.');
    if (series.some(s => s[0].tags.compressed)) add('info', 'Compressed images are kept but cannot be previewed yet.');
    if (series.some(s => s.recon)) add('', 'A 3D reconstruction is ready for this series.');
    $('#send').disabled = !o;
  }

  $('#send').addEventListener('click', async () => {
    const o = MockStore.order(sel.value); if (!o || !series.length) return;
    const main = series.find(s => s.recon) || series.slice().sort((a, b) => b.length - a.length)[0]; await main.ready;
    let thumb = '';
    if (main.canvas && main.canvas.width) { const c = document.createElement('canvas'), k = 512 / Math.max(main.canvas.width, main.canvas.height); c.width = Math.round(main.canvas.width * k); c.height = Math.round(main.canvas.height * k);
      c.getContext('2d').drawImage(main.canvas, 0, 0, c.width, c.height); thumb = c.toDataURL('image/jpeg', .82); }
    const st = MockStore.addStudy(o.id, { series: series.length, images: series.reduce((n, s) => n + s.length, 0), thumb, recon: main.recon || '', uploaded: true });
    sent = true; show('series'); checks(); $('#send').hidden = true; $('#again').hidden = true; sel.disabled = true;
    const left = $('#left'); $('#series').hidden = true;
    const d = document.createElement('div'); d.className = 'done';
    d.innerHTML = '<div class="tick">✓</div><b></b><div class="sub"></div><div class="btns" style="width:80rem"></div>';
    d.querySelector('b').textContent = st.images + ' images are in the worklist';
    d.querySelector('.sub').textContent = o.name + ' · ' + o.exam.replace('\n', ' ') + ' · ' + o.id + ' now shows as Imaged for ' + o.inst.name + '.';
    const btn = (cls, text, href) => { const a = document.createElement('a'); a.className = 'pbtn ' + cls; a.textContent = text; a.href = href; d.querySelector('.btns').append(a); };
    btn('solid', 'Open the study', 'viewer.html?mrn=' + encodeURIComponent(st.mrn));
    if (st.recon) btn('ghost', 'Open in 3D', 'recon.html?series=' + st.recon + '&mrn=' + encodeURIComponent(st.mrn));
    btn('ghost', 'Back to the inbox', 'orders.html');
    left.append(d); MyFx.toast('Study added to the worklist');
  });

  fillOrders(); show('drop');
  window.Upload = { read };
})();

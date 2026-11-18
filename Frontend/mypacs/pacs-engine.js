// PacsEngine: the part of the viewer that knows about image data and nothing about the page.
// A "volume" is one series as a 3D block in patient axes (x = left, y = posterior, z = superior, x fastest),
// stored as uint16 with   real value = stored * scale + offset   (HU for CT, Bq/ml for PET, raw signal for MR).
// Any page (viewer, 3D, another app) can load a volume here and ask for slices, look-up tables and statistics.
(function (root) {
  const MODALITY = { MR: 'MRI', CT: 'CT', PT: 'PET', CR: 'X-Ray', DX: 'X-Ray', US: 'USG' };   // DICOM code -> name used in the app
  const PLANES = {
    ax: { name: 'Axial', u: 0, v: 1, n: 2, flip: false, edges: ['R', 'L', 'A', 'P'], color: '#ff7b7b' },
    co: { name: 'Coronal', u: 0, v: 2, n: 1, flip: true, edges: ['R', 'L', 'S', 'I'], color: '#7dffb0' },
    sa: { name: 'Sagittal', u: 1, v: 2, n: 0, flip: true, edges: ['A', 'P', 'S', 'I'], color: '#ffd66b' },
  };

  // ---------- SUV (body weight) ----------
  // SUV = activity [Bq/ml] x weight [g] / dose at scan time [Bq]. Every input comes from the DICOM tags;
  // if one is missing the answer is "not available" with the reason, never an estimate.
  function seconds(t) { if (!t || t.length < 6) return null; const s = +t.slice(0, 2) * 3600 + +t.slice(2, 4) * 60 + parseFloat(t.slice(4)); return isFinite(s) ? s : null; }
  function suvInfo(pet) {
    if (!pet) return { ok: false, missing: ['no PET information in the files'] };
    const missing = [];
    if (pet.units !== 'BQML') missing.push('units are "' + (pet.units || 'blank') + '", need BQML');
    if (!pet.weightKg) missing.push('patient weight');
    if (!pet.doseBq) missing.push('injected dose');
    if (!pet.halfLifeS) missing.push('half-life');
    let dt = 0;
    if (pet.decayCorrection === 'START') {
      const a = seconds(pet.startTime), b = seconds(pet.seriesTime) ?? seconds(pet.acquisitionTime);
      if (a == null) missing.push('injection time'); if (b == null) missing.push('series time');
      if (a != null && b != null) { dt = b - a; if (dt < 0) dt += 86400; }
    } else if (pet.decayCorrection !== 'ADMIN') missing.push('decay correction is "' + (pet.decayCorrection || 'blank') + '"');
    if (missing.length) return { ok: false, missing };
    const doseAtScan = pet.doseBq * Math.pow(2, -dt / pet.halfLifeS);
    return { ok: true, factor: pet.weightKg * 1000 / doseAtScan, uptakeMin: dt / 60, doseAtScanBq: doseAtScan, weightKg: pet.weightKg, doseBq: pet.doseBq, halfLifeS: pet.halfLifeS };
  }

  // ---------- volume ----------
  function finish(v) {
    const m = v.meta;
    v.dims = m.dims; v.sp = m.spacing; v.size = m.dims.map((d, i) => d * m.spacing[i]);
    v.scale = m.rescale ? m.rescale.scale : 1; v.offset = m.rescale ? m.rescale.offset : 0;
    v.modality = MODALITY[m.modality] || m.modality || '';
    v.suv = m.modality === 'PT' ? suvInfo(m.pet) : null;
    v.unitFactor = v.suv && v.suv.ok ? v.suv.factor : 1;
    v.unit = m.modality === 'CT' ? 'HU' : m.modality === 'PT' ? (v.suv.ok ? 'SUV' : (m.unit === 'BQML' ? 'Bq/ml' : m.unit || '')) : '';
    v.unitName = { HU: 'Hounsfield units', SUV: 'SUV (body weight)', 'Bq/ml': 'Activity, Bq/ml' }[v.unit] || 'Signal (no unit)';
    v.real = s => (s * v.scale + v.offset) * v.unitFactor;
    v.format = x => v.unit === 'SUV' ? x.toFixed(2) : v.unit === 'Bq/ml' ? Math.round(x).toLocaleString('en') : String(Math.round(x));
    // histogram once, for percentiles
    const h = new Uint32Array(65536), a = v.u16; for (let i = 0; i < a.length; i++) h[a[i]]++;
    const pct = p => { let n = a.length * p, s = 0; for (; s < 65535; s++) { n -= h[s]; if (n <= 0) break; } return v.real(s); };
    let lo = 0; while (lo < 65535 && !h[lo]) lo++; let hi = 65535; while (hi > 0 && !h[hi]) hi--;
    v.range = { min: v.real(lo), max: v.real(hi), p01: pct(.01), p05: pct(.05), p95: pct(.95), p98: pct(.98), p995: pct(.995), p999: pct(.999), p9999: pct(.9999) };
    return v;
  }
  async function gunzip(url) {
    const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
    return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  const cache = new Map();
  async function list(base) {                          // the converted series on the server
    base = base || 'data/';
    let ids = []; try { ids = await (await fetch(base + 'index.json')).json(); } catch (_) {}
    return (await Promise.all(ids.map(id => fetch(base + id + '/meta.json').then(r => r.json()).catch(() => null)))).filter(Boolean);
  }
  async function load(id, base) {                      // one converted series (made by tools/dicom2vol.py)
    base = base || 'data/';
    if (cache.has(id)) return cache.get(id);
    const meta = await (await fetch(base + id + '/meta.json')).json();
    const v = finish({ meta, u16: new Uint16Array(await gunzip(base + id + '/vol.u16.gz')), id });
    cache.set(id, v); return v;
  }

  // Real values -> the 16-bit store the engine works on. Whole numbers that fit are kept exact.
  function pack16(f) {
    let min = Infinity, max = -Infinity, whole = true;
    for (let i = 0; i < f.length; i++) { const x = f[i]; if (x < min) min = x; if (x > max) max = x; if (whole && x !== Math.round(x)) whole = false; }
    if (!isFinite(min) || !isFinite(max)) throw new Error('the image holds values that are not numbers');
    const offset = min < 0 ? min : 0, scale = whole && max - offset <= 65535 ? 1 : (max - offset) / 65535 || 1;
    const u16 = new Uint16Array(f.length); for (let i = 0; i < f.length; i++) u16[i] = Math.round((f[i] - offset) / scale);
    return { u16, rescale: { scale, offset } };
  }
  const dicomMeta = t0 => ({
    id: 'local', label: (t0.seriesDescription || t0.modality || 'Local series'), modality: t0.modality || '', bodyPart: t0.bodyPart || '', unit: t0.modality === 'CT' ? 'HU' : t0.units || '',
    local: true, synthetic: false, format: 'dicom', photometric: t0.photometric || '', compression: root.DicomLite.CODEC_NAME[t0.codec] || '', lossy: t0.codec === 'jpeg8' || !!t0.lossy,
    windowCenter: t0.windowCenter && t0.windowCenter.length ? t0.windowCenter[0] : null, windowWidth: t0.windowWidth && t0.windowWidth.length ? t0.windowWidth[0] : null,
    pet: t0.modality === 'PT' ? { units: t0.units || '', decayCorrection: t0.decayCorrection || '', weightKg: t0.weightKg || null, doseBq: t0.doseBq || null, halfLifeS: t0.halfLifeS || null, startTime: t0.startTime || '', seriesTime: t0.seriesTime || '', acquisitionTime: t0.acquisitionTime || '' } : null,
    anonymised: !(t0.patientName || t0.patientId),
  });
  // One picture (an X-ray, a single slice): shown as it is stored, no 3D, no patient directions.
  async function flatDicom(it) {
    const t = it.tags, px = await root.DicomLite.decode(await it.file.arrayBuffer(), t), two = a => a && a.length === 2 && a[0] > 0 && a[1] > 0 ? a : null;
    const ps = two(t.pixelSpacing), ips = two(t.imagerPixelSpacing), use = ps || ips || [1, 1], p = pack16(px);
    const meta = Object.assign(dicomMeta(t), { rescale: p.rescale, dims: [t.cols, t.rows, 1], spacing: [use[1], use[0], 1], origin: [0, 0, 0], flat: true,
      uncalibrated: !ps && !ips, spacingAt: ps ? 'patient' : ips ? 'detector' : '' });
    return finish({ meta, u16: p.u16, id: 'local' });
  }

  // Build a volume straight from DICOM files in the browser. `series` is one list from DicomLite.group().
  async function fromDicom(series, onProgress) {
    const t0 = series[0].tags, o = t0.orientation, why = root.DicomLite.support(t0);
    if (why) throw new Error(why);
    if (series.length < 2) return flatDicom(series[0]);
    if (!o || o.length !== 6 || !series.every(s => s.tags.position && s.tags.position.length === 3)) throw new Error('the files do not say where the slices are');
    const r = o.slice(0, 3), c = o.slice(3), n = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
    const axisOf = d => { const a = d.map(Math.abs), i = a.indexOf(Math.max(...a)); if (a.filter(x => x > .02).length > 1) throw new Error('tilted (oblique) series are not supported yet'); return [i, Math.sign(d[i])]; };
    const map = [axisOf(n), axisOf(c), axisOf(r)];       // array axes [slice, row, column] -> [patient axis, direction]
    const nk = series.length, ni = t0.rows, nj = t0.cols, ps = t0.pixelSpacing && t0.pixelSpacing.length === 2 ? t0.pixelSpacing : null;
    if (!ps) throw new Error('pixel spacing is missing');
    const step = [series.gap, ps[0], ps[1]], cnt = [nk, ni, nj], dims = [0, 0, 0], sp = [0, 0, 0];
    map.forEach(([ax], a) => { dims[ax] = cnt[a]; sp[ax] = step[a]; });
    const f = new Float32Array(nk * ni * nj), stride = [1, dims[0], dims[0] * dims[1]];
    for (let k = 0; k < nk; k++) {
      const it = series[k]; let px;
      if (it.tags.rows !== ni || it.tags.cols !== nj) throw new Error('the slices are not all the same size');
      try { px = await root.DicomLite.decode(await it.file.arrayBuffer(), it.tags); } catch (e) { throw new Error(it.file.name + ': ' + e.message); }
      const kk = map[0][1] > 0 ? k : nk - 1 - k;
      for (let i = 0; i < ni; i++) {
        const ii = map[1][1] > 0 ? i : ni - 1 - i, base = kk * stride[map[0][0]] + ii * stride[map[1][0]], sj = stride[map[2][0]], row = i * nj;
        for (let j = 0; j < nj; j++) f[base + (map[2][1] > 0 ? j : nj - 1 - j) * sj] = px[row + j];
      }
      if (onProgress && (k % 8 === 0 || k === nk - 1)) { onProgress(k + 1, nk); await new Promise(res => setTimeout(res)); }
    }
    const pk = pack16(f);
    const origin = [0, 1, 2].map(ax => Math.min(...[series[0], series[nk - 1]].flatMap(s => { const p = s.tags.position; return [0, ni - 1].flatMap(i => [0, nj - 1].map(j => p[ax] + i * ps[0] * c[ax] + j * ps[1] * r[ax])); })));
    const meta = Object.assign(dicomMeta(t0), { rescale: pk.rescale, dims, spacing: sp.map(x => +x.toFixed(4)), origin });
    return finish({ meta, u16: pk.u16, id: 'local' });
  }

  // Build a volume from one NIfTI-1 file (.nii or .nii.gz). The file is turned to the engine's axes (left, posterior, superior)
  // by the nearest whole-axis turn; a tilted file is not resampled, it is flagged in meta.tilted.
  const NII = { 2: [1, 'Uint8'], 4: [2, 'Int16'], 8: [4, 'Int32'], 16: [4, 'Float32'], 64: [8, 'Float64'], 256: [1, 'Int8'], 512: [2, 'Uint16'], 768: [4, 'Uint32'] };
  async function fromNifti(buf, name, onProgress) {
    let b8 = new Uint8Array(buf);
    if (b8[0] === 0x1F && b8[1] === 0x8B) { buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); b8 = new Uint8Array(buf); }
    if (buf.byteLength < 352) throw new Error('not a NIfTI file');
    const dv = new DataView(buf); let le = true;
    if (dv.getInt32(0, true) !== 348) { if (dv.getInt32(0, false) === 348) le = false; else throw new Error(dv.getInt32(0, true) === 540 || dv.getInt32(0, false) === 540 ? 'NIfTI-2 files are not supported yet' : 'not a NIfTI file'); }
    const magic = String.fromCharCode(b8[344], b8[345], b8[346]);
    if (magic === 'ni1') throw new Error('this is the header half of an .hdr/.img pair: only single .nii files are supported');
    if (magic !== 'n+1') throw new Error('not a NIfTI file');
    const i16 = o => dv.getInt16(o, le), f32 = o => dv.getFloat32(o, le);
    const nd = i16(40), n = [i16(42), nd > 1 ? i16(44) : 1, nd > 2 ? i16(46) : 1], type = NII[i16(70)];
    if (nd < 2 || n.some(x => x < 1)) throw new Error('the NIfTI file has no image');
    if (!type) throw new Error('this NIfTI data type (code ' + i16(70) + ') is not supported yet');
    const pd = [1, 2, 3].map(i => Math.abs(f32(76 + i * 4)) || 1), off = Math.max(352, Math.round(f32(108))), count = n[0] * n[1] * n[2];
    if (off + count * type[0] > buf.byteLength) throw new Error('the NIfTI file is cut short');
    let slope = f32(112), inter = f32(116); if (!isFinite(slope) || slope === 0) { slope = 1; inter = 0; } if (!isFinite(inter)) inter = 0;
    // voxel axes -> world (right, anterior, superior), from the sform, else the qform, else assumed
    let R, assumed = false;
    if (i16(254) > 0) R = [0, 1, 2].map(r => [0, 1, 2].map(c => f32(280 + r * 16 + c * 4)));
    else if (i16(252) > 0) {
      const b = f32(256), c = f32(260), d = f32(264), a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d)), qf = f32(76) < 0 ? -1 : 1;
      const q = [[a * a + b * b - c * c - d * d, 2 * b * c - 2 * a * d, 2 * b * d + 2 * a * c], [2 * b * c + 2 * a * d, a * a + c * c - b * b - d * d, 2 * c * d - 2 * a * b], [2 * b * d - 2 * a * c, 2 * c * d + 2 * a * b, a * a + d * d - c * c - b * b]];
      R = q.map(r => [r[0] * pd[0], r[1] * pd[1], r[2] * pd[2] * qf]);
    } else { R = [[pd[0], 0, 0], [0, pd[1], 0], [0, 0, pd[2]]]; assumed = true; }
    const map = [], dims = [0, 0, 0], sp = [0, 0, 0]; let tilt = 0;
    for (let a = 0; a < 3; a++) {
      const col = [R[0][a], R[1][a], R[2][a]], len = Math.hypot(...col) || 1, ab = col.map(Math.abs), w = ab.indexOf(Math.max(...ab));
      tilt = Math.max(tilt, Math.sqrt(Math.max(0, 1 - (ab[w] / len) ** 2)));
      map.push([w, (w === 2 ? 1 : -1) * Math.sign(col[w])]);                 // world right/anterior run against our left/posterior
      dims[w] = n[a]; sp[w] = +len.toFixed(4);
    }
    if (new Set(map.map(m => m[0])).size !== 3) throw new Error('the directions in the NIfTI file do not make sense');
    const get = dv['get' + type[1]].bind(dv), bytes = type[0], f = new Float32Array(count), st = [1, dims[0], dims[0] * dims[1]];
    for (let k = 0, q = off; k < n[2]; k++) {
      const bk = (map[2][1] > 0 ? k : n[2] - 1 - k) * st[map[2][0]];
      for (let j = 0; j < n[1]; j++) {
        const bj = bk + (map[1][1] > 0 ? j : n[1] - 1 - j) * st[map[1][0]], si = st[map[0][0]] * map[0][1], b0 = bj + (map[0][1] > 0 ? 0 : n[0] - 1) * st[map[0][0]];
        for (let i = 0; i < n[0]; i++, q += bytes) f[b0 + i * si] = get(q, le) * slope + inter;
      }
      if (onProgress && (k % 16 === 0 || k === n[2] - 1)) { onProgress(k + 1, n[2]); await new Promise(res => setTimeout(res)); }
    }
    const pk = pack16(f), label = String(name || 'NIfTI volume').replace(/\.nii(\.gz)?$/i, '');
    const meta = { id: 'local', label, modality: '', bodyPart: '', unit: '', local: true, synthetic: false, format: 'nifti', rescale: pk.rescale, dims, spacing: sp, origin: [0, 0, 0],
      flat: n[2] === 1, orientationAssumed: assumed, tilted: tilt > .05, volumes: nd > 3 ? Math.max(1, i16(48)) : 1, windowCenter: null, windowWidth: null, pet: null, anonymised: true };
    return finish({ meta, u16: pk.u16, id: 'local' });
  }
  // A NIfTI file does not say what scanner made it. The reader can say "this is a CT" so the values read as HU.
  function setModality(v, code) { v.meta.modality = code || ''; v.meta.unit = code === 'CT' ? 'HU' : ''; return finish(v); }

  // ---------- slices ----------
  // Stored values of one slice into `out` (Uint16Array, plane width x height). slab > 0 takes the brightest of +-slab slices (MIP).
  function slice(v, plane, idx, out, slab) {
    const p = PLANES[plane], D = v.dims, w = D[p.u], h = D[p.v], st = [1, D[0], D[0] * D[1]], su = st[p.u], sv = st[p.v], sn = st[p.n], a = v.u16;
    const k0 = Math.max(0, idx - (slab || 0)), k1 = Math.min(D[p.n] - 1, idx + (slab || 0));
    for (let y = 0, q = 0; y < h; y++) {
      const row = (p.flip ? h - 1 - y : y) * sv;
      if (k0 === k1) for (let x = 0, o = idx * sn + row; x < w; x++, o += su) out[q++] = a[o];
      else for (let x = 0; x < w; x++) { let m = 0, o = k0 * sn + row + x * su; for (let k = k0; k <= k1; k++, o += sn) if (a[o] > m) m = a[o]; out[q++] = m; }
    }
    return out;
  }
  const KERNEL = { smooth: [1, 2, 1, 2, 4, 2, 1, 2, 1].map(x => x / 16), sharpen: [0, -1, 0, -1, 5, -1, 0, -1, 0] };
  function filter(src, w, h, kind, out) {              // 3x3 filters on stored values
    if (kind === 'median') {
      const b = new Uint16Array(9);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let n = 0; for (let dy = -1; dy <= 1; dy++) { const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx; b[n++] = src[yy * w + xx]; } }
        b.sort(); out[y * w + x] = b[4];
      }
      return out;
    }
    const k = KERNEL[kind]; if (!k) { out.set(src); return out; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) { const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx; s += src[yy * w + xx] * k[n++]; } }
      out[y * w + x] = s < 0 ? 0 : s > 65535 ? 65535 : s;
    }
    return out;
  }

  // ---------- display ----------
  const ramp = (stops) => t => { const x = t * (stops.length - 1), i = Math.min(stops.length - 2, x | 0), f = x - i, a = stops[i], b = stops[i + 1]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; };
  const COLORMAPS = {
    grey: { name: 'Grey', fn: t => [t * 255, t * 255, t * 255] },
    hot: { name: 'Hot', fn: ramp([[0, 0, 0], [150, 0, 0], [255, 90, 0], [255, 210, 40], [255, 255, 255]]) },
    rainbow: { name: 'Rainbow', fn: ramp([[0, 0, 0], [40, 0, 150], [0, 110, 255], [0, 220, 170], [130, 255, 0], [255, 220, 0], [255, 40, 0]]) },
    teal: { name: 'Teal', fn: ramp([[0, 0, 0], [10, 60, 70], [40, 150, 140], [160, 245, 215], [255, 255, 255]]) },
  };
  // 65536-entry RGBA table for a window given in display units (HU, SUV or raw): lo..hi maps to black..white
  function lut(v, lo, hi, cmap, invert, out) {
    out = out || new Uint32Array(65536);
    const fn = (COLORMAPS[cmap] || COLORMAPS.grey).fn, a = v.scale * v.unitFactor, b = v.offset * v.unitFactor, k = 1 / ((hi - lo) || 1e-6);
    for (let s = 0; s < 65536; s++) {
      let t = (s * a + b - lo) * k; t = t < 0 ? 0 : t > 1 ? 1 : t; if (invert) t = 1 - t;
      const c = fn(t); out[s] = 0xFF000000 | (c[2] << 16) | (c[1] << 8) | (c[0] | 0);
    }
    return out;
  }
  // Windows as [name, width, level]. CT values are the usual textbook windows: confirm them with the radiologist.
  function presets(v) {
    const r = v.range, m = v.meta, P = [], wl = (name, lo, hi) => P.push({ name, lo, hi });
    if (v.unit === 'HU') [['Soft tissue', 400, 40], ['Lung', 1500, -600], ['Bone', 1800, 400], ['Brain', 80, 40], ['Mediastinum', 350, 50]].forEach(([n, w, l]) => wl(n, l - w / 2, l + w / 2));
    else if (v.unit === 'SUV') { wl('Auto', 0, r.p9999); [5, 7, 10, 15].forEach(x => wl('SUV 0–' + x, 0, x)); }
    else { wl('Auto', r.p01, r.p995); wl('High contrast', r.p05, r.p98); }
    if (m.windowWidth > 1 && m.windowCenter != null && v.unit !== 'SUV') wl('From file', (m.windowCenter - m.windowWidth / 2) * v.unitFactor, (m.windowCenter + m.windowWidth / 2) * v.unitFactor);
    wl('Full range', r.min, r.max);
    return P;
  }

  // ---------- measuring ----------
  const voxelAt = (v, mm) => mm.map((x, i) => Math.min(v.dims[i] - 1, Math.max(0, Math.floor(x / v.sp[i]))));
  function valueAt(v, mm) { const [i, j, k] = voxelAt(v, mm); return v.real(v.u16[(k * v.dims[1] + j) * v.dims[0] + i]); }
  // Ellipse on one slice. Centre and radii in mm along the plane's own axes (u, v of the volume, not flipped).
  function roi(v, plane, idx, cu, cv, ru, rv) {
    const p = PLANES[plane], D = v.dims, st = [1, D[0], D[0] * D[1]], su = v.sp[p.u], sv = v.sp[p.v];
    let n = 0, sum = 0, sq = 0, min = Infinity, max = -Infinity, at = null;
    const u0 = Math.max(0, Math.floor((cu - ru) / su)), u1 = Math.min(D[p.u] - 1, Math.ceil((cu + ru) / su)), v0 = Math.max(0, Math.floor((cv - rv) / sv)), v1 = Math.min(D[p.v] - 1, Math.ceil((cv + rv) / sv));
    for (let b = v0; b <= v1; b++) for (let a = u0; a <= u1; a++) {
      const du = ((a + .5) * su - cu) / (ru || 1e-6), dv = ((b + .5) * sv - cv) / (rv || 1e-6);
      if (du * du + dv * dv > 1) continue;
      const x = v.real(v.u16[idx * st[p.n] + b * st[p.v] + a * st[p.u]]); n++; sum += x; sq += x * x; if (x < min) min = x; if (x > max) { max = x; at = [a, b]; }
    }
    if (!n) return null;
    const mean = sum / n;
    return { n, mean, sd: Math.sqrt(Math.max(0, sq / n - mean * mean)), min, max, maxAt: at, areaMm2: Math.PI * ru * rv };
  }


  // ---------- body mask and 3D metadata, for a volume built in the browser ----------
  // A filled, softened mask of the body (0..255): gives the 3D view a clean skin surface and solid cut faces.
  // Same idea as tools/dicom2vol.py: threshold between air and tissue, fill the holes slice by slice, soften.
  function bodyMask(v) {
    const [nx, ny, nz] = v.dims, n = nx * ny * nz, a = v.u16, h = new Float64Array(65536);
    let top = 0; for (let i = 0; i < n; i++) { const s = a[i]; if (s) { h[s]++; if (s > top) top = s; } }
    let total = 0, sumAll = 0; for (let s = 1; s <= top; s++) { total += h[s]; sumAll += h[s] * s; }
    const split = upTo => {                                    // Otsu on the non-zero values up to a limit
      let tot = 0, all = 0; for (let s = 1; s <= upTo; s++) { tot += h[s]; all += h[s] * s; }
      let w = 0, sum = 0, best = -1, cut = 1;
      for (let s = 1; s < upTo; s++) { w += h[s]; sum += h[s] * s; if (!w || w === tot) continue; const m0 = sum / w, m1 = (all - sum) / (tot - w), q = w * (tot - w) * (m0 - m1) * (m0 - m1); if (q > best) { best = q; cut = s; } }
      return cut;
    };
    let otsu = split(top), above = 0; for (let s = otsu + 1; s <= top; s++) above += h[s];
    if (above < total * .1) otsu = split(otsu);                 // a few very bright spots (PET uptake) took the split: look below them for the body
    const thr = otsu * .55, bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = a[i] > thr ? 1 : 0;
    // fill holes: in every slice, along each of the three directions, whatever air cannot be reached from the edge is inside
    const st = [1, nx, nx * ny], D = v.dims, stack = new Int32Array(Math.max(nx * ny, nx * nz, ny * nz));
    for (let ax = 0; ax < 3; ax++) {
      const ua = (ax + 1) % 3, va = (ax + 2) % 3, W = D[ua], H = D[va], su = st[ua], sv = st[va], seen = new Uint8Array(W * H);
      for (let k = 0; k < D[ax]; k++) {
        const base = k * st[ax]; seen.fill(0); let top2 = 0;
        const push = (x, y) => { const q = y * W + x; if (!seen[q] && !bin[base + x * su + y * sv]) { seen[q] = 1; stack[top2] = q; top2 += 1; } };
        for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); } for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
        while (top2 > 0) { top2 -= 1; const q = stack[top2], x = q % W, y = (q - x) / W; if (x > 0) push(x - 1, y); if (x < W - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < H - 1) push(x, y + 1); }
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!seen[y * W + x]) bin[base + x * su + y * sv] = 1;
      }
    }
    // soften with a 3-voxel box along each axis; lone specks of noise fall below one half and vanish
    let cur = new Float32Array(n), nxt = new Float32Array(n); for (let i = 0; i < n; i++) cur[i] = bin[i];
    for (let ax = 0; ax < 3; ax++) {
      const s = st[ax], len = D[ax];
      for (let i = 0; i < n; i++) { const c = Math.floor(i / s) % len; nxt[i] = (cur[i] + (c > 0 ? cur[i - s] : cur[i]) + (c < len - 1 ? cur[i + s] : cur[i])) / 3; }
      [cur, nxt] = [nxt, cur];
    }
    const mask = new Uint8Array(n), lo = [nx, ny, nz], hi = [-1, -1, -1];
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const m = cur[i] * 255; mask[i] = m;
      if (m >= 128) { if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x; if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y; if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z; }
    }
    if (hi[0] < 0) { lo.fill(0); hi[0] = nx - 1; hi[1] = ny - 1; hi[2] = nz - 1; }
    let cnt = n * .001, p999 = top; for (let s = 65535; s > 0; s--) { cnt -= (s <= top ? h[s] : 0); if (cnt <= 0) { p999 = s; break; } }
    const box = [0, 1, 2].map(i => [lo[i], hi[i]]);
    return { mask, thr, hi: Math.max(p999, 1), max: top, bodyBox: box, bodyExtentMm: box.map((b, i) => +((b[1] - b[0] + 1) * v.sp[i]).toFixed(1)) };
  }
  // What the 3D page needs to show a volume that was built here
  function pack3d(v) {
    const b = bodyMask(v), m = v.meta;
    const tags = [['Study', 'Modality', m.modality, ''], ['Study', 'Body part', m.bodyPart || '', ''], ['Image', 'Matrix', m.dims.join(' × '), ''], ['Image', 'Voxel', m.spacing.join(' × '), 'mm'], ['Image', 'Source', 'Read in the browser from this computer', '']];
    return { type: 'mypacs-volume', u16: v.u16, mask: b.mask, meta: { ...m, hi: b.hi, iso: b.thr, max: b.max, bodyBox: b.bodyBox, bodyExtentMm: b.bodyExtentMm, tags, credit: 'Opened from this computer. Nothing was uploaded.' } };
  }

  root.PacsEngine = { bodyMask, pack3d, MODALITY, PLANES, COLORMAPS, suvInfo, list, load, fromDicom, fromNifti, setModality, slice, filter, lut, presets, voxelAt, valueAt, roi };
})(typeof window !== 'undefined' ? window : globalThis);

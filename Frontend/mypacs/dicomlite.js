// A small DICOM reader: header tags and pixel data. No page code in here.
// Reads Part 10 files in Explicit or Implicit VR Little Endian, uncompressed, RLE, lossless JPEG (with codecs.js), and in a browser also
// 8-bit baseline JPEG, JPEG 2000 and JPEG-LS. Anything else (multi-frame, colour, 12-bit lossy JPEG) is refused with a plain reason: see support().
(function (root) {
  const LONG = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UN', 'UR', 'UT', 'SV', 'UV']);
  const WANT = {                       // tag -> [name, kind]   kind: s text, n number, m numbers split by "\", u unsigned short
    '00080060': ['modality', 's'], '0008103E': ['seriesDescription', 's'], '00081030': ['studyDescription', 's'], '00080020': ['studyDate', 's'],
    '00080018': ['sopUid', 's'], '0020000D': ['studyUid', 's'], '0020000E': ['seriesUid', 's'], '00180015': ['bodyPart', 's'],
    '00100010': ['patientName', 's'], '00100020': ['patientId', 's'], '00100030': ['patientBirthDate', 's'], '00100040': ['patientSex', 's'],
    '00200013': ['instance', 'n'], '00200032': ['position', 'm'], '00200037': ['orientation', 'm'], '00180050': ['sliceThickness', 'n'],
    '00280002': ['samples', 'u'], '00280004': ['photometric', 's'], '00280010': ['rows', 'u'], '00280011': ['cols', 'u'], '00280030': ['pixelSpacing', 'm'],
    '00280100': ['bitsAllocated', 'u'], '00280101': ['bitsStored', 'u'], '00280008': ['frames', 'n'], '00181164': ['imagerPixelSpacing', 'm'], '00180088': ['spacingBetweenSlices', 'n'], '00280103': ['signed', 'u'], '00281050': ['windowCenter', 'm'], '00281051': ['windowWidth', 'm'],
    '00101030': ['weightKg', 'n'], '00541001': ['units', 's'], '00541102': ['decayCorrection', 's'], '00080031': ['seriesTime', 's'], '00080032': ['acquisitionTime', 's'],
    '00181072': ['startTime', 's'], '00181074': ['doseBq', 'n'], '00181075': ['halfLifeS', 'n'],   // inside the radiopharmaceutical sequence
    '00281052': ['intercept', 'n'], '00281053': ['slope', 'n'], '00080070': ['manufacturer', 's'], '00180087': ['fieldStrength', 'n'],
  };
  const PLAIN = { '1.2.840.10008.1.2': 'implicit', '1.2.840.10008.1.2.1': 'explicit' };
  const J = '1.2.840.10008.1.2.4.';
  const CODEC = { '1.2.840.10008.1.2.5': 'rle', [J + '57']: 'jpegll', [J + '70']: 'jpegll', [J + '50']: 'jpeg8', [J + '90']: 'j2k', [J + '91']: 'j2k', [J + '80']: 'jls', [J + '81']: 'jls' };          // what we can decode
  const CODEC_NAME = { rle: 'RLE lossless', jpegll: 'JPEG lossless', jpeg8: 'JPEG baseline (lossy)', j2k: 'JPEG 2000', jls: 'JPEG-LS' };
  const REFUSED = {                                                                                                        // what we know but cannot decode
    [J + '51']: 'JPEG Extended (12-bit, lossy)',
    [J + '201']: 'HTJ2K', [J + '202']: 'HTJ2K', [J + '203']: 'HTJ2K', '1.2.840.10008.1.2.1.99': 'deflated', '1.2.840.10008.1.2.2': 'big-endian',
  };
  const hex = (g, e) => (g.toString(16).padStart(4, '0') + e.toString(16).padStart(4, '0')).toUpperCase();

  // Returns { ok, error, syntax, tags..., pixelOffset, pixelLength }
  function parse(buf) {
    const dv = new DataView(buf), n = dv.byteLength, out = { ok: false };
    if (n < 140 || String.fromCharCode(dv.getUint8(128), dv.getUint8(129), dv.getUint8(130), dv.getUint8(131)) !== 'DICM') { out.error = 'not a DICOM file'; return out; }
    const text = (o, l) => { let s = ''; for (let i = 0; i < l; i++) { const c = dv.getUint8(o + i); if (c) s += String.fromCharCode(c); } return s.trim(); };
    let p = 132, explicit = true, syntax = '';
    function skipSeq(pos, expl) {                       // sequence of undefined length: walk the items to find its end
      while (pos + 8 <= n) {
        const g = dv.getUint16(pos, true), e = dv.getUint16(pos + 2, true), len = dv.getUint32(pos + 4, true); pos += 8;
        if (g === 0xFFFE && e === 0xE0DD) return pos;
        if (g !== 0xFFFE || e !== 0xE000) return n;
        if (len !== 0xFFFFFFFF) { pos += len; continue; }
        while (pos + 8 <= n) {                           // item of undefined length: its elements, until the item delimiter
          const g2 = dv.getUint16(pos, true), e2 = dv.getUint16(pos + 2, true);
          if (g2 === 0xFFFE && e2 === 0xE00D) { pos += 8; break; }
          const el = head(pos, expl); pos = el.len === 0xFFFFFFFF ? skipSeq(el.at, expl) : el.at + el.len;
        }
      }
      return n;
    }
    function head(pos, expl) {
      if (expl) {
        const vr = String.fromCharCode(dv.getUint8(pos + 4), dv.getUint8(pos + 5));
        if (LONG.has(vr)) return { vr, len: dv.getUint32(pos + 8, true), at: pos + 12 };
        return { vr, len: dv.getUint16(pos + 6, true), at: pos + 8 };
      }
      return { vr: '', len: dv.getUint32(pos + 4, true), at: pos + 8 };
    }
    try {
      while (p + 8 <= n) {
        const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true), expl = g === 2 ? true : explicit, el = head(p, expl), key = hex(g, e);
        if (g === 2 && e === 0x10) { syntax = text(el.at, el.len); out.syntax = syntax; explicit = syntax !== '1.2.840.10008.1.2'; }
        if (g === 0x7FE0 && e === 0x10) { out.pixelOffset = el.at; out.pixelLength = el.len === 0xFFFFFFFF ? -1 : el.len; break; }
        if (key === '00540016') {                          // radiopharmaceutical information: read the tags inside its items
          const end = el.len === 0xFFFFFFFF ? skipSeq(el.at, expl) : el.at + el.len; let q = el.at;
          while (q + 8 <= end) {
            const g2 = dv.getUint16(q, true), e2 = dv.getUint16(q + 2, true);
            if (g2 === 0xFFFE) { q += 8; continue; }
            const el2 = head(q, expl), w2 = WANT[hex(g2, e2)];
            if (el2.len === 0xFFFFFFFF) { q = skipSeq(el2.at, expl); continue; }
            if (w2) { const t2 = text(el2.at, el2.len); out[w2[0]] = w2[1] === 'n' ? (t2 === '' ? null : parseFloat(t2)) : t2; }
            q = el2.at + el2.len;
          }
          p = end; continue;
        }
        if (el.len === 0xFFFFFFFF) { p = skipSeq(el.at, expl); continue; }
        const w = WANT[key];
        if (w) {
          const [name, kind] = w;
          if (kind === 'u') out[name] = dv.getUint16(el.at, true);
          else { const s = text(el.at, el.len); out[name] = kind === 's' ? s : kind === 'n' ? (s === '' ? null : parseFloat(s)) : s === '' ? [] : s.split('\\').map(Number); }
        }
        p = el.at + el.len;
      }
    } catch (err) { out.error = 'could not read the header'; return out; }
    if (!out.rows || !out.cols) { out.error = REFUSED[syntax] === 'deflated' ? 'deflated DICOM cannot be read here yet' : 'no image in the file'; return out; }
    out.compressed = !PLAIN[syntax];
    out.codec = PLAIN[syntax] ? 'raw' : CODEC[syntax] || '';
    out.ok = true; return out;
  }

  // '' when the pixels of a parsed file can be read here, otherwise the reason in plain words
  function support(t) {
    if (t.pixelOffset == null) return 'the file has no pixel data';
    if (!t.codec) return (REFUSED[t.syntax] || 'this kind of') + ' compressed DICOM cannot be read here yet';
    if ((t.frames || 1) > 1) return 'multi-frame files are not supported yet';
    if ((t.samples || 1) !== 1) return 'colour images (ultrasound clips, screenshots) are not supported yet';
    const bits = t.bitsAllocated || 16;
    if (bits !== 8 && bits !== 16) return bits + '-bit pixels are not supported yet';
    if (t.codec === 'jpeg8' && (bits !== 8 || typeof createImageBitmap !== 'function')) return 'this JPEG can only be read in a browser, 8-bit';
    if (t.codec !== 'raw' && t.codec !== 'jpeg8' && !root.PacsCodecs) return 'the decoders (codecs.js) are not loaded';
    if ((t.codec === 'j2k' || t.codec === 'jls') && !root.PacsCodecs.canWasm()) return CODEC_NAME[t.codec] + ' can only be read in a browser';
    return '';
  }
  // The compressed bytes of a single-frame file: every fragment after the offset table, joined
  function fragments(buf, t) {
    const dv = new DataView(buf), n = buf.byteLength, parts = []; let p = t.pixelOffset, total = 0, first = true;
    while (p + 8 <= n) {
      const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true), len = dv.getUint32(p + 4, true); p += 8;
      if (g !== 0xFFFE || e !== 0xE000) break;
      if (!first) { const part = new Uint8Array(buf, p, Math.min(len, n - p)); parts.push(part); total += part.length; }
      first = false; p += len;
    }
    if (!parts.length) throw new Error('no compressed image in the file');
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(total); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return out;
  }
  // Stored values -> real values: keep the stored bits, apply the sign, then the rescale slope and intercept
  function rescale(get, count, t) {
    const out = new Float32Array(count), s = t.slope || 1, b = t.intercept || 0, bits = t.bitsAllocated || 16, bs = Math.min(t.bitsStored || bits, bits), sh = 32 - bs, mask = (1 << bs) - 1;
    if (t.signed) for (let i = 0; i < count; i++) out[i] = ((get(i) << sh) >> sh) * s + b;
    else for (let i = 0; i < count; i++) out[i] = (get(i) & mask) * s + b;
    return out;
  }
  function plain(buf, t) {                                  // every kind that needs no waiting
    const count = t.rows * t.cols, bytes = (t.bitsAllocated || 16) / 8;
    if (t.codec === 'raw') {
      if (t.pixelLength < 0 || t.pixelOffset + count * bytes > buf.byteLength) throw new Error('the pixel data is cut short');
      const dv = new DataView(buf, t.pixelOffset); return rescale(bytes === 1 ? i => dv.getUint8(i) : i => dv.getUint16(i * 2, true), count, t);
    }
    if (t.codec === 'rle') { const raw = root.PacsCodecs.rle(fragments(buf, t), count, bytes, 1); return rescale(bytes === 1 ? i => raw[i] : i => raw[i * 2] | (raw[i * 2 + 1] << 8), count, t); }
    const j = root.PacsCodecs.jpegLossless(fragments(buf, t));
    if (j.width !== t.cols || j.height !== t.rows || j.components !== 1) throw new Error('the JPEG inside does not match the DICOM header');
    return rescale(i => j.data[i], count, t);
  }
  // Pixel values of one parsed file as a Float32Array (rescaled). Rejects with the reason when it cannot be read.
  async function decode(buf, t) {
    const why = support(t); if (why) throw new Error(why);
    if (t.codec === 'j2k' || t.codec === 'jls') {                        // the image itself says how many bits and whether signed
      const j = await root.PacsCodecs.wasm(t.codec, fragments(buf, t)), n = t.rows * t.cols, out = new Float32Array(n), s = t.slope || 1, b = t.intercept || 0;
      if (j.width !== t.cols || j.height !== t.rows || j.components !== 1) throw new Error('the image inside does not match the DICOM header');
      t.lossy = j.lossy;
      if (j.signed !== !!t.signed) return rescale(i => j.data[i] & 0xFFFF, n, t);   // the image and the DICOM header disagree about the sign: the header wins
      for (let i = 0; i < n; i++) out[i] = j.data[i] * s + b;
      return out;
    }
    if (t.codec !== 'jpeg8') return plain(buf, t);
    const bmp = await createImageBitmap(new Blob([fragments(buf, t)], { type: 'image/jpeg' }));
    const cv = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const c = cv.getContext('2d'); c.drawImage(bmp, 0, 0); const px = c.getImageData(0, 0, bmp.width, bmp.height).data;
    if (bmp.width !== t.cols || bmp.height !== t.rows) throw new Error('the JPEG inside does not match the DICOM header');
    return rescale(i => px[i * 4], t.rows * t.cols, t);
  }

  // Pixel values of one parsed file as a Float32Array (rescaled), or null when it cannot be shown
  // (the no-waiting version of decode(): baseline JPEG gives null here)
  function pixels(buf, t) {
    if (support(t) || t.codec === 'jpeg8' || t.codec === 'j2k' || t.codec === 'jls') return null;
    try { return plain(buf, t); } catch (_) { return null; }
  }

  // Group parsed files into series, slices in order along the scan direction
  function group(items) {
    const map = new Map();
    for (const it of items) { const k = it.tags.seriesUid || 'no-uid'; if (!map.has(k)) map.set(k, []); map.get(k).push(it); }
    return [...map.values()].map(list => {
      const o = list[0].tags.orientation;
      if (o && o.length === 6 && list.every(x => x.tags.position && x.tags.position.length === 3)) {
        const nrm = [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]];
        const d = x => x.tags.position[0] * nrm[0] + x.tags.position[1] * nrm[1] + x.tags.position[2] * nrm[2];
        list.sort((a, b) => d(a) - d(b));
        if (list.length > 1) list.gap = Math.abs(d(list[list.length - 1]) - d(list[0])) / (list.length - 1);
      } else list.sort((a, b) => (a.tags.instance || 0) - (b.tags.instance || 0));
      return list;
    });
  }
  root.DicomLite = { parse, pixels, decode, support, group, CODEC_NAME };
})(typeof window !== 'undefined' ? window : globalThis);

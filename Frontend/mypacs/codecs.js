// Pixel decoders for compressed DICOM. No page code in here: bytes in, numbers out.
//   PacsCodecs.rle(frame, count, bytesPer, samples)  -> Uint8Array, little-endian, samples interleaved
//   PacsCodecs.jpegLossless(frame)                   -> { width, height, precision, components, data: Uint16Array (interleaved) }
//   PacsCodecs.wasm(kind, frame)                     -> Promise of { width, height, bits, components, signed, lossy, data: typed array }
//       kind 'j2k' (JPEG 2000, OpenJPEG) or 'jls' (JPEG-LS, CharLS). These two are outside libraries kept in vendor/ (see vendor/README.md),
//       loaded the first time such a file is opened. They need a browser. PacsCodecs.LIBS says where they are; set LIBS.j2k.base to move them.
(function (root) {

  // ---- DICOM RLE (PackBits, one segment per byte plane, most significant byte first) ----
  function rle(frame, count, bytesPer, samples) {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength), nseg = dv.getUint32(0, true), want = bytesPer * samples;
    if (nseg !== want) throw new Error('RLE data has ' + nseg + ' segments, expected ' + want);
    const out = new Uint8Array(count * want);
    for (let s = 0; s < nseg; s++) {
      let p = dv.getUint32(4 + s * 4, true); const end = s + 1 < nseg ? dv.getUint32(8 + s * 4, true) : frame.length;
      const sample = Math.floor(s / bytesPer), byte = bytesPer - 1 - (s % bytesPer);       // where this plane goes in a little-endian value
      let o = sample * bytesPer + byte, n = 0;
      while (p < end && n < count) {
        const h = frame[p++];
        if (h < 128) { for (let i = 0; i <= h && n < count; i++, n++, o += want) out[o] = frame[p++]; }
        else if (h > 128) { const v = frame[p++]; for (let i = 0; i < 257 - h && n < count; i++, n++, o += want) out[o] = v; }
      }
      if (n < count) throw new Error('RLE data ends early');
    }
    return out;
  }

  // ---- Lossless JPEG (ITU T.81 process 14: SOF3, Huffman, predictors 1 to 7) ----
  function jpegLossless(d) {
    if (d[0] !== 0xFF || d[1] !== 0xD8) throw new Error('not a JPEG stream');
    const u16 = q => (d[q] << 8) | d[q + 1], tables = [];
    let p = 2, P = 0, Y = 0, X = 0, comps = [], ri = 0;
    for (;;) {
      if (p + 4 > d.length) throw new Error('JPEG data ends before the image');
      if (d[p] !== 0xFF) { p++; continue; }
      const m = d[p + 1]; if (m === 0xFF) { p++; continue; }
      p += 2; if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) continue;
      if (m === 0xD9) throw new Error('JPEG has no image data');
      const end = p + u16(p); let q = p + 2;
      if (m === 0xC3) {
        P = d[q]; Y = u16(q + 1); X = u16(q + 3); const nf = d[q + 5]; comps = [];
        for (let i = 0; i < nf; i++) { if (d[q + 7 + i * 3] !== 0x11) throw new Error('subsampled lossless JPEG is not supported'); comps.push({ id: d[q + 6 + i * 3] }); }
      } else if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) throw new Error('this JPEG is not the lossless kind');
      else if (m === 0xC4) {
        while (q < end) {                                   // one or more Huffman tables: a 16-bit peek -> (code length << 5 | symbol)
          const th = d[q++] & 15, counts = d.subarray(q, q + 16); q += 16;
          const lut = new Uint16Array(65536); let code = 0;
          for (let len = 1; len <= 16; len++) {
            for (let i = 0; i < counts[len - 1]; i++) { const sym = d[q++], from = code << (16 - len), to = from + (1 << (16 - len)); lut.fill((len << 5) | sym, from, to); code++; }
            code <<= 1;
          }
          tables[th] = lut;
        }
      } else if (m === 0xDD) ri = u16(q);
      else if (m === 0xDA) {
        const ns = d[q]; if (ns !== comps.length) throw new Error('lossless JPEG with separate scans is not supported');
        const tb = []; for (let i = 0; i < ns; i++) { const t = tables[d[q + 2 + i * 2] >> 4]; if (!t) throw new Error('JPEG Huffman table is missing'); tb.push(t); }
        const sel = d[q + 1 + ns * 2], pt = d[q + 3 + ns * 2] & 15; p = end;
        if (sel < 1 || sel > 7) throw new Error('JPEG predictor ' + sel + ' is not valid');
        return { width: X, height: Y, precision: P, components: ns, data: scan(tb, sel, pt) };
      }
      p = end;
    }

    function scan(tb, sel, pt) {
      const ns = tb.length, out = new Uint16Array(X * Y * ns), row = X * ns, start = 1 << (P - pt - 1);
      let buf = 0, cnt = 0;                                  // bit reader: `cnt` valid bits at the bottom of `buf`
      const fill = () => {
        while (cnt <= 24) {
          let b = 0;
          if (p < d.length) { b = d[p]; if (b === 0xFF) { if (d[p + 1] === 0) p += 2; else b = 0; } else p++; }   // FF00 is a stuffed FF; a real marker stops the feed
          buf = (buf << 8) | b; cnt += 8;
        }
      };
      let first = true, left = ri;                           // `first`: the line starts a scan or a restart interval
      for (let y = 0, o = 0; y < Y; y++) {
        for (let x = 0; x < X; x++) {
          if (ri && left === 0) {                            // restart marker: drop the bit buffer, step over RSTn, predict from scratch
            buf = 0; cnt = 0; while (p + 1 < d.length && !(d[p] === 0xFF && d[p + 1] >= 0xD0 && d[p + 1] <= 0xD7)) p++; p += 2; left = ri; first = true;
          }
          for (let c = 0; c < ns; c++, o++) {
            fill();
            const e = tb[c][(buf >>> (cnt - 16)) & 0xFFFF], len = e >> 5, s = e & 31; if (!len) throw new Error('JPEG data is damaged');
            cnt -= len;
            let diff = 0;
            if (s === 16) diff = 32768;
            else if (s) { fill(); const v = (buf >>> (cnt - s)) & ((1 << s) - 1); cnt -= s; diff = v < (1 << (s - 1)) ? v - (1 << s) + 1 : v; }
            let pred;
            if (first) pred = x ? out[o - ns] : start;
            else if (!x) pred = out[o - row];
            else {
              const a = out[o - ns], b = out[o - row], cc = out[o - row - ns];
              pred = sel === 1 ? a : sel === 2 ? b : sel === 3 ? cc : sel === 4 ? a + b - cc : sel === 5 ? a + ((b - cc) >> 1) : sel === 6 ? b + ((a - cc) >> 1) : (a + b) >> 1;
            }
            out[o] = (pred + diff) & 0xFFFF;
          }
          if (ri) left--;
        }
        first = false;
      }
      if (pt) for (let i = 0; i < out.length; i++) out[i] <<= pt;
      return out;
    }
  }

  // ---- JPEG 2000 and JPEG-LS: WebAssembly builds of OpenJPEG and CharLS (Cornerstone codec packages, copies in vendor/) ----
  const LIBS = {
    j2k: { base: 'vendor/openjpeg/', file: 'openjpegwasm_decode.js', global: 'OpenJPEGWASM', cls: 'J2KDecoder', name: 'JPEG 2000' },
    jls: { base: 'vendor/charls/', file: 'charlswasm_decode.js', global: 'CharLSWASM', cls: 'JpegLSDecoder', name: 'JPEG-LS' },
  };
  const ready = {};
  const canWasm = () => typeof document !== 'undefined' && typeof WebAssembly === 'object';
  function lib(kind) {
    const L = LIBS[kind];
    if (!ready[kind]) ready[kind] = new Promise((res, rej) => {
      const fail = () => { delete ready[kind]; rej(new Error('could not load the ' + L.name + ' decoder (the vendor folder is missing)')); };
      const go = () => { try { root[L.global]({ locateFile: f => L.base + f }).then(res, fail); } catch (_) { fail(); } };
      if (root[L.global]) return go();
      const s = document.createElement('script'); s.src = L.base + L.file; s.onload = go; s.onerror = fail; document.head.appendChild(s);
    });
    return ready[kind];
  }
  async function wasm(kind, frame) {
    if (!canWasm()) throw new Error(LIBS[kind].name + ' can only be decoded in a browser');
    const mod = await lib(kind), d = new mod[LIBS[kind].cls]();
    try {
      d.getEncodedBuffer(frame.length).set(frame); d.decode();
      const info = d.getFrameInfo(), raw = d.getDecodedBuffer(), bits = info.bitsPerSample, n = info.width * info.height * info.componentCount;
      const copy = raw.slice(0, n * (bits > 8 ? 2 : 1)).buffer;            // the decoder's memory goes away with delete()
      const data = bits <= 8 ? new Uint8Array(copy) : info.isSigned ? new Int16Array(copy) : new Uint16Array(copy);
      const lossy = kind === 'j2k' ? !d.getIsReversible() : d.getNearLossless() > 0;
      return { width: info.width, height: info.height, bits, components: info.componentCount, signed: !!info.isSigned, lossy, data };
    } catch (e) { throw new Error('the ' + LIBS[kind].name + ' image could not be decoded'); }
    finally { d.delete(); }
  }

  root.PacsCodecs = { rle, jpegLossless, wasm, canWasm, LIBS };
})(typeof window !== 'undefined' ? window : globalThis);

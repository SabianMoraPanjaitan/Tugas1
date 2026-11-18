// Check the decoders against files whose true pixels are known.  node tcodec.js <mypacs dir> <pydicom test_files dir> <generated dir>
const fs = require('fs'), [root, pd, gen] = process.argv.slice(2);
require(root + '/codecs.js'); require(root + '/dicomlite.js');
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const px = async f => { const buf = ab(f), t = DicomLite.parse(buf); return { t, px: await DicomLite.decode(buf, t) }; };
const same = (a, b) => { if (a.length !== b.length) return 'length ' + a.length + ' vs ' + b.length; let bad = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) bad++; return bad ? bad + ' of ' + a.length + ' differ' : 'identical (' + a.length + ' values)'; };
let fail = 0; const say = (name, r) => { if (!r.startsWith('identical')) fail++; console.log((r.startsWith('identical') ? 'PASS ' : 'FAIL ') + name + ': ' + r); };
(async () => {
  // 1. RLE, third-party file with an uncompressed twin
  say('RLE  MR_small_RLE vs MR_small', same((await px(pd + '/MR_small_RLE.dcm')).px, (await px(pd + '/MR_small.dcm')).px));
  // 2. Lossless JPEG made by GDCM (third party), 3 x 8-bit, against the uncompressed original
  { const buf = ab(pd + '/SC_rgb_jpeg_gdcm.dcm'), t = DicomLite.parse(buf), dv = new DataView(buf); let p = t.pixelOffset + 8 + dv.getUint32(t.pixelOffset + 4, true);
    const len = dv.getUint32(p + 4, true), j = PacsCodecs.jpegLossless(new Uint8Array(buf, p + 8, len));
    const r = new Uint8Array(ab(gen + '/sc_rgb_ref.bin'));   // the same picture decoded by pydicom from its RLE twin
    say('JPEG lossless (GDCM, RGB 8-bit) vs SC_rgb  [' + j.width + 'x' + j.height + ' x' + j.components + ', ' + j.precision + ' bit]', same(Array.from(j.data), Array.from(r))); }
  // 3. Lossless JPEG, 16-bit signed CT, every predictor, restart markers: against the uncompressed CT_small
  const ct = (await px(pd + '/CT_small.dcm')).px;
  for (const f of ['ll_sv1', 'll_p2', 'll_p3', 'll_p4', 'll_p5', 'll_p6', 'll_p7', 'll_sv1_restart']) say('JPEG lossless 16-bit ' + f + ' vs CT_small', same((await px(gen + '/' + f + '.dcm')).px, ct));
  say('JPEG lossless full-range noise', same((await px(gen + '/noise_ll.dcm')).px, (await px(gen + '/noise_raw.dcm')).px));
  { let mn = Infinity, mx = -Infinity; for (const x of ct) { if (x < mn) mn = x; if (x > mx) mx = x; } console.log('CT_small real values: min', mn, 'max', mx); }
  // 4. Things we refuse must say why
  for (const f of ['JPEG2000.dcm', 'MR_small_jpeg_ls_lossless.dcm', 'JPEG-lossy.dcm', 'SC_rgb_rle.dcm', 'image_dfl.dcm', 'rtdose_rle.dcm', 'examples_ybr_color.dcm']) {
    const buf = ab(pd + '/' + f), t = DicomLite.parse(buf); let msg; try { await DicomLite.decode(buf, t); msg = 'DECODED (unexpected)'; fail++; } catch (e) { msg = e.message; }
    console.log('refuse ' + f.padEnd(32) + ' -> ' + (t.ok ? msg : 'header: ' + t.error));
  }
  console.log(fail ? fail + ' FAILED' : 'all passed'); process.exit(fail ? 1 : 0);
})();

// Engine checks on the new formats.  node tengine.js <mypacs dir> <test dir>
const fs = require('fs'), [root, T] = process.argv.slice(2);
require(root + '/codecs.js'); require(root + '/dicomlite.js'); require(root + '/pacs-engine.js');
const E = PacsEngine; let fail = 0;
const ok = (name, cond, extra) => { if (!cond) fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const series = dir => DicomLite.group(fs.readdirSync(dir).map(f => { const a = ab(dir + '/' + f); return { file: { name: f, arrayBuffer: async () => a }, tags: DicomLite.parse(a) }; }))[0];
(async () => {
  // compressed series must give the very same volume as the uncompressed one
  const raw = await E.fromDicom(series(T + '/ct_raw'));
  for (const k of ['ct_jpegll', 'ct_rle']) {
    const v = await E.fromDicom(series(T + '/' + k)); let bad = 0; for (let i = 0; i < raw.u16.length; i++) if (raw.u16[i] !== v.u16[i]) bad++;
    ok(k + ' volume equals the uncompressed one', !bad && v.u16.length === raw.u16.length && v.unit === 'HU' && v.scale === raw.scale && v.offset === raw.offset, v.dims.join('x') + ', ' + v.meta.compression + ', range ' + v.range.min + '..' + v.range.max + ' HU, differing voxels ' + bad);
  }
  // single image
  const dx = await E.fromDicom(series(T + '/dx')), at = (x, y) => dx.real(dx.u16[y * 80 + x]);
  ok('single image opens flat', dx.meta.flat && dx.dims.join() === '80,60,1', 'dims ' + dx.dims + ' spacing ' + dx.meta.spacing + ' at ' + dx.meta.spacingAt);
  ok('single image: spacing from the detector, columns then rows', dx.meta.spacing[0] === 0.15 && dx.meta.spacing[1] === 0.2 && dx.meta.spacingAt === 'detector' && !dx.meta.uncalibrated);
  ok('single image: unused high bits ignored', at(20, 10) === 4095 && at(1, 0) === 3 && dx.range.max === 4095, 'marker ' + at(20, 10) + ' max ' + dx.range.max);
  ok('single image: MONOCHROME1 is passed on', dx.meta.photometric === 'MONOCHROME1' && dx.unit === '');
  // NIfTI: in every file the marker must land at left = 40-2-10 = 28.. (see below), posterior, superior
  // world box is 40 x 50 x 60 mm. Marker voxel centre in RAS voxels (5, 8, 10). In our axes (left, posterior, superior): x index 19-5 = 14, y index 19-8 = 11, z index 10.
  for (const [f, want, flags] of [['ras_int16.nii', 1000], ['ras_float32.nii.gz', 1000.5], ['ras_uint8_scaled.nii', 1000], ['lps_int16.nii', 1000], ['sra_int16.nii', 1000], ['qform_flipk.nii', 1000], ['nodir.nii', 1000, 'assumed']]) {
    const v = await E.fromNifti(ab(T + '/nii/' + f), f), val = v.real(v.u16[14 + 11 * v.dims[0] + 10 * v.dims[0] * v.dims[1]]);
    let hits = 0; for (let i = 0; i < v.u16.length; i++) if (Math.abs(v.real(v.u16[i]) - want) < 6) hits++;
    const sp = v.meta.spacing.join();
    ok('NIfTI ' + f, Math.abs(val - want) < 6 && hits === 1 && sp === '2,2.5,3' && v.dims.join() === '20,20,20' && !!v.meta.orientationAssumed === (flags === 'assumed') && !v.meta.tilted,
      'marker ' + val.toFixed(1) + ' (want ' + want + '), found ' + hits + ' time(s), spacing ' + sp + ', range ' + v.range.min.toFixed(1) + '..' + v.range.max.toFixed(1) + (v.meta.orientationAssumed ? ', directions assumed' : ''));
    if (f === 'ras_int16.nii') {
      ok('NIfTI has no unit until told', v.unit === '' && E.presets(v)[0].name !== 'Soft tissue');
      E.setModality(v, 'CT'); ok('NIfTI marked as CT reads HU', v.unit === 'HU' && E.presets(v)[0].name === 'Soft tissue' && v.range.min === -1000, 'range ' + v.range.min + '..' + v.range.max + ' HU');
      E.setModality(v, ''); ok('NIfTI unmarked again', v.unit === '');
      const p = E.pack3d(v); ok('NIfTI volume packs for the 3D pane', p && p.mask && p.mask.length === v.u16.length);
    }
  }
  for (const [name, buf] of [['random bytes', new Uint8Array(4000).map((_, i) => i * 7).buffer], ['too short', new ArrayBuffer(10)]]) { let m = ''; try { await E.fromNifti(buf, 'x.nii'); } catch (e) { m = e.message; } ok('NIfTI refuses ' + name, !!m, m); }
  console.log(fail ? fail + ' FAILED' : 'all passed'); process.exit(fail ? 1 : 0);
})();

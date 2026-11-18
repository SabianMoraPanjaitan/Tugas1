"""Turn one DICOM series (a folder of slices) into a volume the MyPACS 3D page can load.

    python dicom2vol.py <series folder> <out folder> [--id name] [--label "T2 3T"]

Writes into <out folder>/<id>/:
    vol.u16.gz   raw voxel values, uint16 little-endian, patient axes: x = left, y = posterior, z = superior (x fastest)
    mask.u8.gz   filled, smoothed body mask (0..255), same layout: gives a clean skin surface and solid cut faces
    meta.json    size, spacing in mm, origin, value range, measured extent, and the DICOM tags shown in the app

Every number comes from the files. Nothing is guessed; a tag that is missing or blank stays blank.
Needs: pydicom, numpy, scipy.
"""
import argparse, glob, gzip, json, os, sys
import numpy as np
import pydicom
from scipy import ndimage as ndi

TAGS = [  # (section, label, keyword, unit)
    ('Patient', 'Name', 'PatientName', ''), ('Patient', 'ID', 'PatientID', ''), ('Patient', 'Sex', 'PatientSex', ''),
    ('Patient', 'Birth date', 'PatientBirthDate', ''), ('Patient', 'Position', 'PatientPosition', ''),
    ('Study', 'Modality', 'Modality', ''), ('Study', 'Body part', 'BodyPartExamined', ''), ('Study', 'Study date', 'StudyDate', ''),
    ('Study', 'Description', 'StudyDescription', ''), ('Study', 'Series', 'SeriesDescription', ''), ('Study', 'Institution', 'InstitutionName', ''),
    ('Scanner', 'Manufacturer', 'Manufacturer', ''), ('Scanner', 'Model', 'ManufacturerModelName', ''), ('Scanner', 'Field strength', 'MagneticFieldStrength', 'T'),
    ('Sequence', 'Sequence', 'SequenceName', ''), ('Sequence', 'Scanning sequence', 'ScanningSequence', ''), ('Sequence', 'Acquisition', 'MRAcquisitionType', ''),
    ('Sequence', 'Repetition time', 'RepetitionTime', 'ms'), ('Sequence', 'Echo time', 'EchoTime', 'ms'), ('Sequence', 'Flip angle', 'FlipAngle', '°'),
    ('Image', 'Rows × columns', None, ''), ('Image', 'Pixel spacing', 'PixelSpacing', 'mm'), ('Image', 'Slice thickness', 'SliceThickness', 'mm'),
    ('Image', 'Bits stored', 'BitsStored', ''), ('Image', 'Photometric', 'PhotometricInterpretation', ''),
    ('Image', 'Window centre', 'WindowCenter', ''), ('Image', 'Window width', 'WindowWidth', ''),
    ('Image', 'Transfer syntax', None, ''), ('Image', 'Series UID', 'SeriesInstanceUID', ''),
]


def num(v):
    f = float(v)
    return int(f) if f == int(f) else round(f, 4)


def show(v):
    if v is None: return ''
    if isinstance(v, (pydicom.multival.MultiValue, list, tuple)): return ' \\ '.join(show(x) for x in v)
    s = str(v).strip()
    try: return str(num(s))
    except ValueError: return s


def otsu(a):
    h, e = np.histogram(a, 256)
    p = h / h.sum(); w = np.cumsum(p); m = np.cumsum(p * np.arange(256)); mt = m[-1]
    var = (mt * w - m) ** 2 / (w * (1 - w) + 1e-12)
    return float(e[int(np.argmax(var)) + 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('out'); ap.add_argument('--id'); ap.add_argument('--label'); ap.add_argument('--credit', default='')
    a = ap.parse_args()
    files = [f for f in glob.glob(os.path.join(a.src, '*')) if os.path.isfile(f)]
    dss = []
    for f in files:
        try: dss.append(pydicom.dcmread(f))
        except Exception: pass
    dss = [d for d in dss if 'PixelData' in d]
    if not dss: sys.exit('no DICOM slices in ' + a.src)
    if len({d.SeriesInstanceUID for d in dss}) != 1: sys.exit('more than one series in the folder')
    d0 = dss[0]
    iop = np.array(d0.ImageOrientationPatient, float); r, c = iop[:3], iop[3:]; n = np.cross(r, c)
    for v in (r, c):
        if np.sort(np.abs(v))[1] > 1e-3: sys.exit('oblique series: needs resampling, not supported yet')
    dss.sort(key=lambda d: float(np.dot(n, np.array(d.ImagePositionPatient, float))))
    pos = np.array([np.dot(n, np.array(d.ImagePositionPatient, float)) for d in dss])
    dz = np.diff(pos)
    if dz.max() - dz.min() > 0.01: sys.exit('slices are not evenly spaced')
    ps = [float(x) for x in d0.PixelSpacing]                       # [between rows, between columns]
    # real values: every slice has its own rescale (PET slices differ; CT gives Hounsfield units this way)
    vol = np.stack([d.pixel_array.astype(np.float32) * float(d.get('RescaleSlope', 1) or 1) + float(d.get('RescaleIntercept', 0) or 0) for d in dss])  # [slice, row, column]

    # array axis -> patient axis (0 = left, 1 = posterior, 2 = superior) and direction
    dirs, steps = [n, c, r], [float(dz.mean()), ps[0], ps[1]]
    ax = [int(np.argmax(np.abs(v))) for v in dirs]
    sg = [float(np.sign(v[i])) for v, i in zip(dirs, ax)]
    if sorted(ax) != [0, 1, 2]: sys.exit('could not work out the slice orientation')
    for k in range(3):
        if sg[k] < 0: vol = np.flip(vol, k)
    vol = np.ascontiguousarray(np.transpose(vol, [ax.index(2), ax.index(1), ax.index(0)]))   # [z, y, x]
    sp = [steps[ax.index(0)], steps[ax.index(1)], steps[ax.index(2)]]                          # mm along x, y, z
    nz, ny, nx = vol.shape
    # patient position of voxel (0, 0, 0): the smallest coordinate on every axis
    corners = []
    for d in (dss[0], dss[-1]):
        p = np.array(d.ImagePositionPatient, float)
        for i in (0, d.Rows - 1):
            for j in (0, d.Columns - 1): corners.append(p + i * ps[0] * c + j * ps[1] * r)
    origin = np.min(corners, axis=0)

    # stored as uint16: real value = stored * scale + offset
    real_min, real_max = float(vol.min()), float(vol.max())
    offset = real_min if real_min < 0 else 0.0
    whole = bool(np.all(vol == np.rint(vol))) and real_max - offset <= 65535
    scale = 1.0 if whole else (real_max - offset) / 65535.0
    vol = (vol - offset) / scale
    modality = show(d0.get('Modality'))
    unit = 'HU' if modality == 'CT' else show(d0.get('Units')) if modality == 'PT' else ''
    pet = None
    if modality == 'PT':                 # what the viewer needs to turn Bq/ml into SUV; blank stays blank
        rp = d0.get('RadiopharmaceuticalInformationSequence'); rp = rp[0] if rp else {}
        f = lambda v: float(v) if v not in (None, '') else None
        pet = {'units': show(d0.get('Units')), 'decayCorrection': show(d0.get('DecayCorrection')), 'weightKg': f(d0.get('PatientWeight')),
               'doseBq': f(rp.get('RadionuclideTotalDose')), 'halfLifeS': f(rp.get('RadionuclideHalfLife')),
               'startTime': str(rp.get('RadiopharmaceuticalStartTime') or ''), 'seriesTime': str(d0.get('SeriesTime') or ''), 'acquisitionTime': str(d0.get('AcquisitionTime') or '')}
    hi = float(np.percentile(vol, 99.9))
    sm = ndi.gaussian_filter(vol, 1.0)
    thr = otsu(sm[sm > 0]) * 0.55        # Otsu splits tissue from tissue in MR; a bit over half of it splits air from body
    body = sm > thr
    body = ndi.binary_closing(body, iterations=2)
    for axis in range(3):                # fill holes slice by slice in all three directions (the neck is open, so 3D fill would miss)
        body = np.moveaxis(np.stack([ndi.binary_fill_holes(s) for s in np.moveaxis(body, axis, 0)]), 0, axis)
    body = ndi.binary_opening(body, iterations=2)
    lab, cnt = ndi.label(body)
    if cnt > 1: body = lab == (1 + int(np.argmax(ndi.sum(body, lab, range(1, cnt + 1)))))
    mask = np.clip(ndi.gaussian_filter(body.astype(np.float32), 1.0) * 255, 0, 255).astype(np.uint8)
    zz, yy, xx = np.nonzero(body)
    box = [[int(xx.min()), int(xx.max())], [int(yy.min()), int(yy.max())], [int(zz.min()), int(zz.max())]]
    extent = [round((b[1] - b[0] + 1) * s, 1) for b, s in zip(box, sp)]

    sid = a.id or os.path.basename(os.path.normpath(a.src))
    out = os.path.join(a.out, sid); os.makedirs(out, exist_ok=True)
    with gzip.open(os.path.join(out, 'vol.u16.gz'), 'wb', 6) as f: f.write(np.clip(np.rint(vol), 0, 65535).astype('<u2').tobytes())
    with gzip.open(os.path.join(out, 'mask.u8.gz'), 'wb', 6) as f: f.write(mask.tobytes())

    tags = []
    for sec, label, key, tunit in TAGS:
        if label == 'Rows × columns': val = f'{d0.Rows} × {d0.Columns}'
        elif label == 'Transfer syntax': val = str(d0.file_meta.TransferSyntaxUID.name)
        else: val = show(d0.get(key))
        tags.append([sec, label, val, tunit if val else ''])
    tags.append(['Image', 'Slices', str(len(dss)), ''])
    meta = {
        'id': sid, 'label': a.label or sid, 'modality': modality, 'unit': unit, 'rescale': {'scale': scale, 'offset': offset}, 'pet': pet,
        'synthetic': 'PHANTOM' in show(d0.get('BodyPartExamined')).upper(), 'bodyPart': show(d0.get('BodyPartExamined')),
        'dims': [nx, ny, nz], 'spacing': [round(s, 4) for s in sp], 'origin': [round(float(o), 2) for o in origin],
        'axes': 'x = patient left, y = posterior, z = superior',
        'max': int(vol.max()), 'hi': round(hi, 1), 'iso': round(thr, 1),
        'windowCenter': num(d0.WindowCenter) if d0.get('WindowCenter') not in (None, '') else None,
        'windowWidth': num(d0.WindowWidth) if d0.get('WindowWidth') not in (None, '') else None,
        'bodyBox': box, 'bodyExtentMm': extent, 'tags': tags,
        'credit': a.credit,
    }
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    idx = os.path.join(a.out, 'index.json'); ids = json.load(open(idx)) if os.path.exists(idx) else []
    if sid not in ids: ids.append(sid); json.dump(ids, open(idx, 'w'))
    print(sid, 'dims', meta['dims'], 'spacing', meta['spacing'], 'extent mm', extent, 'hi', hi, 'iso', thr,
          'size', {f: os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)})


if __name__ == '__main__':
    main()

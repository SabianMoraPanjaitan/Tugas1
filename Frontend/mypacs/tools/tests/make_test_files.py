# Test files for the engine: a compressed copy of the CT phantom series, a single X-ray-like image, and NIfTI files with known directions.
import sys, os, glob, copy, gzip, struct, warnings, importlib.util
import numpy as np, pydicom
from pydicom.encaps import encapsulate
from pydicom.uid import JPEGLosslessSV1, RLELossless, ExplicitVRLittleEndian
warnings.simplefilter('ignore')
root, out = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location('mkll', os.path.join(os.path.dirname(__file__), 'mkll_enc.py')); enc = importlib.util.module_from_spec(spec); spec.loader.exec_module(enc)

# 1. CT phantom, first 12 slices: lossless JPEG and RLE copies
src = sorted(glob.glob(root + '/data/_phantom_dicom/CT_phantom/*'))[:12]
for name in ('ct_raw', 'ct_jpegll', 'ct_rle'): os.makedirs(out + '/' + name, exist_ok=True)
for f in src:
    ds = pydicom.dcmread(f); b = os.path.basename(f)
    ds.save_as(out + '/ct_raw/' + b)
    a = np.frombuffer(ds.PixelData, dtype='<u2').reshape(ds.Rows, ds.Columns).astype(np.int64)
    d = copy.deepcopy(ds); d.file_meta.TransferSyntaxUID = JPEGLosslessSV1; d.PixelData = encapsulate([enc.encode(a, 1)]); d['PixelData'].is_undefined_length = True; d.save_as(out + '/ct_jpegll/' + b)
    d = copy.deepcopy(ds); d.compress(RLELossless); d.save_as(out + '/ct_rle/' + b)
print('ct series', len(src), 'signed' if ds.PixelRepresentation else 'unsigned', ds.Rows, ds.Columns)

# 2. One image, no position: 12 bits stored, MONOCHROME1, detector spacing only (like a DX)
ds = pydicom.dcmread(src[0]); H, W = 60, 80
img = (np.arange(H * W).reshape(H, W) * 3 % 4096).astype('<u2'); img[10, 20] = 4095
for k in ('ImagePositionPatient', 'ImageOrientationPatient', 'PixelSpacing', 'RescaleSlope', 'RescaleIntercept', 'SliceThickness', 'WindowCenter', 'WindowWidth'):
    if k in ds: del ds[k]
ds.Modality = 'DX'; ds.Rows, ds.Columns = H, W; ds.BitsAllocated = 16; ds.BitsStored = 12; ds.HighBit = 11; ds.PixelRepresentation = 0
ds.PhotometricInterpretation = 'MONOCHROME1'; ds.ImagerPixelSpacing = [0.2, 0.15]; ds.SeriesInstanceUID = pydicom.uid.generate_uid()
ds.PixelData = (img | 0xF000).astype('<u2').tobytes()      # junk in the unused high bits: must be ignored
os.makedirs(out + '/dx', exist_ok=True); ds.save_as(out + '/dx/dx.dcm'); print('dx written')

# 3. NIfTI: a box with one marker voxel at a known place. World (RAS) position of the marker: right 10, anterior 20, superior 30 mm from the corner voxel.
def nifti(path, data, affine, dtype, code, slope=0.0, inter=0.0, sform=True, gz=False, quat=None):
    h = bytearray(352); n = data.shape
    struct.pack_into('<i', h, 0, 348); struct.pack_into('<8h', h, 40, 3, n[0], n[1], n[2], 1, 1, 1, 1)
    struct.pack_into('<h', h, 70, code); struct.pack_into('<h', h, 72, np.dtype(dtype).itemsize * 8)
    sp = [float(np.linalg.norm(affine[:3, i])) for i in range(3)]
    struct.pack_into('<8f', h, 76, quat[0] if quat else 1.0, sp[0], sp[1], sp[2], 1, 1, 1, 1)
    struct.pack_into('<f', h, 108, 352.0); struct.pack_into('<2f', h, 112, slope, inter)
    if sform:
        struct.pack_into('<h', h, 254, 1)
        for r in range(3): struct.pack_into('<4f', h, 280 + r * 16, *[float(x) for x in affine[r]])
    elif quat:
        struct.pack_into('<h', h, 252, 1); struct.pack_into('<3f', h, 256, *quat[1:])
    h[344:348] = b'n+1\0'
    raw = bytes(h) + np.asarray(data, dtype=dtype).tobytes(order='F')
    open(path, 'wb').write(gzip.compress(raw) if gz else raw)
os.makedirs(out + '/nii', exist_ok=True)
# world box: 40 x 50 x 60 mm, spacing 2 x 2.5 x 3 -> 20 x 20 x 20 voxels in RAS order
def world(val=1000.0):
    w = np.zeros((20, 20, 20), dtype=np.float64); w[:] = -1000.0; w[2:18, 2:18, 2:18] = 40.0; w[5, 8, 10] = val; return w    # marker at R=5*2, A=8*2.5, S=10*3
W_ = world(); aff = np.diag([2, 2.5, 3, 1]).astype(float)
nifti(out + '/nii/ras_int16.nii', W_, aff, '<i2', 4)
nifti(out + '/nii/ras_float32.nii.gz', W_ + 0.5, aff, '<f4', 16, gz=True)
nifti(out + '/nii/ras_uint8_scaled.nii', (W_ + 1000) / 10, aff, 'u1', 2, slope=10.0, inter=-1000.0)
# LPS-ordered file: voxel i runs to the left, j to the back
lps = W_[::-1, ::-1, :]; a2 = np.array([[-2, 0, 0, 38], [0, -2.5, 0, 47.5], [0, 0, 3, 0], [0, 0, 0, 1]], float)
nifti(out + '/nii/lps_int16.nii', lps, a2, '<i2', 4)
# axes swapped: voxel i = superior, j = right, k = anterior
perm = np.transpose(W_, (2, 0, 1)); a3 = np.array([[0, 2, 0, 0], [0, 0, 2.5, 0], [3, 0, 0, 0], [0, 0, 0, 1]], float)
nifti(out + '/nii/sra_int16.nii', perm, a3, '<i2', 4)
# no sform: qform with identity rotation and qfac -1 (k runs downwards)
nifti(out + '/nii/qform_flipk.nii', W_[:, :, ::-1], aff, '<i2', 4, sform=False, quat=(-1.0, 0.0, 0.0, 0.0))
# nothing at all about directions
nifti(out + '/nii/nodir.nii', W_, aff, '<i2', 4, sform=False)
print('nifti written')

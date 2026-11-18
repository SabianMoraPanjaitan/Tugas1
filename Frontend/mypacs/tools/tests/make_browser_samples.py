# Serve pydicom's JPEG 2000 / JPEG-LS samples for the browser check, with reference pixels from an independent decoder (Pillow) where it can read them.
import sys, os, io, shutil, json, warnings
import numpy as np, pydicom
from pydicom.encaps import generate_frames
from PIL import Image
warnings.simplefilter('ignore')
served = sys.argv[1]; os.makedirs(served, exist_ok=True)
pd = os.path.join(os.path.dirname(pydicom.__file__), 'data', 'test_files'); info = {}
for f in ['MR_small.dcm', 'MR_small_jp2klossless.dcm', 'MR_small_jpeg_ls_lossless.dcm', 'JPEG2000.dcm', '693_J2KI.dcm', 'J2K_pixelrep_mismatch.dcm', 'JPEGLSNearLossless_16.dcm', 'JPEGLSNearLossless_08.dcm']:
    shutil.copy(os.path.join(pd, f), served + '/' + f)
    ds = pydicom.dcmread(os.path.join(pd, f)); e = {'syntax': ds.file_meta.TransferSyntaxUID.name, 'signed': int(ds.PixelRepresentation), 'stored': int(ds.BitsStored), 'slope': float(ds.get('RescaleSlope', 1)), 'inter': float(ds.get('RescaleIntercept', 0))}
    if 'JPEG 2000' in e['syntax']:
        try:
            frame = next(generate_frames(ds.PixelData, number_of_frames=1)); im = Image.open(io.BytesIO(frame)); a = np.array(im)
            e['pil'] = {'mode': im.mode, 'shape': list(a.shape), 'min': int(a.min()), 'max': int(a.max())}
            open(served + '/' + f + '.ref', 'wb').write(a.astype('<i4').tobytes())
        except Exception as ex: e['pil_error'] = str(ex)[:100]
    info[f] = e
json.dump(info, open(served + '/info.json', 'w')); print(json.dumps(info, indent=1))

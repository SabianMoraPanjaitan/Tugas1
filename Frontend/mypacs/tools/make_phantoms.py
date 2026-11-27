"""Writes two SYNTHETIC DICOM series for testing the viewer: a CT phantom with known Hounsfield values and a PET
phantom with known activity, so HU and SUV read-outs can be checked against numbers we chose. Not patient data.

    python make_phantoms.py <out folder>      -> <out>/CT_phantom/*.dcm and <out>/PET_phantom/*.dcm
"""
import os, sys
import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

CT_STORAGE, PET_STORAGE = '1.2.840.10008.5.1.4.1.1.2', '1.2.840.10008.5.1.4.1.1.128'


def base(sop_class, modality, desc, rows, cols, spacing, thick, study, series, i, z, x0, y0):
    meta = FileMetaDataset(); meta.MediaStorageSOPClassUID = sop_class; meta.MediaStorageSOPInstanceUID = generate_uid(); meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset('', {}, file_meta=meta, preamble=b'\0' * 128)
    ds.SOPClassUID, ds.SOPInstanceUID = sop_class, meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
    ds.Modality, ds.BodyPartExamined = modality, 'PHANTOM'
    ds.StudyDescription, ds.SeriesDescription = 'Synthetic phantom (not a patient)', desc
    ds.PatientName, ds.PatientID, ds.PatientBirthDate, ds.PatientSex = '', '', '', ''
    ds.StudyDate, ds.SeriesDate, ds.SeriesTime, ds.AcquisitionTime = '20261114', '20261114', '110000', '110000'
    ds.Manufacturer, ds.PatientPosition = 'MyPACS test generator', 'HFS'
    ds.InstanceNumber = i + 1
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]; ds.ImagePositionPatient = [x0, y0, z]
    ds.Rows, ds.Columns, ds.PixelSpacing, ds.SliceThickness = rows, cols, [spacing, spacing], thick
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 0
    return ds


def ct(out):
    n, nz, sp, th = 192, 72, 1.5, 2.5
    y, x = np.mgrid[0:n, 0:n]; cx = cy = (n - 1) / 2
    X, Y = (x - cx) * sp, (y - cy) * sp                       # mm, +x = patient left, +y = posterior
    study, series = generate_uid(), generate_uid(); os.makedirs(out, exist_ok=True)
    for k in range(nz):
        z = (k - (nz - 1) / 2) * th
        hu = np.full((n, n), -1000.0)                          # air
        hu[(X / 125) ** 2 + (Y / 95) ** 2 <= 1] = -100         # fat rim
        hu[(X / 117) ** 2 + (Y / 87) ** 2 <= 1] = 40           # soft tissue
        for sx in (-55, 55): hu[((X - sx) / 38) ** 2 + ((Y + 8) / 52) ** 2 + (z / 75) ** 2 <= 1] = -850   # lungs
        hu[(X ** 2 + (Y - 55) ** 2 <= 16 ** 2)] = 700          # spine
        hu[(X ** 2 + (Y - 55) ** 2 <= 6 ** 2)] = 30            # canal
        hu[((X - 60) ** 2 + (Y - 5) ** 2 + (z - 20) ** 2 <= 12 ** 2)] = 90    # nodule in the left lung, 24 mm across
        hu[((X + 20) ** 2 + (Y + 45) ** 2 <= 14 ** 2)] = 0     # water rod
        hu[((X - 25) ** 2 + (Y + 45) ** 2 <= 10 ** 2)] = 300   # contrast rod
        ds = base(CT_STORAGE, 'CT', 'CT phantom, known HU', n, n, sp, th, study, series, k, z, -cx * sp, -cy * sp)
        ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1024, 1, 'HU'
        ds.WindowCenter, ds.WindowWidth, ds.KVP = 40, 400, 120
        ds.PixelData = (hu + 1024).astype('<u2').tobytes()
        ds.save_as(os.path.join(out, f'CT_{k + 1:03d}.dcm'), enforce_file_format=True)


def pet(out):
    n, nz, sp = 128, 64, 4.0
    y, x = np.mgrid[0:n, 0:n]; cx = cy = (n - 1) / 2
    X, Y = (x - cx) * sp, (y - cy) * sp
    study, series = generate_uid(), generate_uid(); os.makedirs(out, exist_ok=True)
    for k in range(nz):
        z = (k - (nz - 1) / 2) * sp
        a = np.zeros((n, n))
        a[(X / 150) ** 2 + (Y / 110) ** 2 <= 1] = 5000         # background, Bq/ml
        a[((X - 60) ** 2 + (Y + 20) ** 2 + (z - 24) ** 2 <= 16 ** 2)] = 40000   # hot sphere, 32 mm
        a[((X + 70) ** 2 + (Y - 10) ** 2 + (z + 30) ** 2 <= 12 ** 2)] = 20000   # warm sphere, 24 mm
        a[((X) ** 2 + (Y - 60) ** 2 <= 14 ** 2)] = 500         # cold rod
        slope = max(a.max(), 1) / 32767.0                      # each slice has its own slope, as real PET does
        ds = base(PET_STORAGE, 'PT', 'PET phantom, known activity', n, n, sp, sp, study, series, k, z, -cx * sp, -cy * sp)
        ds.RescaleIntercept, ds.RescaleSlope = 0, slope
        ds.Units, ds.DecayCorrection, ds.CorrectedImage = 'BQML', 'START', ['DECY', 'ATTN']
        ds.PatientWeight = 70
        rp = pydicom.Dataset(); rp.RadionuclideTotalDose = 370000000; rp.RadionuclideHalfLife = 6586.2; rp.RadiopharmaceuticalStartTime = '100000'
        ds.RadiopharmaceuticalInformationSequence = [rp]
        ds.PixelData = np.rint(a / slope).astype('<u2').tobytes()
        ds.save_as(os.path.join(out, f'PET_{k + 1:03d}.dcm'), enforce_file_format=True)


if __name__ == '__main__':
    root = sys.argv[1]
    ct(os.path.join(root, 'CT_phantom')); pet(os.path.join(root, 'PET_phantom')); print('written to', root)

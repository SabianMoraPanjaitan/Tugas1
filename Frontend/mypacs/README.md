# MyPACS (prototype)

New PACS / Radiology front end, built from the MyPACS Figma design. Plain HTML/CSS/JS, no build.

- Run the backend as usual (`cd Backend`, `uvicorn main:app --port 8000`), then open
  http://localhost:8000/mypacs/home.html (worklist) or http://localhost:8000/mypacs/viewer.html (viewer).
- Data: for now the pages use demo data kept in the browser (`mockstore.js`). Wiring them to the
  backend API happens on this branch, page by page.
- Viewer engine (no page code): `pacs-engine.js` (volumes, slices, windowing, HU, SUV, ROI),
  `dicomlite.js` (DICOM reader), `codecs.js` (RLE, JPEG lossless, JPEG 2000, JPEG-LS). Tests: `tools/tests/`.
- Sample series in `data/` are synthetic phantoms made by `tools/make_phantoms.py`. No patient data.
- Outside libraries and fonts are local copies in `vendor/` (see `vendor/README.md`), so it runs offline.
- UI text is still English.

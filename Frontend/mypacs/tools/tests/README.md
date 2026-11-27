# Engine tests

Checks for `codecs.js`, `dicomlite.js` and `pacs-engine.js`. They run in Node, no browser.
Test files are generated into a folder you choose (keep it outside the project). Needs Python with `pydicom` and `numpy`.

    python make_jpeg_lossless.py <out>/ll
    python make_test_files.py <mypacs folder> <out>/t
    node test_codecs.js <mypacs folder> <pydicom test_files folder> <out>/ll
    node test_engine.js <mypacs folder> <out>/t

`test_codecs.js` also needs `<out>/ll/sc_rgb_ref.bin`: the pixels of pydicom's `SC_rgb_rle.dcm` as decoded by pydicom (`ds.pixel_array.tobytes()`).
Any change to the engine must leave both scripts printing "all passed".

JPEG 2000 and JPEG-LS use outside WebAssembly decoders (OpenJPEG, CharLS) that only run in a browser, so Node cannot test them.
To check them: `python make_browser_samples.py <mypacs folder>/data/_tmp_test`, open the viewer from the local server, and in the console
decode each file with `DicomLite.decode` and compare `MR_small_jp2klossless.dcm` and `MR_small_jpeg_ls_lossless.dcm` with `MR_small.dcm`
(they must be identical). Delete `data/_tmp_test` afterwards.

`test_backend_routes.py` checks the backend routes MyPACS added (unit on a request, send back, draft reading).
Start the backend first (MOCK mode, port 8000), then `python test_backend_routes.py <repo folder>`. It must print
"all passed". It leaves a few test requests and studies in `Backend/data`, which is not committed.

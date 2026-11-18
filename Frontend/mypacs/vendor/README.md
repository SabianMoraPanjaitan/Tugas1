# Outside libraries

Copies kept here so the viewer works with no internet. Not our code: do not edit.

| Folder | What | Package and version | Licence | Got from |
|---|---|---|---|---|
| `openjpeg/` | JPEG 2000 decoder (OpenJPEG, WebAssembly) | `@cornerstonejs/codec-openjpeg` 1.3.6 | MIT (wrapper); OpenJPEG itself is BSD 2-clause | cdn.jsdelivr.net/npm/@cornerstonejs/codec-openjpeg@1.3.6/dist/ |
| `charls/` | JPEG-LS decoder (CharLS, WebAssembly) | `@cornerstonejs/codec-charls` 1.2.7 | MIT (wrapper); CharLS itself is BSD 3-clause | cdn.jsdelivr.net/npm/@cornerstonejs/codec-charls@1.2.7/dist/ |
| `fonts/` | Google Sans Flex (weights 200 to 700) and Google Sans Code (400, 600), woff2 | Google Fonts, fetched 2026-11-14 | SIL Open Font License 1.1 | fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@200..700&family=Google+Sans+Code:wght@400;600 |

Only the decode-only builds are kept (`*_decode.js` and `*_decode.wasm`). `codecs.js` loads them the first time a file needs them.
Fonts: only the latin, latin-ext, math and symbols subsets are kept. Other scripts fall back to the system font.

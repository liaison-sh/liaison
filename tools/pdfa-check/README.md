# tools/pdfa-check — test-only PDF/A smoke check

`pdfa-check` wraps oxidize-pdf's `PdfAValidator` (crate `oxidize-pdf` 5.4.2, MIT, pinned in
`Cargo.toml`/`Cargo.lock`). It is built with `cargo build --release` by the conformance test on first
use and is never part of a runtime image. No Java is involved.

    tools/pdfa-check/target/release/pdfa-check [--level 3b] file.pdf ...   # one JSON line per file

`calibrate.ts` measures it against the veraPDF corpus (`PDF_A-2b/`, `PDF_A-3b/`):

    bun tools/pdfa-check/calibrate.ts <veraPDF-corpus checkout> <report.md>

## What calibration showed (oxidize-pdf 5.4.2, veraPDF-corpus @ bb75f4f, 2026-10-15)

- It reads `pdfaid:part` only in XMP element form; every corpus file uses the attribute form, so it
  rejects 374 of 377 PDF_A-2b pass files and 3 of 7 PDF_A-3b pass files with
  `XmpMissingPdfAIdentifier` (a false alarm; our renderer writes the element form).
- Leaving that artefact aside, it flags 15 of 609 PDF_A-2b fail files for a real reason (clauses
  6.1.2, 6.1.3, 6.2.4.3, 6.2.11, 6.4.2, 6.5.2, 6.6.2) and 0 of 5 PDF_A-3b (6.8 embedded files)
  fail files.

So it is a smoke check (encryption, JavaScript, missing XMP id, unembedded fonts, missing
OutputIntent), never evidence of ISO 19005-3 conformance. The structural rules a Factur-X depends on
are asserted separately (`apps/api/test-support/pdfa/structural-asserts.ts`, one mutation each in
`apps/api/src/modules/pdf/pdfa/pdfa-conformance.test.ts`). Full PDF/A-3 conformance is not
independently proven.

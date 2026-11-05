# tools/schematron — test-only Factur-X XML validator

Validates a Factur-X `factur-x.xml` (UN/CEFACT CII D22B, profile EN 16931) without Java:

| Step | Engine | Rules (vendored, unmodified) | Source | Licence |
|---|---|---|---|---|
| XSD | `xmllint --schema` (libxml2) | `xsd/facturx-1.09.2-en16931/Factur-X_EN16931.xsd` (+ 3 imports) | FNFE-MPE France_RFE `v1.4.0.04`, `FNFE_RFE_INVOICE/Factur-X/EN16931/1xsd/` | Apache-2.0 (`rules/fnfe-france-rfe-1.4.0.04/LICENSE`) |
| EN 16931 | SaxonJS | `rules/cen-en16931-cii-1.3.17/EN16931-CII-validation.xslt` | ConnectingEurope/eInvoicing-EN16931 release `validation-1.3.17`, `en16931-cii-1.3.17.zip` `xslt/` | EUPL-1.2 (`LICENSE.txt`) |
| Factur-X | SaxonJS | `rules/fnfe-france-rfe-1.4.0.04/FACTUR-X_EN16931.xslt` + `FACTUR-X_EN16931_codedb.xml` | France_RFE `v1.4.0.04`, `Factur-X/EN16931/2xslt/` (Factur-X 1.09.2) | Apache-2.0 |
| French rules | SaxonJS | `rules/fnfe-france-rfe-1.4.0.04/BR-FR-Flux2-Schematron-CII.xslt` (fatal variant) | France_RFE `v1.4.0.04`, `Factur-X/EN16931/2xslt/` | Apache-2.0 |

`fixtures/fnfe-uc1-en16931.xml` is the official FNFE example `UC1_F202500003_00-INV_20250701_EN16931_FX_CII_Commentee.xml`
(Apache-2.0), used as the known-good input.

SaxonJS comes from the exact-pinned root devDependency `xslt3@2.7.0` (its `saxon-js` engine, Saxonica's
SaxonJS licence: free to use and redistribute, not open source). The `xslt3` CLI compiles each XSLT to a
SEF on first use into `.sef/` (git-ignored, keyed by the XSLT's content hash). Nothing here is shipped in
a runtime image or imported by product code.

Pass rule: XSD valid and no `svrl:failed-assert` whose `flag` is absent or anything but `warning`.

Updating: replace the files from a newer release, keep the directory name in step with the version, and
re-run `tools/schematron/validate.test.ts` plus the invoicing conformance suite.

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every algorithm constant of the seal and its timestamp, pinned. A failure
// here means someone changed a signing constant: that is a new seal version
// the owner reviews, never an edit to make this test pass.
import { describe, expect, it } from "bun:test"
import * as constants from "~/modules/signing/constants"

const PINNED: Record<string, unknown> = {
  SEAL_HASH_ALG: "sha256",
  SEAL_VERSION: 1,
  SEAL_MANIFEST_FIELDS: [
    "v",
    "hash",
    "document_sha256",
    "signed_pdf_sha256",
    "trail_sha256",
    "level",
    "agreement",
    "version",
  ],
  OID_SHA256: "2.16.840.1.101.3.4.2.1",
  OID_CT_TSTINFO: "1.2.840.113549.1.9.16.1.4",
  OID_SIGNED_DATA: "1.2.840.113549.1.7.2",
  OID_KP_TIMESTAMPING: "1.3.6.1.5.5.7.3.8",
  OID_EXT_KEY_USAGE: "2.5.29.37",
  OID_ATTR_CONTENT_TYPE: "1.2.840.113549.1.9.3",
  OID_ATTR_MESSAGE_DIGEST: "1.2.840.113549.1.9.4",
  OID_ATTR_SIGNING_CERTIFICATE: "1.2.840.113549.1.9.16.2.12",
  OID_ATTR_SIGNING_CERTIFICATE_V2: "1.2.840.113549.1.9.16.2.47",
  TSP_REQUEST_VERSION: 1,
  TSP_NONCE_BYTES: 8,
  TSP_CERT_REQ: true,
  TSP_REQ_POLICY: null,
  TSP_QUERY_CONTENT_TYPE: "application/timestamp-query",
  TSP_REPLY_CONTENT_TYPE: "application/timestamp-reply",
  TSP_TIMEOUT_MS: 10_000,
  TSP_MAX_CLOCK_SKEW_MS: 300_000,
  TSP_ACCEPTED_STATUSES: [0, 1],
  TSP_MAX_REPLY_BYTES: 65_536,
  EVIDENCE_ZIP_ENTRIES: {
    signedPdf: "signed.pdf",
    frozenPdf: "document.pdf",
    trail: "trail.json",
    manifest: "manifest.json",
    timestampToken: "timestamp.tsr",
    certificatePdf: "certificate.pdf",
    checkHtml: "check.html",
  },
}

describe("signing constants", () => {
  it("every signing constant is pinned", () => {
    const actual: Record<string, unknown> = { ...constants }
    expect(actual).toEqual(PINNED)
  })
})

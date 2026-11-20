// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every algorithm choice of the agreement seal and its RFC 3161 timestamp, in
// one place. `crypto-freeze.test.ts` pins each value: changing one is a new
// seal version reviewed by the owner, never an edit. A package records
// `hash_alg` and `seal_version` so an old package is always read with the
// constants it was made with.
//
// No private key is created or held here: the seal is a plain hash, and the
// only signature is the outside authority's.

/** The hash of every fingerprint, of the trail, and of the seal. */
export const SEAL_HASH_ALG = "sha256" as const

/** The manifest's `v` field and the package's `seal_version`. */
export const SEAL_VERSION = 1 as const

/** The manifest's fields, in the order the review lists them (canonical JSON sorts them). */
export const SEAL_MANIFEST_FIELDS = [
  "v",
  "hash",
  "document_sha256",
  "signed_pdf_sha256",
  "trail_sha256",
  "level",
  "agreement",
  "version",
] as const

/** OID of SHA-256, the only hash accepted in a timestamp's message imprint. */
export const OID_SHA256 = "2.16.840.1.101.3.4.2.1"

/** CMS content type of a timestamp token's encapsulated content (RFC 3161). */
export const OID_CT_TSTINFO = "1.2.840.113549.1.9.16.1.4"

/** CMS content type of the token itself (SignedData). */
export const OID_SIGNED_DATA = "1.2.840.113549.1.7.2"

/** Extended key usage the authority's certificate must carry, critical and alone. */
export const OID_KP_TIMESTAMPING = "1.3.6.1.5.5.7.3.8"

/** Extended key usage extension. */
export const OID_EXT_KEY_USAGE = "2.5.29.37"

/** Signed attributes: content type, message digest, ESS signing certificate (v1, v2). */
export const OID_ATTR_CONTENT_TYPE = "1.2.840.113549.1.9.3"
export const OID_ATTR_MESSAGE_DIGEST = "1.2.840.113549.1.9.4"
export const OID_ATTR_SIGNING_CERTIFICATE = "1.2.840.113549.1.9.16.2.12"
export const OID_ATTR_SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47"

/** RFC 3161 `TimeStampReq.version`. */
export const TSP_REQUEST_VERSION = 1

/** Bytes of the request nonce (64 bits, from `randomBytes`). */
export const TSP_NONCE_BYTES = 8

/** `certReq`: the authority puts its certificate in the token. */
export const TSP_CERT_REQ = true

/** The request names no policy (`reqPolicy` absent): the authority's default applies. */
export const TSP_REQ_POLICY = null

/** HTTP media types of the exchange (RFC 3161 section 3.4). */
export const TSP_QUERY_CONTENT_TYPE = "application/timestamp-query"
export const TSP_REPLY_CONTENT_TYPE = "application/timestamp-reply"

/** The authority's answer must arrive within this, or the stamp waits (`pending`). */
export const TSP_TIMEOUT_MS = 10_000

/** `genTime` may differ from the product clock by at most this much. */
export const TSP_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

/** PKIStatus values a token is accepted with: granted (0) and grantedWithMods (1). */
export const TSP_ACCEPTED_STATUSES = [0, 1] as const

/** Largest authority reply read, so a hostile server cannot fill memory. */
export const TSP_MAX_REPLY_BYTES = 64 * 1024

/** Names of the entries of the evidence zip, in the order they are written. */
export const EVIDENCE_ZIP_ENTRIES = {
  signedPdf: "signed.pdf",
  frozenPdf: "document.pdf",
  trail: "trail.json",
  manifest: "manifest.json",
  timestampToken: "timestamp.tsr",
  certificatePdf: "certificate.pdf",
  checkHtml: "check.html",
} as const

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// RFC 3161 timestamp of a seal: build the request, send it to the configured
// authority, and verify the reply before anything keeps it. Every parse and
// every signature or chain check is a `pkijs` / `asn1js` call (and node:crypto
// for hashes); nothing here implements a cryptographic primitive.
//
// What a reply must hold to be kept (section "Timestamp verify at receipt"):
//   status granted or grantedWithMods; a SignedData whose content type is
//   TSTInfo; an imprint whose algorithm is SHA-256 and whose bytes are the
//   seal; our nonce; genTime within 5 minutes of the product clock; a signer
//   certificate whose extended key usage is critical and only timeStamping,
//   valid at genTime, named by the ESS signing-certificate attribute, chained
//   to the operator's configured chain only (never to a certificate the token
//   carries); and the CMS signature over the signed attributes verified.
// A reply that fails any of these is never stored; the seal waits (`pending`)
// and a security log line says why.
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import * as asn1js from "asn1js"
import * as pkijs from "pkijs"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { fetchWithPinnedHost, type PinnedFetchOptions } from "~/lib/outbound-fetch"
import {
  OID_ATTR_CONTENT_TYPE,
  OID_ATTR_SIGNING_CERTIFICATE,
  OID_ATTR_SIGNING_CERTIFICATE_V2,
  OID_CT_TSTINFO,
  OID_EXT_KEY_USAGE,
  OID_KP_TIMESTAMPING,
  OID_SHA256,
  OID_SIGNED_DATA,
  TSP_ACCEPTED_STATUSES,
  TSP_CERT_REQ,
  TSP_MAX_CLOCK_SKEW_MS,
  TSP_MAX_REPLY_BYTES,
  TSP_NONCE_BYTES,
  TSP_QUERY_CONTENT_TYPE,
  TSP_REQUEST_VERSION,
  TSP_TIMEOUT_MS,
} from "~/modules/signing/constants"

const log = rootLogger.child({ module: "signing-timestamp" })

/** Why a reply was refused. Stable strings: tests and the security log read them. */
export type TimestampRefusal =
  | "malformed"
  | "rejected_status"
  | "no_token"
  | "not_signed_data"
  | "not_tstinfo"
  | "bad_version"
  | "imprint_algorithm"
  | "imprint_mismatch"
  | "nonce_mismatch"
  | "gen_time_skew"
  | "signer_missing"
  | "eku"
  | "signer_not_valid_at_gen_time"
  | "content_type_attribute"
  | "ess_cert_id"
  | "chain"
  | "signature"

export class TimestampRefusedError extends Error {
  constructor(
    readonly refusal: TimestampRefusal,
    detail: string,
  ) {
    super(`timestamp refused (${refusal}): ${detail}`)
    this.name = "TimestampRefusedError"
  }
}

export interface TsaConfig {
  url: string
  /** Every certificate the operator configured: the only trust anchors. */
  trust: pkijs.Certificate[]
  /** Reach a private or loopback authority (labelled walk and year boxes only). */
  allowPrivate: boolean
}

export interface VerifiedTimestamp {
  genTime: Date
  policy: string
  serialHex: string
  /** SHA-256 hex of the authority's signing certificate (DER). */
  signerCertSha256: string
  /** SHA-256 hex of each certificate of the validated path, signer first. */
  chainSha256: string[]
}

export type TimestampOutcome =
  | ({ status: "stamped"; reply: Uint8Array } & VerifiedTimestamp)
  | {
      status: "pending"
      reason: "timeout" | "unreachable" | "http_error" | "refused"
      detail: string
    }

function toBytes(buf: ArrayBuffer | ArrayBufferView): Uint8Array {
  return buf instanceof ArrayBuffer
    ? new Uint8Array(buf)
    : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b))
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(toBytes(bytes)).toString("hex")
}

function certDer(cert: pkijs.Certificate): Uint8Array {
  return toBytes(cert.toSchema().toBER(false))
}

/** SHA-256 hex of a certificate's DER. */
export function certificateSha256(cert: pkijs.Certificate): string {
  return createHash("sha256").update(certDer(cert)).digest("hex")
}

/** Parse every certificate of a PEM bundle. Refuses a bundle with none. */
export function parseCertificatesPem(pem: string): pkijs.Certificate[] {
  const blocks = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g),
  ]
  if (blocks.length === 0) throw new Error("the TSA chain holds no PEM certificate")
  return blocks.map((m) => {
    const der = Buffer.from((m[1] as string).replace(/\s+/g, ""), "base64")
    return pkijs.Certificate.fromBER(der)
  })
}

/**
 * The instance's authority, or null when `LIAISON_TSA_URL` is unset (then a
 * send that needs a stamp refuses `TIMESTAMP_NOT_CONFIGURED`). The chain comes
 * from `LIAISON_TSA_CHAIN_FILE` (a path) or `LIAISON_TSA_CHAIN_PEM` (inline);
 * a URL with no chain is a configuration error, never "trust what the token
 * carries".
 */
export function loadTsaConfig(): TsaConfig | null {
  const url = env.LIAISON_TSA_URL
  if (!url) return null
  const pem = env.LIAISON_TSA_CHAIN_FILE
    ? readFileSync(env.LIAISON_TSA_CHAIN_FILE, "utf8")
    : env.LIAISON_TSA_CHAIN_PEM
  if (!pem) {
    throw new Error("LIAISON_TSA_URL is set but neither LIAISON_TSA_CHAIN_FILE nor _PEM is")
  }
  return { url, trust: parseCertificatesPem(pem), allowPrivate: env.LIAISON_TSA_ALLOW_PRIVATE }
}

/** A fresh 64-bit nonce from `randomBytes`. */
export function newNonce(): bigint {
  return BigInt(`0x${randomBytes(TSP_NONCE_BYTES).toString("hex")}`)
}

/**
 * DER of an RFC 3161 TimeStampReq v1: SHA-256 imprint whose hashed message is
 * the 32-byte seal, our nonce, certReq true, no reqPolicy, no extensions.
 */
export function buildTimestampRequest(seal: Uint8Array, nonce: bigint): Uint8Array {
  if (seal.byteLength !== 32) throw new Error("the seal must be 32 bytes")
  const req = new pkijs.TimeStampReq({
    version: TSP_REQUEST_VERSION,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: OID_SHA256,
        algorithmParams: new asn1js.Null(),
      }),
      hashedMessage: new asn1js.OctetString({ valueHex: seal }),
    }),
    nonce: asn1js.Integer.fromBigInt(nonce),
    certReq: TSP_CERT_REQ,
  })
  return toBytes(req.toSchema().toBER(false))
}

function refuse(refusal: TimestampRefusal, detail: string): never {
  throw new TimestampRefusedError(refusal, detail)
}

/** The only extended key usage is timeStamping, and the extension is critical (RFC 3161 2.3). */
function checkTimeStampingEku(cert: pkijs.Certificate): void {
  const ekus = (cert.extensions ?? []).filter((e) => e.extnID === OID_EXT_KEY_USAGE)
  if (ekus.length !== 1) refuse("eku", "the signer certificate needs one extended key usage")
  const ext = ekus[0] as pkijs.Extension
  if (!ext.critical) refuse("eku", "the extended key usage extension is not critical")
  const usage = ext.parsedValue as pkijs.ExtKeyUsage | undefined
  const purposes = usage?.keyPurposes ?? []
  if (purposes.length !== 1 || purposes[0] !== OID_KP_TIMESTAMPING) {
    refuse("eku", `the extended key usage is not only timeStamping: ${purposes.join(", ")}`)
  }
}

const ESS_HASHES: Record<string, string> = {
  "1.3.14.3.2.26": "sha1",
  [OID_SHA256]: "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
}

/**
 * The ESS signing-certificate attribute (v2 preferred, v1 accepted) names the
 * signer certificate: its first ESSCertID's hash equals the certificate's, and
 * its issuerSerial, when present, carries the certificate's serial number.
 */
function checkEssCertId(signerInfo: pkijs.SignerInfo, cert: pkijs.Certificate): void {
  const attrs = signerInfo.signedAttrs?.attributes ?? []
  const v2 = attrs.find((a) => a.type === OID_ATTR_SIGNING_CERTIFICATE_V2)
  const v1 = attrs.find((a) => a.type === OID_ATTR_SIGNING_CERTIFICATE)
  const attr = v2 ?? v1
  if (!attr || attr.values.length !== 1) refuse("ess_cert_id", "no ESS signing-certificate")
  // SigningCertificate(V2) ::= SEQUENCE { certs SEQUENCE OF ESSCertID(v2), policies OPTIONAL }
  const signingCert = attr.values[0] as asn1js.Sequence
  const certs = signingCert.valueBlock?.value?.[0] as asn1js.Sequence | undefined
  const first = certs?.valueBlock?.value?.[0] as asn1js.Sequence | undefined
  const fields = first?.valueBlock?.value ?? []
  let alg = "sha1"
  let i = 0
  if (v2) {
    alg = "sha256"
    if (fields[0] instanceof asn1js.Sequence) {
      const algId = new pkijs.AlgorithmIdentifier({ schema: fields[0] })
      const name = ESS_HASHES[algId.algorithmId]
      if (!name) refuse("ess_cert_id", `unknown ESSCertIDv2 hash ${algId.algorithmId}`)
      alg = name
      i = 1
    }
  }
  const hashField = fields[i]
  if (!(hashField instanceof asn1js.OctetString)) refuse("ess_cert_id", "no certificate hash")
  const expected = createHash(alg).update(certDer(cert)).digest()
  if (!bytesEqual(toBytes(hashField.getValue()), expected)) {
    refuse("ess_cert_id", "the ESS certificate hash does not name the signer certificate")
  }
  const issuerSerial = fields[i + 1] as asn1js.Sequence | undefined
  if (issuerSerial) {
    const serial = issuerSerial.valueBlock?.value?.[1]
    if (!(serial instanceof asn1js.Integer) || !serial.isEqual(cert.serialNumber)) {
      refuse("ess_cert_id", "the ESS issuerSerial does not name the signer certificate")
    }
  }
}

function findSignerCert(signed: pkijs.SignedData, signerInfo: pkijs.SignerInfo) {
  const sid = signerInfo.sid
  if (!(sid instanceof pkijs.IssuerAndSerialNumber)) {
    // A subjectKeyIdentifier sid: let the library resolve it during verify; we
    // still need the certificate for the checks above, so require exactly one.
    const only = (signed.certificates ?? []).filter((c) => c instanceof pkijs.Certificate)
    if (only.length !== 1) refuse("signer_missing", "cannot tell the signer certificate apart")
    return only[0] as pkijs.Certificate
  }
  for (const c of signed.certificates ?? []) {
    if (
      c instanceof pkijs.Certificate &&
      c.issuer.isEqual(sid.issuer) &&
      c.serialNumber.isEqual(sid.serialNumber)
    ) {
      return c
    }
  }
  return refuse("signer_missing", "the token does not carry its signer certificate")
}

export interface VerifyExpectations {
  /** The 32-byte seal the request carried. */
  seal: Uint8Array
  /** The canonical manifest bytes whose SHA-256 is the seal (the stamped message). */
  manifestBytes: Uint8Array
  nonce: bigint
  /** The operator's configured certificates: the only trust anchors. */
  trust: pkijs.Certificate[]
  /** The product clock (ms), never the host's own when a test or the year box moves it. */
  now: number
}

/** Verify an authority's reply. Throws `TimestampRefusedError`; returns what the package keeps. */
export async function verifyTimestampReply(
  reply: Uint8Array,
  expect: VerifyExpectations,
): Promise<VerifiedTimestamp> {
  if (expect.trust.length === 0) refuse("chain", "no configured trust anchor")
  const parsed = asn1js.fromBER(reply)
  if (parsed.offset === -1 || parsed.offset !== reply.byteLength) {
    refuse("malformed", "the reply is not one DER value")
  }
  let resp: pkijs.TimeStampResp
  try {
    resp = new pkijs.TimeStampResp({ schema: parsed.result })
  } catch (err) {
    return refuse("malformed", (err as Error).message)
  }
  const status = resp.status.status as number
  if (!(TSP_ACCEPTED_STATUSES as readonly number[]).includes(status)) {
    refuse("rejected_status", `PKIStatus ${status}`)
  }
  const token = resp.timeStampToken
  if (!token) return refuse("no_token", "a granted reply without a token")
  if (token.contentType !== OID_SIGNED_DATA) refuse("not_signed_data", token.contentType)

  let signed: pkijs.SignedData
  try {
    signed = new pkijs.SignedData({ schema: token.content })
  } catch (err) {
    return refuse("malformed", (err as Error).message)
  }
  if (signed.encapContentInfo.eContentType !== OID_CT_TSTINFO) {
    refuse("not_tstinfo", signed.encapContentInfo.eContentType)
  }
  const eContent = signed.encapContentInfo.eContent
  if (!eContent) return refuse("not_tstinfo", "no encapsulated TSTInfo")
  let tst: pkijs.TSTInfo
  try {
    tst = pkijs.TSTInfo.fromBER(eContent.getValue())
  } catch (err) {
    return refuse("malformed", `TSTInfo: ${(err as Error).message}`)
  }
  if (tst.version !== 1) refuse("bad_version", `TSTInfo version ${tst.version}`)
  if (tst.messageImprint.hashAlgorithm.algorithmId !== OID_SHA256) {
    refuse("imprint_algorithm", tst.messageImprint.hashAlgorithm.algorithmId)
  }
  if (!bytesEqual(toBytes(tst.messageImprint.hashedMessage.getValue()), expect.seal)) {
    refuse("imprint_mismatch", "the token stamps another value")
  }
  if (!tst.nonce || tst.nonce.toBigInt() !== expect.nonce) {
    refuse("nonce_mismatch", "the token answers another request")
  }
  const genTime = tst.genTime
  if (Math.abs(genTime.getTime() - expect.now) > TSP_MAX_CLOCK_SKEW_MS) {
    refuse("gen_time_skew", `genTime is more than 5 minutes from the product clock`)
  }

  if (signed.signerInfos.length !== 1) refuse("signer_missing", "expected exactly one signer")
  const signerInfo = signed.signerInfos[0] as pkijs.SignerInfo
  const signerCert = findSignerCert(signed, signerInfo)
  checkTimeStampingEku(signerCert)
  if (signerCert.notBefore.value > genTime || signerCert.notAfter.value < genTime) {
    refuse("signer_not_valid_at_gen_time", "the signer certificate was not valid at genTime")
  }
  const contentTypeAttr = (signerInfo.signedAttrs?.attributes ?? []).find(
    (a) => a.type === OID_ATTR_CONTENT_TYPE,
  )
  const contentTypeValue = contentTypeAttr?.values[0]
  if (
    !(contentTypeValue instanceof asn1js.ObjectIdentifier) ||
    contentTypeValue.valueBlock.toString() !== OID_CT_TSTINFO
  ) {
    refuse("content_type_attribute", "the signed content-type attribute is not TSTInfo")
  }
  checkEssCertId(signerInfo, signerCert)

  // Signature over the signed attributes (message digest of the TSTInfo
  // included), the TSTInfo imprint against the stamped bytes, and the chain:
  // `trustedCerts` is the configured chain only, `checkChain: true`, and
  // `checkDate` is genTime (the library sets it from the TSTInfo as well).
  let result: pkijs.SignedDataVerifyResult
  try {
    result = await signed.verify(
      {
        signer: 0,
        data: toBytes(expect.manifestBytes).slice().buffer,
        trustedCerts: expect.trust,
        checkChain: true,
        checkDate: genTime,
        extendedMode: true,
      },
      // The library's default engine: the runtime's WebCrypto (globalThis.crypto).
    )
  } catch (err) {
    const e = err as { code?: number; message?: string }
    return refuse(e.code === 5 ? "chain" : "signature", e.message ?? String(err))
  }
  if (result.signatureVerified !== true) refuse("signature", "the CMS signature does not verify")
  const path = result.certificatePath.length > 0 ? result.certificatePath : [signerCert]
  return {
    genTime,
    policy: tst.policy,
    serialHex: hex(tst.serialNumber.valueBlock.valueHexView),
    signerCertSha256: certificateSha256(signerCert),
    chainSha256: path.map(certificateSha256),
  }
}

async function readCapped(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > TSP_MAX_REPLY_BYTES) {
      await reader.cancel()
      throw new Error(`reply larger than ${TSP_MAX_REPLY_BYTES} bytes`)
    }
    chunks.push(value)
  }
  return toBytes(Buffer.concat(chunks))
}

export interface RequestTimestampArgs {
  manifestBytes: Uint8Array
  config: TsaConfig
  /** Product clock; defaults to `Date.now()` (the clock the year box's preload moves). */
  now?: () => number
  /** Test seam passed to `fetchWithPinnedHost`. */
  fetchImpl?: typeof fetch
}

/**
 * Stamp a seal: one POST to the authority, then the full verification. Any
 * failure answers `pending` (the stamp is retried later) and never returns or
 * stores a reply that did not verify.
 */
export async function requestTimestamp(args: RequestTimestampArgs): Promise<TimestampOutcome> {
  const seal = toBytes(createHash("sha256").update(args.manifestBytes).digest())
  const nonce = newNonce()
  const body = buildTimestampRequest(seal, nonce)
  const opts: PinnedFetchOptions = {
    // Plain HTTP is accepted: the token is verified end to end above, and the
    // request carries only a hash. Private hosts need the operator switch.
    requireHttps: false,
    allowPrivate: args.config.allowPrivate,
    maxRedirects: 0,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  }
  let response: Response
  try {
    response = await fetchWithPinnedHost(
      args.config.url,
      {
        method: "POST",
        headers: { "content-type": TSP_QUERY_CONTENT_TYPE },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(TSP_TIMEOUT_MS),
      },
      opts,
    )
  } catch (err) {
    const name = (err as Error).name
    const timeout = name === "TimeoutError" || name === "AbortError"
    log.warn({ err, url: args.config.url }, "timestamp authority not reached")
    return {
      status: "pending",
      reason: timeout ? "timeout" : "unreachable",
      detail: (err as Error).message,
    }
  }
  if (!response.ok) {
    log.warn({ status: response.status, url: args.config.url }, "timestamp authority HTTP error")
    return { status: "pending", reason: "http_error", detail: `HTTP ${response.status}` }
  }
  let reply: Uint8Array
  try {
    reply = await readCapped(response)
  } catch (err) {
    return { status: "pending", reason: "unreachable", detail: (err as Error).message }
  }
  try {
    const verified = await verifyTimestampReply(reply, {
      seal,
      manifestBytes: args.manifestBytes,
      nonce,
      trust: args.config.trust,
      now: (args.now ?? Date.now)(),
    })
    return { status: "stamped", reply, ...verified }
  } catch (err) {
    const refusal = err instanceof TimestampRefusedError ? err.refusal : "malformed"
    // Security log line: a reply that did not verify is dropped, never stored.
    log.error(
      { securityEvent: "timestamp_reply_refused", refusal, url: args.config.url },
      `timestamp reply refused: ${(err as Error).message}`,
    )
    return { status: "pending", reason: "refused", detail: (err as Error).message }
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A local RFC 3161 authority for tests: `openssl ts -reply` behind a small
// HTTP server. Its CA and keys are generated in a temporary directory when a
// test starts and removed when it ends, never committed (a committed key
// trips the secret scan, and the repo is public). The validity window is a
// parameter, so a run whose clock is moved (the year box) gets a CA that
// covers its whole calendar.
//
// Modes answer the way a broken or hostile authority would, so the verifier
// is tested against openssl's own output, not only against tokens it built.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as asn1js from "asn1js"
import * as pkijs from "pkijs"
import { parseCertificatesPem } from "~/modules/signing/timestamp"

export const FIXTURE_POLICY_OID = "1.3.6.1.4.1.55555.1.1"

const CA_CONFIG = `
[ ca ]
default_ca = CA_default
[ CA_default ]
dir = .
database = ./index.txt
serial = ./serial
new_certs_dir = .
default_md = sha256
policy = policy_any
copy_extensions = none
unique_subject = no
[ policy_any ]
commonName = supplied
[ root_ext ]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[ tsa_ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[ tsa_noncritical_ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[ tsa ]
default_tsa = tsa_section
[ tsa_section ]
serial = ./tsaserial
signer_digest = sha256
default_policy = ${FIXTURE_POLICY_OID}
other_policies = ${FIXTURE_POLICY_OID}
digests = sha256
accuracy = secs:1
ordering = no
tsa_name = no
ess_cert_id_chain = no
ess_cert_id_alg = sha256
`

function openssl(cwd: string, args: string[], input?: Uint8Array): Buffer {
  const r = spawnSync("openssl", args, { cwd, input, maxBuffer: 1 << 22 })
  if (r.error) throw new Error(`openssl not runnable: ${r.error.message}`)
  if (r.status !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${r.stderr.toString().trim()}`)
  }
  return r.stdout
}

/** `YYYYMMDDHHMMSSZ` as `openssl ca -startdate` takes it. */
function caDate(d: Date): string {
  return `${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`
}

export interface IssuedCert {
  name: string
  certPath: string
  keyPath: string
  pem: string
  cert: pkijs.Certificate
}

export interface FixtureCa {
  dir: string
  root: IssuedCert
  /** Issue a time-stamping certificate under this root. */
  issueTsa(
    name: string,
    opts?: { notBefore?: Date; notAfter?: Date; criticalEku?: boolean },
  ): IssuedCert
}

function makeCa(dir: string, cn: string, notBefore: Date, notAfter: Date): FixtureCa {
  writeFileSync(path.join(dir, "ca.cnf"), CA_CONFIG)
  writeFileSync(path.join(dir, "index.txt"), "")
  writeFileSync(path.join(dir, "serial"), "1000\n")
  writeFileSync(path.join(dir, "tsaserial"), "01\n")
  openssl(dir, [
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    "root.key",
  ])
  openssl(dir, ["req", "-new", "-key", "root.key", "-subj", `/CN=${cn}`, "-out", "root.csr"])
  openssl(dir, [
    "ca",
    "-batch",
    "-selfsign",
    "-config",
    "ca.cnf",
    "-keyfile",
    "root.key",
    "-in",
    "root.csr",
    "-out",
    "root.pem",
    "-extensions",
    "root_ext",
    "-startdate",
    caDate(notBefore),
    "-enddate",
    caDate(notAfter),
    "-notext",
  ])
  const rootPem = readFileSync(path.join(dir, "root.pem"), "utf8")
  const root: IssuedCert = {
    name: "root",
    certPath: path.join(dir, "root.pem"),
    keyPath: path.join(dir, "root.key"),
    pem: rootPem,
    cert: parseCertificatesPem(rootPem)[0] as pkijs.Certificate,
  }
  return {
    dir,
    root,
    issueTsa(name, opts = {}) {
      const key = `${name}.key`
      openssl(dir, [
        "genpkey",
        "-algorithm",
        "RSA",
        "-pkeyopt",
        "rsa_keygen_bits:2048",
        "-out",
        key,
      ])
      openssl(dir, [
        "req",
        "-new",
        "-key",
        key,
        "-subj",
        `/CN=${cn} ${name}`,
        "-out",
        `${name}.csr`,
      ])
      openssl(dir, [
        "ca",
        "-batch",
        "-config",
        "ca.cnf",
        "-cert",
        "root.pem",
        "-keyfile",
        "root.key",
        "-in",
        `${name}.csr`,
        "-out",
        `${name}.pem`,
        "-extensions",
        opts.criticalEku === false ? "tsa_noncritical_ext" : "tsa_ext",
        "-startdate",
        caDate(opts.notBefore ?? notBefore),
        "-enddate",
        caDate(opts.notAfter ?? notAfter),
        "-notext",
      ])
      const pem = readFileSync(path.join(dir, `${name}.pem`), "utf8")
      return {
        name,
        certPath: path.join(dir, `${name}.pem`),
        keyPath: path.join(dir, key),
        pem,
        cert: parseCertificatesPem(pem)[0] as pkijs.Certificate,
      }
    },
  }
}

export type AuthorityMode =
  | "ok"
  | "other-imprint"
  | "other-nonce"
  | "bad-signature"
  | "rejection"
  | "garbage"
  | "http-500"
  | "slow"

export interface FixtureAuthority {
  ca: FixtureCa
  tsa: IssuedCert
  /** PEM of the chain an operator would configure (the root). */
  chainPem: string
  /** Run `openssl ts -reply` for a DER query with a given signer (default: the TSA). */
  reply(query: Uint8Array, opts?: { signer?: IssuedCert; chainFile?: string }): Uint8Array
  /** A CA the operator never configured, with its own TSA certificate. */
  foreignCa(): { ca: FixtureCa; tsa: IssuedCert }
  /** Start the HTTP server; `mode` can be changed between requests. */
  serve(): Promise<{ url: string; setMode(m: AuthorityMode): void; stop(): void }>
  cleanup(): void
}

function rewriteQuery(query: Uint8Array, mutate: (req: pkijs.TimeStampReq) => void): Uint8Array {
  const req = pkijs.TimeStampReq.fromBER(query)
  mutate(req)
  return new Uint8Array(req.toSchema().toBER(false))
}

/**
 * Create the CA (validity `notBefore` to `notAfter`, default one year either
 * side of now) and one time-stamping certificate in a fresh temporary
 * directory. `openssl` must be on PATH.
 */
export function createFixtureAuthority(
  opts: { notBefore?: Date; notAfter?: Date; root?: string } = {},
): FixtureAuthority {
  const year = 365 * 24 * 3600 * 1000
  const notBefore = opts.notBefore ?? new Date(Date.now() - year)
  const notAfter = opts.notAfter ?? new Date(Date.now() + year)
  const base = mkdtempSync(path.join(opts.root ?? tmpdir(), "liaison-tsa-fixture-"))
  const ca = makeCa(path.join(base, mkdir(base, "main")), "Fixture Root", notBefore, notAfter)
  const tsa = ca.issueTsa("tsa")
  let foreign: { ca: FixtureCa; tsa: IssuedCert } | null = null

  const reply = (query: Uint8Array, r: { signer?: IssuedCert; chainFile?: string } = {}) => {
    const signer = r.signer ?? tsa
    const cwd = path.dirname(signer.certPath)
    const q = path.join(cwd, `q-${process.pid}-${Math.random().toString(36).slice(2)}.tsq`)
    writeFileSync(q, query)
    try {
      const args = ["ts", "-reply", "-config", "ca.cnf", "-queryfile", q]
      args.push("-signer", signer.certPath, "-inkey", signer.keyPath)
      if (r.chainFile) args.push("-chain", r.chainFile)
      return new Uint8Array(openssl(cwd, args))
    } finally {
      rmSync(q, { force: true })
    }
  }

  return {
    ca,
    tsa,
    chainPem: ca.root.pem,
    reply,
    foreignCa() {
      if (!foreign) {
        const fca = makeCa(
          path.join(base, mkdir(base, "foreign")),
          "Other Root",
          notBefore,
          notAfter,
        )
        foreign = { ca: fca, tsa: fca.issueTsa("tsa") }
      }
      return foreign
    },
    async serve() {
      let mode: AuthorityMode = "ok"
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "POST") return new Response("method", { status: 405 })
          const query = new Uint8Array(await request.arrayBuffer())
          const headers = { "content-type": "application/timestamp-reply" }
          switch (mode) {
            case "http-500":
              return new Response("down", { status: 500 })
            case "garbage":
              return new Response(new Uint8Array([0x30, 0x03, 0x02, 0x01]), { headers })
            case "slow":
              await Bun.sleep(15_000)
              return new Response(reply(query), { headers })
            case "other-imprint":
              return new Response(
                reply(
                  rewriteQuery(query, (req) => {
                    req.messageImprint.hashedMessage = new asn1js.OctetString({
                      valueHex: new Uint8Array(32).fill(7),
                    })
                  }),
                ),
                { headers },
              )
            case "other-nonce":
              return new Response(
                reply(
                  rewriteQuery(query, (req) => {
                    req.nonce = asn1js.Integer.fromBigInt(12345n)
                  }),
                ),
                { headers },
              )
            case "rejection":
              // A SHA-1 imprint, which this authority does not accept: openssl answers
              // a rejection status itself.
              return new Response(
                reply(
                  rewriteQuery(query, (req) => {
                    req.messageImprint.hashAlgorithm = new pkijs.AlgorithmIdentifier({
                      algorithmId: "1.3.14.3.2.26",
                      algorithmParams: new asn1js.Null(),
                    })
                    req.messageImprint.hashedMessage = new asn1js.OctetString({
                      valueHex: new Uint8Array(20).fill(1),
                    })
                  }),
                ),
                { headers },
              )
            case "bad-signature": {
              // The SignerInfo's signature is the last value of the reply: flip its last byte.
              const bytes = reply(query)
              bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff
              return new Response(bytes, { headers })
            }
            default:
              return new Response(reply(query), { headers })
          }
        },
      })
      return {
        url: `http://127.0.0.1:${server.port}/tsr`,
        setMode(m) {
          mode = m
        },
        stop() {
          server.stop(true)
        },
      }
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true })
    },
  }
}

function mkdir(base: string, name: string): string {
  mkdirSync(path.join(base, name), { recursive: true })
  return name
}

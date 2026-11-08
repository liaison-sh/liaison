// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ctx.fetch multipart upload: the host assembles the body from the parts an app names (text
// fields, and files read from kernel.files under the bridge's own RLS context), refuses a host
// outside the allow-list or a body over 25 MB before reading any bytes or opening a socket,
// pins a part's expected fingerprint, and logs one audit line (host, size, sha256, status) that
// never carries a header or a body.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { putObject } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"

const HOST = "uploads.provider.example"
const URL_ = `https://${HOST}/v2/imports`
const ORG = randomUUID()
const FILE = randomUUID()
const HIDDEN_FILE = randomUUID()
const TOKEN = "secret-bearer-token-value"
const BYTES = new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256))
const SHA = createHash("sha256").update(BYTES).digest("hex")

function bridgeCtx(txDb: unknown, allowedDomains = [HOST]): BridgeContext {
  return {
    orgId: ORG,
    userId: "00000000-0000-0000-0000-000000000001",
    appName: "provider",
    actorType: "system",
    egress: async () => ({ allowedDomains, manifest: { name: "provider" } }),
    callerScopes: [],
    inheritedActor: { actorType: "system" as const },
    manifest: { name: "provider" },
    txDb,
    resolveCredentials: async () => ({}),
  } as unknown as BridgeContext
}

type Seen = { contentType: string; body: Uint8Array; headers: Record<string, string> }
function transport(): Seen[] {
  const seen: Seen[] = []
  SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === HOST)
  SandboxBridgeTestAccess.setFetch((async (_url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    )
    const ct = headers["Content-Type"] ?? ""
    seen.push({ contentType: ct, body: new Uint8Array(init?.body as Uint8Array), headers })
    return new Response('{"id":1}', { status: 201 })
  }) as unknown as typeof fetch)
  return seen
}

/** Splits a multipart body into its parts' raw bytes, by boundary. */
function partsOf(seen: Seen): Array<{ head: string; bytes: Uint8Array }> {
  const boundary = /boundary=(.+)$/.exec(seen.contentType)![1]!
  const raw = Buffer.from(seen.body)
  const out: Array<{ head: string; bytes: Uint8Array }> = []
  const sep = Buffer.from(`--${boundary}`)
  let at = raw.indexOf(sep)
  while (at !== -1) {
    const next = raw.indexOf(sep, at + sep.length)
    if (next === -1) break
    const chunk = raw.subarray(at + sep.length + 2, next - 2) // drop leading CRLF and trailing CRLF
    const split = chunk.indexOf(Buffer.from("\r\n\r\n"))
    out.push({
      head: chunk.subarray(0, split).toString(),
      bytes: new Uint8Array(chunk.subarray(split + 4)),
    })
    at = next
  }
  return out
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = rootLogger.info.bind(rootLogger)
  const spy = (...args: unknown[]) => {
    lines.push(JSON.stringify(args))
    return (original as (...a: unknown[]) => void)(...args)
  }
  // The audit line is emitted through a child logger: pino children write through the parent's
  // stream, so capture at the stream instead.
  const stream = (rootLogger as unknown as { [k: symbol]: { write: (s: string) => void } })[
    Symbol.for("pino.stream")
  ]
  const origWrite = stream?.write?.bind(stream)
  if (stream && origWrite)
    stream.write = (s: string) => {
      lines.push(s)
      return origWrite(s)
    }
  ;(rootLogger as { info: unknown }).info = spy
  return {
    lines,
    restore: () => {
      ;(rootLogger as { info: unknown }).info = original
      if (stream && origWrite) stream.write = origWrite
    },
  }
}

const upload = (txDb: unknown, opts: Record<string, unknown>, domains?: string[]) =>
  createEgressMethods(bridgeCtx(txDb, domains)).fetch(URL_, JSON.stringify(opts))

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Multipart Org', ${`mp-${ORG.slice(0, 8)}`})`
  const key = `orgs/${ORG}/provider/test/${FILE}/invoice.pdf`
  await putObject({ key, body: BYTES, contentType: "application/pdf" })
  await sql`INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
    VALUES (${FILE}, ${ORG}, 'invoicing', 'legal_original', ${randomUUID()}, 'FA-1.pdf', 'application/pdf', ${BYTES.byteLength}, ${key}),
           (${HIDDEN_FILE}, ${ORG}, 'invoicing', 'legal_original', ${randomUUID()}, 'FA-2.pdf', 'application/pdf', ${BYTES.byteLength}, ${`${key}.hidden`})`
})

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("ctx.fetch multipart upload", () => {
  it("sends the file's exact bytes and the text fields, and reports each part's sha256", async () => {
    const seen = transport()
    const out = await withPrivilegedDb(ORG, "test:multipart", async (tx) =>
      JSON.parse(
        await upload(tx, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: {
            multipart: [
              {
                name: "file",
                fileId: FILE,
                filename: "FA-1.pdf",
                contentType: "application/pdf",
                expectSha256: SHA,
              },
              { name: "send_to_pa", value: "false" },
              { name: "invoice_options[customer_id]", value: "42" },
            ],
          },
          timeoutMs: 90_000,
        }),
      ),
    )
    expect(out.status).toBe(201)
    expect(out.upload.parts).toEqual([
      { name: "file", size: BYTES.byteLength, sha256: SHA, fileId: FILE },
      expect.objectContaining({ name: "send_to_pa", size: 5 }),
      expect.objectContaining({ name: "invoice_options[customer_id]", size: 2 }),
    ])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.contentType).toMatch(/^multipart\/form-data; boundary=/)
    // The app's own content-type cannot contradict the body.
    expect(seen[0]!.headers["Content-Type"]).toBe(seen[0]!.contentType)
    const parts = partsOf(seen[0]!)
    expect(parts[0]!.head).toContain('name="file"; filename="FA-1.pdf"')
    expect(createHash("sha256").update(parts[0]!.bytes).digest("hex")).toBe(SHA)
    expect(new TextDecoder().decode(parts[1]!.bytes)).toBe("false")
    expect(new TextDecoder().decode(parts[2]!.bytes)).toBe("42")
  })

  it("a pinned fingerprint that does not match refuses before anything is sent", async () => {
    const seen = transport()
    const err = await withPrivilegedDb(ORG, "test:multipart", (tx) =>
      upload(tx, {
        method: "POST",
        body: { multipart: [{ name: "file", fileId: FILE, expectSha256: "0".repeat(64) }] },
      }),
    ).catch((e: Error & { code?: string }) => e)
    expect((err as Error & { code?: string }).code).toBe("part_sha256_mismatch")
    expect(seen).toHaveLength(0)
  })

  it("an embedded-file pin: the upload leaves only when the PDF embeds exactly the checked text", async () => {
    const { PDFDocument } = await import("pdf-lib")
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><rsm:CrossIndustryInvoice>Échéance FA-1</rsm:CrossIndustryInvoice>'
    const pdf = await PDFDocument.create()
    pdf.addPage()
    await pdf.attach(new TextEncoder().encode(xml), "factur-x.xml", {
      mimeType: "text/xml",
      afRelationship: "Data" as never,
    })
    const bytes = await pdf.save()
    const pdfId = randomUUID()
    const key = `orgs/${ORG}/provider/test/${pdfId}/facturx.pdf`
    await putObject({ key, body: bytes, contentType: "application/pdf" })
    await sql`INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
      VALUES (${pdfId}, ${ORG}, 'invoicing', 'legal_original', ${randomUUID()}, 'FA-1.pdf', 'application/pdf', ${bytes.byteLength}, ${key})`
    const send = (fileId: string, text: string) =>
      withPrivilegedDb(ORG, "test:multipart", (tx) =>
        upload(tx, {
          method: "POST",
          body: {
            multipart: [
              { name: "file", fileId, expectEmbeddedFile: { name: "factur-x.xml", text } },
            ],
          },
        }),
      ).catch((e: Error & { code?: string }) => e)
    const seen = transport()
    // Another XML than the one embedded (a caller-supplied CII that is not the file's): refused.
    const other = await send(pdfId, xml.replace("FA-1", "FA-2"))
    expect((other as Error & { code?: string }).code).toBe("embedded_file_mismatch")
    // A file with no such attachment: refused.
    const plain = await send(FILE, xml)
    expect((plain as Error & { code?: string }).code).toBe("embedded_file_mismatch")
    expect(seen).toHaveLength(0)
    const ok = JSON.parse((await send(pdfId, xml)) as string)
    expect(ok.status).toBe(201)
    expect(seen).toHaveLength(1)
  })

  it("a file under a parent the part refuses is refused before anything is sent; another parent passes", async () => {
    const seen = transport()
    const err = await withPrivilegedDb(ORG, "test:multipart", (tx) =>
      upload(tx, {
        method: "POST",
        body: {
          multipart: [
            {
              name: "file",
              fileId: FILE,
              refuseParents: [{ app: "invoicing", entityType: "legal_original" }],
            },
          ],
        },
      }),
    ).catch((e: Error & { code?: string }) => e)
    expect((err as Error & { code?: string }).code).toBe("file_parent_refused")
    expect(seen).toHaveLength(0)
    const ok = await withPrivilegedDb(ORG, "test:multipart", async (tx) =>
      JSON.parse(
        await upload(tx, {
          method: "POST",
          body: {
            multipart: [
              {
                name: "file",
                fileId: FILE,
                refuseParents: [{ app: "invoicing", entityType: "received_file" }],
              },
            ],
          },
        }),
      ),
    )
    expect(ok.status).toBe(201)
    expect(seen).toHaveLength(1)
  })

  it("a host outside the allow-list is refused before the file is read", async () => {
    const seen = transport()
    const err = await withPrivilegedDb(ORG, "test:multipart", (tx) =>
      upload(tx, { method: "POST", body: { multipart: [{ name: "file", fileId: FILE }] } }, [
        "other.example",
      ]),
    ).catch((e: Error) => e)
    expect(String((err as Error).message)).toMatch(/not allowed|allow/i)
    expect(seen).toHaveLength(0)
  })

  it("a body over 25 MB is refused", async () => {
    const seen = transport()
    const big = "x".repeat(26 * 1024 * 1024)
    const err = await withPrivilegedDb(ORG, "test:multipart", (tx) =>
      upload(tx, { method: "POST", body: { multipart: [{ name: "blob", value: big }] } }),
    ).catch((e: Error & { code?: string }) => e)
    expect((err as Error & { code?: string }).code).toBe("request_too_large")
    expect(seen).toHaveLength(0)
  })

  it("a file the bridge's RLS context cannot see is refused (and an unknown id too)", async () => {
    const seen = transport()
    const actor = {
      actorType: "system" as const,
      orgId: ORG,
      purpose: "job" as const,
      scopes: ["provider:*"],
    }
    const hidden = await withRlsContext(actor, (tx) =>
      upload(tx, { method: "POST", body: { multipart: [{ name: "file", fileId: HIDDEN_FILE }] } }),
    ).catch((e: Error & { code?: string }) => e)
    expect((hidden as Error & { code?: string }).code).toBe("file_not_readable")
    const unknown = await withPrivilegedDb(ORG, "test:multipart", (tx) =>
      upload(tx, { method: "POST", body: { multipart: [{ name: "file", fileId: randomUUID() }] } }),
    ).catch((e: Error & { code?: string }) => e)
    expect((unknown as Error & { code?: string }).code).toBe("file_not_readable")
    expect(seen).toHaveLength(0)
  })

  it("a provider-contract op reads a caller's file only through the per-call grant", async () => {
    const seen = transport()
    const actor = {
      actorType: "system" as const,
      orgId: ORG,
      purpose: "job" as const,
      scopes: ["provider:*"],
    }
    const send = (grant: string[] | undefined) =>
      withRlsContext(actor, (tx) =>
        createEgressMethods({
          ...bridgeCtx(tx),
          bridgeOptions: grant ? { contractFileGrant: grant } : {},
        } as unknown as BridgeContext).fetch(
          URL_,
          JSON.stringify({ method: "POST", body: { multipart: [{ name: "file", fileId: FILE }] } }),
        ),
      ).catch((e: Error & { code?: string }) => e)
    // Without the grant the provider's own RLS context cannot see the caller's file.
    expect(((await send(undefined)) as Error & { code?: string }).code).toBe("file_not_readable")
    // A grant for another file does not open this one.
    expect(((await send([HIDDEN_FILE])) as Error & { code?: string }).code).toBe(
      "file_not_readable",
    )
    expect(seen).toHaveLength(0)
    const ok = JSON.parse((await send([FILE])) as string)
    expect(ok.status).toBe(201)
    expect(seen).toHaveLength(1)
  })

  it("logs one audit line with host, size, sha256 and status, never the token or the bytes", async () => {
    transport()
    const cap = captureLogs()
    try {
      await withPrivilegedDb(ORG, "test:multipart", (tx) =>
        upload(tx, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: {
            multipart: [
              { name: "file", fileId: FILE },
              { name: "note", value: "private-body-text" },
            ],
          },
        }),
      )
    } finally {
      cap.restore()
    }
    const all = cap.lines.join("\n")
    const audit = cap.lines.filter((l) => l.includes("sandbox multipart upload"))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toContain(HOST)
    expect(audit[0]).toContain(SHA)
    expect(audit[0]).toContain('"status":201')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain("private-body-text")
  })

  it("a non-string, non-multipart body is refused", async () => {
    transport()
    const err = await upload(null, { method: "POST", body: { json: 1 } }).catch((e: Error) => e)
    expect(String((err as Error).message)).toContain("body must be a string")
  })
})

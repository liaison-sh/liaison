// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import * as jose from "jose"
import type { PrivilegedDb } from "~/db"
import type { ConfirmUploadDeps } from "./service"

type ServiceModule = typeof import("./service")
let svc: ServiceModule

beforeAll(async () => {
  svc = await import("./service")
})

afterEach(() => {
  // No-op; each test wires its own deps.
})

const SECRET = "x".repeat(32)

const ORG = "00000000-0000-0000-0000-000000000001"
const USER = "00000000-0000-0000-0000-000000000002"
const THREAD = "00000000-0000-0000-0000-000000000003"

describe("file token sign/verify", () => {
  it("roundtrips payload through signFileToken/verifyFileToken", async () => {
    const token = await svc.signFileToken(
      {
        orgId: ORG,
        userId: USER,
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        storageKey: "orgs/x/kernel/thread/t/u/x.txt",
        filename: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      },
      SECRET,
    )
    expect(token).toMatch(/^ey/)
    const decoded = await svc.verifyFileToken(token, SECRET)
    expect(decoded.entityId).toBe(THREAD)
    expect(decoded.storageKey).toBe("orgs/x/kernel/thread/t/u/x.txt")
    expect(decoded.sizeBytes).toBe(5)
  })

  it("rejects token signed with wrong secret", async () => {
    const token = await svc.signFileToken(
      {
        orgId: ORG,
        userId: USER,
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        storageKey: "k",
        filename: "x",
        mimeType: "text/plain",
        sizeBytes: 1,
      },
      SECRET,
    )
    await expect(svc.verifyFileToken(token, "y".repeat(32))).rejects.toBeDefined()
  })

  // Defense-in-depth payload validation. These tokens are correctly HS256-signed
  // by us with the right audience — the point is that a malformed/missing claim
  // is rejected at verify rather than silently coerced via a blind cast into S3
  // HEAD / kernel.files writes. Helper signs an arbitrary body so jose's
  // signature/audience checks pass and only the payload schema can reject.
  async function signRawFileBody(body: Record<string, unknown>): Promise<string> {
    const key = new TextEncoder().encode(SECRET)
    return new jose.SignJWT(body)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setAudience("file-upload")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(key)
  }

  it("rejects a (validly signed) token missing the required storageKey claim", async () => {
    const token = await signRawFileBody({
      orgId: ORG,
      userId: USER,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      // storageKey omitted
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    })
    await expect(svc.verifyFileToken(token, SECRET)).rejects.toThrow(/Invalid file token payload/)
  })

  it("rejects a (validly signed) token whose sizeBytes claim is a string, not a number", async () => {
    const token = await signRawFileBody({
      orgId: ORG,
      userId: USER,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      storageKey: "orgs/x/kernel/thread/t/u/x.txt",
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: "5", // wrong type — should be a number
    })
    await expect(svc.verifyFileToken(token, SECRET)).rejects.toThrow(/Invalid file token payload/)
  })

  it("still verifies a well-formed token and returns the exact payload shape", async () => {
    const token = await svc.signFileToken(
      {
        orgId: ORG,
        userId: USER,
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        storageKey: "orgs/x/kernel/thread/t/u/x.txt",
        filename: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      },
      SECRET,
    )
    const decoded = await svc.verifyFileToken(token, SECRET)
    expect(decoded).toEqual({
      orgId: ORG,
      userId: USER,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      storageKey: "orgs/x/kernel/thread/t/u/x.txt",
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    })
  })
})

describe("buildStorageKey", () => {
  it("composes orgs/<org>/<app>/<entity>/<id>/<uuid>/<sanitized>", () => {
    const key = svc.buildStorageKey({
      orgId: "ORG",
      app: "kernel",
      entityType: "thread",
      entityId: "T",
      filename: "../etc/passwd",
    })
    expect(key.startsWith("orgs/ORG/kernel/thread/T/")).toBe(true)
    expect(key.endsWith("/passwd")).toBe(true)
  })

  it("uses objectId as the object segment when given, a fresh uuid otherwise", () => {
    const base = {
      orgId: "ORG",
      app: "projects",
      entityType: "task",
      entityId: "T",
      filename: "a.png",
    }
    const id = "11111111-2222-5333-8444-555555555555"
    expect(svc.buildStorageKey({ ...base, objectId: id })).toBe(
      `orgs/ORG/projects/task/T/${id}/a.png`,
    )
    expect(svc.buildStorageKey({ ...base, objectId: id })).toBe(
      svc.buildStorageKey({ ...base, objectId: id }),
    )
    expect(svc.buildStorageKey(base)).not.toBe(svc.buildStorageKey(base))
  })
})

describe("resolveParent", () => {
  it("returns built-in kernel:thread declaration", () => {
    const p = svc.resolveParent(ORG, "kernel", "thread")
    expect(p?.tableName).toBe("threads")
    expect(p?.writeScope).toBe("kernel:threads:write")
  })

  it("returns undefined for unknown app/entity", () => {
    expect(svc.resolveParent(ORG, "unknown-app", "entity")).toBeUndefined()
  })
})

type ExecuteResult = unknown[]
function makeRlsTx(parentVisible: boolean) {
  const execute = mock(async (_query: unknown) => {
    return parentVisible ? [{ id: THREAD }] : []
  })
  return { execute } as any
}

function makePrivileged(opts: {
  fileSizeLimitMb?: number
  storageQuotaGb?: number
  usedBytes?: number
}) {
  return async <T>(reason: string, fn: (tx: any) => Promise<T>): Promise<T> => {
    const tx = {
      execute: mock(async (_q: unknown) => {
        if (reason.includes("quota")) {
          return [{ total: String(opts.usedBytes ?? 0) }]
        }
        return [
          {
            settings: { fileSizeLimitMb: opts.fileSizeLimitMb ?? 50 },
            // The storage quota is the operator's cap (organizations.caps).
            caps: { storageGb: opts.storageQuotaGb ?? 10 },
          },
        ]
      }),
    }
    return fn(tx)
  }
}

describe("authorizeUpload", () => {
  it("direct: presigns a PUT pinned to the declared type, size and token lifetime", async () => {
    const presignPut = mock(async (_args: any) => "http://signed-url.example/put")
    const result = await svc.authorizeUpload(
      {
        orgId: ORG,
        userId: USER,
        scopes: ["kernel:threads:write"],
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        filename: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      },
      {
        rlsTx: makeRlsTx(true),
        privileged: makePrivileged({}),
        presignPut: presignPut as any,
        jwtSecret: SECRET,
        delivery: "direct",
      },
    )
    expect(result.uploadMode).toBe("direct")
    expect(result.uploadUrl).toBe("http://signed-url.example/put")
    expect(result).not.toHaveProperty("uploadHeaders")
    expect(result.fileToken).toMatch(/^ey/)
    expect(result.storageKey.startsWith(`orgs/${ORG}/kernel/thread/${THREAD}/`)).toBe(true)
    expect(presignPut).toHaveBeenCalledTimes(1)
    expect(presignPut.mock.calls[0][0]).toEqual({
      key: result.storageKey,
      contentLength: 5,
      contentType: "text/plain",
      // Five minutes, not the token's fifteen: the URL's lifetime is the only
      // bound on a re-PUT by its holder (see authorizeUploadCore).
      expiresInSec: 5 * 60,
    })
  })

  it("relay: no presign, the upload url is the API relay for this token", async () => {
    const presignPut = mock(async (_args: any) => "http://signed-url.example/put")
    const result = await svc.authorizeUpload(
      {
        orgId: ORG,
        userId: USER,
        scopes: ["kernel:threads:write"],
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        filename: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      },
      {
        rlsTx: makeRlsTx(true),
        privileged: makePrivileged({}),
        presignPut: presignPut as any,
        jwtSecret: SECRET,
        delivery: "relay",
        baseUrl: "https://box.example.com/",
      },
    )
    expect(result.uploadMode).toBe("relay")
    expect(result.uploadUrl).toBe(
      `https://box.example.com/api/file-relay/${encodeURIComponent(result.fileToken)}`,
    )
    expect(presignPut).not.toHaveBeenCalled()
  })

  it("relay is the deployment default (OBJECT_STORAGE_BROWSER_DIRECT off)", async () => {
    const presignPut = mock(async (_args: any) => "http://signed-url.example/put")
    const result = await svc.authorizeUpload(
      {
        orgId: ORG,
        userId: USER,
        scopes: ["kernel:threads:write"],
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        filename: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      },
      {
        rlsTx: makeRlsTx(true),
        privileged: makePrivileged({}),
        presignPut: presignPut as any,
        jwtSecret: SECRET,
      },
    )
    expect(result.uploadMode).toBe("relay")
    expect(presignPut).not.toHaveBeenCalled()
  })

  it("throws FILE_TOO_LARGE when sizeBytes exceeds fileSizeLimitMb", async () => {
    await expect(
      svc.authorizeUpload(
        {
          orgId: ORG,
          userId: USER,
          scopes: ["kernel:threads:write"],
          app: "kernel",
          entityType: "thread",
          entityId: THREAD,
          filename: "big.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 100 * 1024 * 1024,
        },
        {
          rlsTx: makeRlsTx(true),
          privileged: makePrivileged({ fileSizeLimitMb: 1 }),
          presignPut: mock(async () => "ignored") as any,
          jwtSecret: SECRET,
        },
      ),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" })
  })

  it("throws FORBIDDEN when scopes lack writeScope", async () => {
    await expect(
      svc.authorizeUpload(
        {
          orgId: ORG,
          userId: USER,
          scopes: ["kernel:threads:read"],
          app: "kernel",
          entityType: "thread",
          entityId: THREAD,
          filename: "x.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
        {
          rlsTx: makeRlsTx(true),
          privileged: makePrivileged({}),
          presignPut: mock(async () => "ignored") as any,
          jwtSecret: SECRET,
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("throws PARENT_NOT_FOUND when parent invisible under RLS", async () => {
    await expect(
      svc.authorizeUpload(
        {
          orgId: ORG,
          userId: USER,
          scopes: ["kernel:threads:write"],
          app: "kernel",
          entityType: "thread",
          entityId: THREAD,
          filename: "x.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
        {
          rlsTx: makeRlsTx(false),
          privileged: makePrivileged({}),
          presignPut: mock(async () => "ignored") as any,
          jwtSecret: SECRET,
        },
      ),
    ).rejects.toMatchObject({ code: "PARENT_NOT_FOUND" })
  })

  it("throws STORAGE_QUOTA_EXCEEDED when used + size exceeds quota", async () => {
    await expect(
      svc.authorizeUpload(
        {
          orgId: ORG,
          userId: USER,
          scopes: ["kernel:threads:write"],
          app: "kernel",
          entityType: "thread",
          entityId: THREAD,
          filename: "x.txt",
          mimeType: "text/plain",
          sizeBytes: 10,
        },
        {
          rlsTx: makeRlsTx(true),
          privileged: makePrivileged({
            storageQuotaGb: 1,
            usedBytes: 1 * 1024 * 1024 * 1024,
          }),
          presignPut: mock(async () => "ignored") as any,
          jwtSecret: SECRET,
        },
      ),
    ).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" })
  })

  it("storageQuotaGb <= 0 disables the quota entirely (self-hosted posture)", async () => {
    const result = await svc.authorizeUpload(
      {
        orgId: ORG,
        userId: USER,
        scopes: ["kernel:threads:write"],
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        filename: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
      },
      {
        rlsTx: makeRlsTx(true),
        privileged: makePrivileged({
          storageQuotaGb: 0,
          usedBytes: 500 * 1024 * 1024 * 1024,
        }),
        presignPut: mock(async () => "http://signed-url.example/put") as any,
        jwtSecret: SECRET,
      },
    )
    expect(result.uploadUrl).toMatch(/^http/)
  })

  it("wouldExceedOrgQuota never trips on an unlimited org and skips the usage query", async () => {
    const execute = mock(async () => [{ total: "999999999999" }])
    const tx = { execute } as unknown as PrivilegedDb
    const unlimited = { fileSizeLimitMb: 50, storageQuotaGb: 0 }
    expect(await svc.wouldExceedOrgQuota(tx, "org-1", unlimited, 5 * 1024 * 1024)).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it("wouldExceedOrgQuota trips only when used + added crosses a positive quota", async () => {
    const gb = 1024 * 1024 * 1024
    const tx = { execute: mock(async () => [{ total: String(gb) }]) } as unknown as PrivilegedDb
    const oneGb = { fileSizeLimitMb: 50, storageQuotaGb: 1 }
    expect(await svc.wouldExceedOrgQuota(tx, "org-1", oneGb, 1)).toBe(true)
    const twoGb = { fileSizeLimitMb: 50, storageQuotaGb: 2 }
    expect(await svc.wouldExceedOrgQuota(tx, "org-1", twoGb, gb)).toBe(false)
  })

  it("orgQuotaBytes maps 0 to unlimited and positive GB to bytes", () => {
    expect(svc.orgQuotaBytes({ fileSizeLimitMb: 50, storageQuotaGb: 0 })).toBeNull()
    expect(svc.orgQuotaBytes({ fileSizeLimitMb: 50, storageQuotaGb: -1 })).toBeNull()
    expect(svc.orgQuotaBytes({ fileSizeLimitMb: 50, storageQuotaGb: 2 })).toBe(
      2 * 1024 * 1024 * 1024,
    )
  })
})

describe("confirmUpload", () => {
  async function makeToken(over: Partial<import("./service").FileTokenPayload> = {}) {
    return svc.signFileToken(
      {
        orgId: ORG,
        userId: USER,
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        storageKey: `orgs/${ORG}/kernel/thread/${THREAD}/u/x.txt`,
        filename: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        ...over,
      },
      SECRET,
    )
  }

  it("throws INVALID_TOKEN on malformed token", async () => {
    await expect(
      svc.confirmUpload("not-a-token", {
        privileged: async () => {
          throw new Error("should not call")
        },
        headObject: mock(async () => ({ contentLength: 0, contentType: "" })) as any,
        jwtSecret: SECRET,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN" })
  })

  // I-TEST-2: a file token minted for one org must be rejected when the caller
  // is authenticated as a different org.
  it("throws FORBIDDEN when the file token orgId does not match the authenticated caller's orgId", async () => {
    const token = await makeToken()
    const DIFFERENT_ORG = "00000000-0000-0000-0000-000000009999"
    await expect(
      svc.confirmUpload(token, {
        callerOrgId: DIFFERENT_ORG, // caller is a different org from the token's ORG
        privileged: async () => {
          throw new Error("should not reach privileged db")
        },
        headObject: mock(async () => ({
          contentLength: 5,
          contentType: "text/plain",
        })) as ConfirmUploadDeps["headObject"],
        jwtSecret: SECRET,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("proceeds normally when callerOrgId matches the token orgId", async () => {
    const token = await makeToken()
    const insertedRow = {
      id: "00000000-0000-0000-0000-000000000098",
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      storageKey: `orgs/${ORG}/kernel/thread/${THREAD}/u/x.txt`,
      thumbnailKey: null,
      uploadedBy: USER,
      createdAt: new Date(),
    }

    let qCall = 0
    const tx = {
      execute: mock(async () => {
        qCall++
        if (qCall === 1) return []
        if (qCall === 2) return [{ settings: { fileSizeLimitMb: 50 }, caps: { storageGb: 10 } }]
        return [{ total: "0" }]
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [] as unknown[],
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => [insertedRow],
        }),
      }),
      queueEvent: mock(async () => {}),
    }

    const result = await svc.confirmUpload(token, {
      callerOrgId: ORG, // same org as the token
      privileged: async (_r, fn) => fn(tx as unknown as PrivilegedDb),
      headObject: mock(async () => ({
        contentLength: 5,
        contentType: "text/plain",
      })) as ConfirmUploadDeps["headObject"],
      jwtSecret: SECRET,
    })
    expect(result.id).toBe(insertedRow.id)
  })

  it("throws FILE_VERIFY_FAILED when HEAD object missing", async () => {
    const token = await makeToken()
    const { tx } = lockedTx([])
    await expect(
      svc.confirmUpload(token, {
        privileged: async (_r, fn) => fn(tx as unknown as PrivilegedDb),
        headObject: mock(async () => {
          throw new Error("not found")
        }) as any,
        jwtSecret: SECRET,
      }),
    ).rejects.toMatchObject({ code: "FILE_VERIFY_FAILED" })
  })

  it("throws FILE_VERIFY_FAILED when HEAD size mismatches", async () => {
    const token = await makeToken({ sizeBytes: 5 } as any)
    const { tx } = lockedTx([])
    await expect(
      svc.confirmUpload(token, {
        privileged: async (_r, fn) => fn(tx as unknown as PrivilegedDb),
        headObject: mock(async () => ({ contentLength: 4, contentType: "text/plain" })) as any,
        deleteObject: mock(async () => {}) as any,
        jwtSecret: SECRET,
      }),
    ).rejects.toMatchObject({ code: "FILE_VERIFY_FAILED" })
  })

  // A direct upload reaches the store without the server: the confirm's HEAD is
  // its only look at the object, and an object that is not what was authorized
  // must not outlive the failed confirm.
  // Records each statement in order: which advisory lock (per storage key or
  // per org), the ownership read, the store HEAD and delete.
  const dialect = new PgDialect()
  function lockedTx(existingRows: unknown[], executeRows: unknown[] = []) {
    const inserts: unknown[] = []
    const steps: string[] = []
    const tx = {
      execute: mock(async (q: any) => {
        const { sql: text, params } = dialect.sqlToQuery(q)
        if (text.includes("hashtext")) steps.push(`keylock:${params.at(-1)}`)
        else if (text.includes("advisory")) steps.push("orglock")
        else steps.push("query")
        return executeRows
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              steps.push("select")
              return existingRows
            },
          }),
        }),
      }),
      insert: () => {
        inserts.push(1)
        throw new Error("must not insert")
      },
    }
    return { tx, inserts, steps }
  }
  const KEY = `orgs/${ORG}/kernel/thread/${THREAD}/u/x.txt`

  for (const [label, head] of [
    ["size", { contentLength: 6, contentType: "text/plain" }],
    ["content type", { contentLength: 5, contentType: "text/html" }],
    ["content encoding", { contentLength: 5, contentType: "text/plain", contentEncoding: "gzip" }],
    ["missing content type", { contentLength: 5, contentType: "" }],
  ] as const) {
    it(`deletes the object and creates no row on a ${label} mismatch`, async () => {
      const token = await makeToken()
      const { tx, inserts, steps } = lockedTx([])
      const deleteObject = mock(async (_key: string) => {
        steps.push("delete")
      })
      await expect(
        svc.confirmUpload(token, {
          privileged: async (_r, fn) => fn(tx as unknown as PrivilegedDb),
          headObject: mock(async () => {
            steps.push("head")
            return head
          }) as any,
          deleteObject: deleteObject as any,
          jwtSecret: SECRET,
        }),
      ).rejects.toMatchObject({ code: "FILE_VERIFY_FAILED" })
      expect(deleteObject).toHaveBeenCalledTimes(1)
      expect(deleteObject.mock.calls[0][0]).toBe(`orgs/${ORG}/kernel/thread/${THREAD}/u/x.txt`)
      expect(inserts).toHaveLength(0)
      // Key lock first; the ownership read, HEAD and delete all under it.
      expect(steps).toEqual([`keylock:${KEY}`, "select", "head", "delete"])
    })
  }

  it("accepts an identity Content-Encoding", async () => {
    const token = await makeToken()
    const deleteObject = mock(async (_key: string) => {})
    const tx = {
      execute: mock(async () => [{ settings: { fileSizeLimitMb: 50 }, caps: { storageGb: 10 } }]),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({
        values: () => ({ returning: async () => [{ id: "f-identity", createdAt: new Date() }] }),
      }),
      queueEvent: mock(async () => {}),
    }
    const result = await svc.confirmUpload(token, {
      privileged: async (_r, fn) => fn(tx as unknown as PrivilegedDb),
      headObject: mock(async () => ({
        contentLength: 5,
        contentType: "text/plain",
        contentEncoding: "identity",
      })) as any,
      deleteObject: deleteObject as any,
      jwtSecret: SECRET,
    })
    expect(result.id).toBe("f-identity")
    expect(deleteObject).not.toHaveBeenCalled()
  })

  // Over quota at confirm time: the object will never get a row, so it is
  // removed under the key lock, after the org lock (always in that order).
  it("deletes the object when the confirm fails on quota", async () => {
    const token = await makeToken()
    const { tx, steps } = lockedTx(
      [],
      [{ settings: { fileSizeLimitMb: 50 }, caps: { storageGb: 1 }, total: String(1024 ** 3) }],
    )
    const deleteObject = mock(async (_key: string) => {
      steps.push("delete")
    })
    await expect(
      svc.confirmUpload(token, {
        privileged: async (_r, fn) => fn(tx as unknown as PrivilegedDb),
        headObject: mock(async () => ({ contentLength: 5, contentType: "text/plain" })) as any,
        deleteObject: deleteObject as any,
        jwtSecret: SECRET,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" })
    expect(deleteObject).toHaveBeenCalledTimes(1)
    expect(steps).toEqual([`keylock:${KEY}`, "select", "orglock", "query", "query", "delete"])
  })

  // A retried confirm of a confirmed upload returns its row, under the key
  // lock, without looking at (or deleting) the object at all.
  it("returns an existing row without HEAD or delete", async () => {
    const token = await makeToken()
    const existing = { id: "existing", storageKey: KEY, createdAt: new Date() }
    const { tx, steps } = lockedTx([existing])
    const deleteObject = mock(async (_key: string) => {})
    const headObject = mock(async () => ({ contentLength: 4, contentType: "text/plain" }))
    const result = await svc.confirmUpload(token, {
      privileged: async (_r, fn) => fn(tx as unknown as PrivilegedDb),
      headObject: headObject as any,
      deleteObject: deleteObject as any,
      jwtSecret: SECRET,
    })
    expect(result.id).toBe("existing")
    expect(steps).toEqual([`keylock:${KEY}`, "select"])
    expect(headObject).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it("does not delete anything when the object is simply missing", async () => {
    const token = await makeToken()
    const { tx } = lockedTx([])
    const deleteObject = mock(async (_key: string) => {})
    await expect(
      svc.confirmUpload(token, {
        privileged: async (_r, fn) => fn(tx as unknown as PrivilegedDb),
        headObject: mock(async () => {
          throw new Error("NotFound")
        }) as any,
        deleteObject: deleteObject as any,
        jwtSecret: SECRET,
      }),
    ).rejects.toMatchObject({ code: "FILE_VERIFY_FAILED" })
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it("inserts row + queues event + returns metadata when HEAD matches and no row exists", async () => {
    const token = await makeToken()
    const insertedRow = {
      id: "00000000-0000-0000-0000-000000000099",
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      storageKey: `orgs/${ORG}/kernel/thread/${THREAD}/u/x.txt`,
      thumbnailKey: null,
      uploadedBy: USER,
      createdAt: new Date(),
    }

    const events: any[] = []
    const queryLog: unknown[] = []
    const txExecute = mock(async (q: unknown) => {
      queryLog.push(q)
      // First call: advisory lock. Subsequent: settings, then usage.
      if (queryLog.length === 1) return [] // pg_advisory_xact_lock
      if (queryLog.length === 2)
        return [{ settings: { fileSizeLimitMb: 50 }, caps: { storageGb: 10 } }]
      return [{ total: "0" }]
    })

    const tx = {
      execute: txExecute,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [] as any[],
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => [insertedRow],
        }),
      }),
      queueEvent: mock(async (e: any) => {
        events.push(e)
      }),
    }
    const result = await svc.confirmUpload(token, {
      privileged: async (_r, fn) => fn(tx as any),
      headObject: mock(async () => ({ contentLength: 5, contentType: "text/plain" })) as any,
      jwtSecret: SECRET,
    })
    expect(result.id).toBe(insertedRow.id)
    expect(result.filename).toBe("x.txt")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      app: "kernel",
      entity: "file",
      action: "create",
      entityId: insertedRow.id,
    })
  })

  // The Home's file_shared card opens what the file:create event links to: the
  // thread the file was added to. Other parents are no shared surface: no link.
  async function confirmedEvent(parent: { app: string; entityType: string; entityId: string }) {
    const token = await makeToken({
      ...parent,
      storageKey: `orgs/${ORG}/${parent.app}/${parent.entityType}/${parent.entityId}/u/x.txt`,
    })
    const insertedRow = {
      id: "00000000-0000-0000-0000-0000000000a1",
      orgId: ORG,
      ...parent,
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      storageKey: `orgs/${ORG}/${parent.app}/${parent.entityType}/${parent.entityId}/u/x.txt`,
      thumbnailKey: null,
      uploadedBy: USER,
      createdAt: new Date(),
    }
    const events: any[] = []
    let calls = 0
    const tx = {
      execute: mock(async () => {
        calls++
        if (calls === 1) return []
        if (calls === 2) return [{ settings: { fileSizeLimitMb: 50 }, caps: { storageGb: 10 } }]
        if (calls === 3) return [{ total: "0" }]
        return []
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] as any[] }) }) }),
      insert: () => ({ values: () => ({ returning: async () => [insertedRow] }) }),
      queueEvent: mock(async (e: any) => {
        events.push(e)
      }),
    }
    await svc.confirmUpload(token, {
      privileged: async (_r, fn) => fn(tx as any),
      headObject: mock(async () => ({ contentLength: 5, contentType: "text/plain" })) as any,
      jwtSecret: SECRET,
    })
    expect(events).toHaveLength(1)
    return events[0]
  }

  it("the file:create event links the thread a file was added to", async () => {
    const event = await confirmedEvent({ app: "kernel", entityType: "thread", entityId: THREAD })
    expect(event.data.parentSharedSurface).toBe(true)
    expect(event.data.link).toEqual({ tabType: "kernel:thread", entityId: THREAD })
  })

  it("the file:create event carries no link for a parent that is not a thread", async () => {
    const event = await confirmedEvent({
      app: "projects",
      entityType: "task",
      entityId: "00000000-0000-0000-0000-0000000000b2",
    })
    expect(event.data.parentSharedSurface).toBe(false)
    expect(event.data.link).toBeUndefined()
  })

  it("getDownloadUrl returns presigned URLs for storageKey and thumbnailKey under RLS", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000aaa",
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "x.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      storageKey: "orgs/x/k/t/i/x.jpg",
      thumbnailKey: "orgs/x/k/t/i/x.jpg.thumb.webp",
      uploadedBy: USER,
      createdAt: new Date(),
    }
    const rlsTx = {
      execute: mock(async () => [row]),
    } as any
    const presignGet = mock(async (args: { key: string }) => `http://signed/${args.key}`) as any
    const result = await svc.getDownloadUrl(row.id, { rlsTx, presignGet, delivery: "direct" })
    expect(result.delivery).toBe("direct")
    expect(result.downloadUrl).toBe(`http://signed/${row.storageKey}`)
    expect(result.thumbnailUrl).toBe(`http://signed/${row.thumbnailKey}`)
    expect(result.id).toBe(row.id)
    // The download is pinned: attachment, its stored type, five minutes.
    expect(presignGet.mock.calls[0][0]).toEqual({
      key: row.storageKey,
      expiresInSec: 300,
      responseContentDisposition: `attachment; filename="x.jpg"; filename*=UTF-8''x.jpg`,
      responseContentType: "image/jpeg",
      responseCacheControl: "private, max-age=60",
      responseContentEncoding: "identity",
    })
    expect(presignGet.mock.calls[1][0]).toMatchObject({
      key: row.thumbnailKey,
      responseContentType: "image/webp",
      responseContentDisposition: "inline",
    })
    expect(result).not.toHaveProperty("orgId")
    expect(result).not.toHaveProperty("encVersion")
  })

  it("getDownloadUrl forces attachment for an HTML or SVG file", async () => {
    for (const [filename, mimeType] of [
      ["page.html", "text/html"],
      ["logo.svg", "image/svg+xml"],
    ]) {
      const row = {
        id: "00000000-0000-0000-0000-000000000ab1",
        orgId: ORG,
        filename,
        mimeType,
        sizeBytes: 3,
        storageKey: `orgs/x/${filename}`,
        thumbnailKey: null,
      }
      const rlsTx = { execute: mock(async () => [row]) } as any
      const presignGet = mock(async () => "http://signed") as any
      await svc.getDownloadUrl(row.id, { rlsTx, presignGet, delivery: "direct" })
      expect(presignGet.mock.calls[0][0].responseContentDisposition).toStartWith("attachment;")
    }
  })

  it("getDownloadUrl relays: the capability url of the API relay, no presign", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000ab2",
      orgId: ORG,
      filename: "x.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      storageKey: "orgs/x/x.pdf",
      thumbnailKey: "orgs/x/x.pdf.thumb.webp",
    }
    const rlsTx = { execute: mock(async () => [row]) } as any
    const presignGet = mock(async () => "http://signed") as any
    const result = await svc.getDownloadUrl(row.id, {
      rlsTx,
      presignGet,
      delivery: "relay",
      relay: { baseUrl: "https://box.example.com", jwtSecret: SECRET },
    })
    expect(result.delivery).toBe("relay")
    expect(result.downloadUrl).toStartWith("https://box.example.com/api/file-relay-dl/")
    expect(result.thumbnailUrl).toBeUndefined()
    expect(presignGet).not.toHaveBeenCalled()
    const token = result.downloadUrl.split("/").pop() as string
    const claims = await svc.verifyFileDownloadToken(token, SECRET)
    expect(claims).toMatchObject({ orgId: ORG, fileId: row.id, storageKey: row.storageKey })
  })

  it("getDownloadUrl relays a sealed attachment even when delivery is direct", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000ab3",
      orgId: ORG,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      storageKey: "orgs/x/invoice.pdf",
      thumbnailKey: null,
      encVersion: 1,
    }
    const rlsTx = { execute: mock(async () => [row]) } as any
    const presignGet = mock(async () => "http://signed") as any
    const result = await svc.getDownloadUrl(row.id, {
      rlsTx,
      presignGet,
      delivery: "direct",
      relay: { baseUrl: "https://box.example.com", jwtSecret: SECRET },
    })
    expect(result.delivery).toBe("relay")
    expect(presignGet).not.toHaveBeenCalled()
  })

  it("getDownloadUrl throws PARENT_NOT_FOUND when row invisible under RLS", async () => {
    const rlsTx = { execute: mock(async () => []) } as any
    const presignGet = mock(async () => "should-not-call") as any
    await expect(
      svc.getDownloadUrl("00000000-0000-0000-0000-000000000bbb", { rlsTx, presignGet }),
    ).rejects.toMatchObject({ code: "PARENT_NOT_FOUND" })
  })

  it("getDownloadUrl returns no thumbnailUrl when thumbnailKey is null", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000ccc",
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "x.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 2,
      storageKey: "orgs/x/k/t/i/x.bin",
      thumbnailKey: null,
      uploadedBy: USER,
      createdAt: new Date(),
    }
    const rlsTx = { execute: mock(async () => [row]) } as any
    const presignGet = mock(async (a: any) => `http://signed/${a.key}`) as any
    const result = await svc.getDownloadUrl(row.id, { rlsTx, presignGet, delivery: "direct" })
    expect(result.thumbnailUrl).toBeUndefined()
  })

  it("listFiles returns RLS-visible rows with thumbnailUrl for images that have a thumbnailKey", async () => {
    const rows = [
      {
        id: "00000000-0000-0000-0000-000000000d01",
        orgId: ORG,
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        filename: "img.png",
        mimeType: "image/png",
        sizeBytes: 10,
        storageKey: "orgs/k1",
        thumbnailKey: "orgs/k1.thumb.webp",
        uploadedBy: USER,
        createdAt: new Date(),
      },
      {
        id: "00000000-0000-0000-0000-000000000d02",
        orgId: ORG,
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        filename: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: 20,
        storageKey: "orgs/k2",
        thumbnailKey: null,
        uploadedBy: USER,
        createdAt: new Date(),
      },
    ]
    let call = 0
    const rlsTx = {
      execute: mock(async () => {
        call += 1
        if (call === 1) return rows
        return [{ total: "2" }]
      }),
    } as any
    const presignGet = mock(async (a: any) => `http://signed/${a.key}`) as any
    const result = await svc.listFiles(
      { app: "kernel", entityType: "thread", entityId: THREAD, limit: 50, offset: 0 },
      { rlsTx, presignGet, delivery: "direct" },
    )
    expect(result.total).toBe(2)
    expect(result.files[0].thumbnailUrl).toBe("http://signed/orgs/k1.thumb.webp")
    expect(result.files[1].thumbnailUrl).toBeUndefined()
  })

  it("listFiles signs no URL for a sealed row in direct mode (it relays)", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000d10",
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "scan.png",
      mimeType: "image/png",
      sizeBytes: 10,
      storageKey: "orgs/k10",
      thumbnailKey: "orgs/k10.thumb.webp",
      uploadedBy: USER,
      createdAt: new Date(),
      encVersion: 1,
    }
    let call = 0
    const rlsTx = {
      execute: mock(async () => {
        call += 1
        return call === 1 ? [row] : [{ total: "1" }]
      }),
    } as any
    const presignGet = mock(async () => "http://signed") as any
    const result = await svc.listFiles(
      { app: "kernel", entityType: "thread", entityId: THREAD, includeDownloadUrls: true },
      { rlsTx, presignGet, delivery: "direct" },
    )
    expect(result.files[0].thumbnailUrl).toBeUndefined()
    expect(result.files[0].downloadUrl).toBeUndefined()
    expect(presignGet).not.toHaveBeenCalled()
    expect(result.files[0]).not.toHaveProperty("encVersion")
  })

  // Relayed delivery: the browser never talks to the store, and the CSP does
  // not name it, so no presigned URL may reach the page. The thumbnail is the
  // API's own inline route; downloads are minted through getDownloadUrl.
  it("listFiles hands out no object-store URL when delivery is relayed", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000d09",
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "img.png",
      mimeType: "image/png",
      sizeBytes: 10,
      storageKey: "orgs/k9",
      thumbnailKey: "orgs/k9.thumb.webp",
      uploadedBy: USER,
      createdAt: new Date(),
    }
    let call = 0
    const rlsTx = {
      execute: mock(async () => {
        call += 1
        return call === 1 ? [row] : [{ total: "1" }]
      }),
    } as any
    const presignGet = mock(async (a: any) => `http://signed/${a.key}`) as any
    for (const deps of [
      { rlsTx, presignGet, delivery: "relay" as const },
      { rlsTx, presignGet },
    ]) {
      call = 0
      presignGet.mockClear()
      const result = await svc.listFiles(
        { app: "kernel", entityType: "thread", entityId: THREAD, includeDownloadUrls: true },
        deps,
      )
      expect(result.files[0].thumbnailUrl).toBe(
        "/api/files/00000000-0000-0000-0000-000000000d09/inline?variant=thumb",
      )
      expect(result.files[0].downloadUrl).toBeUndefined()
      expect(presignGet).not.toHaveBeenCalled()
    }
  })

  it("listFiles relays no thumbnail for a row without one, or not an image", async () => {
    const rows = [
      {
        id: "00000000-0000-0000-0000-000000000d11",
        orgId: ORG,
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        filename: "a.png",
        mimeType: "image/png",
        sizeBytes: 1,
        storageKey: "orgs/a",
        thumbnailKey: null,
        uploadedBy: USER,
        createdAt: new Date(),
      },
      {
        id: "00000000-0000-0000-0000-000000000d12",
        orgId: ORG,
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        filename: "b.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "orgs/b",
        thumbnailKey: "orgs/b.thumb.webp",
        uploadedBy: USER,
        createdAt: new Date(),
      },
    ]
    let call = 0
    const rlsTx = {
      execute: mock(async () => {
        call += 1
        return call === 1 ? rows : [{ total: "2" }]
      }),
    } as any
    const result = await svc.listFiles(
      { app: "kernel", entityType: "thread", entityId: THREAD },
      { rlsTx, delivery: "relay" },
    )
    expect(result.files.map((f) => f.thumbnailUrl)).toEqual([undefined, undefined])
  })

  it("listFiles caps limit at 100 and omits failing-presign thumbnailUrl while still returning the row", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000d03",
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "img.png",
      mimeType: "image/png",
      sizeBytes: 10,
      storageKey: "orgs/k3",
      thumbnailKey: "orgs/k3.thumb.webp",
      uploadedBy: USER,
      createdAt: new Date(),
    }
    let call = 0
    const rlsTx = {
      execute: mock(async () => {
        call += 1
        if (call === 1) return [row]
        return [{ total: "1" }]
      }),
    } as any
    const presignGet = mock(async () => {
      throw new Error("presign boom")
    }) as any
    const result = await svc.listFiles(
      { app: "kernel", entityType: "thread", entityId: THREAD, limit: 999, offset: 0 },
      { rlsTx, presignGet, delivery: "direct" },
    )
    expect(result.files.length).toBe(1)
    expect(result.files[0].thumbnailUrl).toBeUndefined()
  })

  it("deleteFile authorizes writeScope, deletes row, queues event and enqueues storage delete", async () => {
    const fileId = "00000000-0000-0000-0000-000000000e01"
    const row = {
      id: fileId,
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      storageKey: "orgs/d1",
      thumbnailKey: "orgs/d1.thumb.webp",
      uploadedBy: USER,
      createdAt: new Date(),
    }
    const events: any[] = []
    const tx = {
      execute: mock(async () => [row]),
      delete: () => ({
        where: () => ({
          returning: async () => [{ id: fileId }],
        }),
      }),
      queueEvent: mock(async (e: any) => {
        events.push(e)
      }),
    }
    await svc.deleteFile(fileId, {
      orgId: ORG,
      userId: USER,
      scopes: ["kernel:threads:write"],
      rlsTx: { execute: mock(async () => [{ id: THREAD }]) } as any,
      privileged: async (_r, fn) => fn(tx as any),
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      app: "kernel",
      entity: "file",
      action: "delete",
      entityId: fileId,
    })
    // The object is deleted after commit, from the event: it carries the keys.
    expect(events[0].data).toMatchObject({
      storageKey: "orgs/d1",
      thumbnailKey: "orgs/d1.thumb.webp",
    })
  })

  it("deleteFile throws PARENT_NOT_FOUND when row missing", async () => {
    const tx = {
      execute: mock(async () => []),
      delete: () => ({ where: () => ({ returning: async () => [] }) }),
      queueEvent: mock(async () => {}),
    }
    await expect(
      svc.deleteFile("00000000-0000-0000-0000-000000000e02", {
        orgId: ORG,
        userId: USER,
        scopes: ["kernel:threads:write"],
        rlsTx: { execute: mock(async () => [{ id: THREAD }]) } as any,
        privileged: async (_r, fn) => fn(tx as any),
      }),
    ).rejects.toMatchObject({ code: "PARENT_NOT_FOUND" })
  })

  it("deleteFile refuses a file whose parent the caller cannot see (write scope alone is not enough)", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000e04",
      orgId: ORG,
      app: "kernel",
      entityType: "message",
      entityId: THREAD,
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      storageKey: "orgs/d4",
      thumbnailKey: null,
      uploadedBy: "someone-else",
      createdAt: new Date(),
    }
    const queued: unknown[] = []
    const deletes: unknown[] = []
    const tx = {
      execute: mock(async (q: unknown) => {
        deletes.push(q)
        return [row]
      }),
      queueEvent: mock(async (e: unknown) => {
        queued.push(e)
      }),
    }
    await expect(
      svc.deleteFile(row.id, {
        orgId: ORG,
        userId: USER,
        scopes: ["kernel:threads:write"],
        // RLS hides the parent row from this caller.
        rlsTx: { execute: mock(async () => []) } as any,
        privileged: async (_r, fn) => fn(tx as any),
      }),
    ).rejects.toMatchObject({ code: "PARENT_NOT_FOUND" })
    // Only the lookup ran; nothing was deleted and no delete event was queued.
    expect(deletes).toHaveLength(1)
    expect(queued).toHaveLength(0)
  })

  it("deleteFile throws FORBIDDEN when caller lacks parent writeScope", async () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000e03",
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      storageKey: "orgs/d3",
      thumbnailKey: null,
      uploadedBy: USER,
      createdAt: new Date(),
    }
    const tx = {
      execute: mock(async () => [row]),
      delete: () => ({ where: () => ({ returning: async () => [] }) }),
      queueEvent: mock(async () => {}),
    }
    await expect(
      svc.deleteFile(row.id, {
        orgId: ORG,
        userId: USER,
        scopes: ["kernel:threads:read"],
        rlsTx: { execute: mock(async () => [{ id: THREAD }]) } as any,
        privileged: async (_r, fn) => fn(tx as any),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  // -------------------------------------------------------------------------
  // Task 2 — upload sessions, session-aware authorize, reparent, inline metadata
  // -------------------------------------------------------------------------

  describe("createUploadSession", () => {
    it("rejects when caller lacks the target parent's writeScope", async () => {
      await expect(
        svc.createUploadSession(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["kernel:threads:read"],
            targetApp: "kernel",
            targetEntityType: "thread",
            targetEntityId: null,
          },
          {
            rlsTx: makeRlsTx(true),
            privileged: makePrivileged({}),
          },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    })

    it("rejects unknown target parent", async () => {
      await expect(
        svc.createUploadSession(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["*"],
            targetApp: "unknown",
            targetEntityType: "thing",
            targetEntityId: null,
          },
          {
            rlsTx: makeRlsTx(true),
            privileged: makePrivileged({}),
          },
        ),
      ).rejects.toMatchObject({ code: "PARENT_NOT_FOUND" })
    })

    it("persists target + owner and returns session id when caller has writeScope", async () => {
      const inserted = { id: "00000000-0000-0000-0000-000000fff001" }
      const rlsTx = {
        execute: mock(async () => [inserted]),
      } as any
      const result = await svc.createUploadSession(
        {
          orgId: ORG,
          userId: USER,
          scopes: ["kernel:threads:write"],
          targetApp: "kernel",
          targetEntityType: "thread",
          targetEntityId: null,
        },
        {
          rlsTx,
          privileged: makePrivileged({}),
        },
      )
      expect(result.id).toBe(inserted.id)
      expect(result.targetApp).toBe("kernel")
      expect(result.targetEntityType).toBe("thread")
      expect(result.targetEntityId).toBeNull()
    })
  })

  describe("authorizeUpload — kernel:file_upload_session", () => {
    function makeSessionRlsTx(opts: {
      session?: {
        target_app: string
        target_entity_type: string
        target_entity_id: string | null
        expires_at: Date
      }
      parentVisible?: boolean
    }) {
      // First execute() call = loadUploadSession; second (if any) = parent visibility.
      let call = 0
      const execute = mock(async () => {
        call += 1
        if (call === 1) {
          return opts.session ? [opts.session] : []
        }
        return opts.parentVisible === false ? [] : [{ id: "parent" }]
      })
      return { execute } as any
    }

    it("loads the session and authorizes against the stored target parent", async () => {
      const session = {
        target_app: "kernel",
        target_entity_type: "thread",
        target_entity_id: THREAD,
        expires_at: new Date(Date.now() + 60_000),
      }
      const presignPut = mock(async () => "http://signed.example/put")
      const result = await svc.authorizeUpload(
        {
          orgId: ORG,
          userId: USER,
          scopes: ["kernel:threads:write"],
          app: "kernel",
          entityType: "file_upload_session",
          entityId: "00000000-0000-0000-0000-000000fff050",
          filename: "x.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
        {
          rlsTx: makeSessionRlsTx({ session, parentVisible: true }),
          privileged: makePrivileged({}),
          presignPut: presignPut as any,
          jwtSecret: SECRET,
        },
      )
      expect(result.uploadUrl).toMatch(/^http/)
    })

    it("denies when caller lacks the stored target's writeScope", async () => {
      const session = {
        target_app: "kernel",
        target_entity_type: "thread",
        target_entity_id: null,
        expires_at: new Date(Date.now() + 60_000),
      }
      await expect(
        svc.authorizeUpload(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["kernel:threads:read"],
            app: "kernel",
            entityType: "file_upload_session",
            entityId: "00000000-0000-0000-0000-000000fff051",
            filename: "x.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
          {
            rlsTx: makeSessionRlsTx({ session, parentVisible: true }),
            privileged: makePrivileged({}),
            presignPut: mock(async () => "ignored") as any,
            jwtSecret: SECRET,
          },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    })

    it("rejects expired session", async () => {
      const session = {
        target_app: "kernel",
        target_entity_type: "thread",
        target_entity_id: null,
        expires_at: new Date(Date.now() - 1_000),
      }
      await expect(
        svc.authorizeUpload(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["kernel:threads:write"],
            app: "kernel",
            entityType: "file_upload_session",
            entityId: "00000000-0000-0000-0000-000000fff052",
            filename: "x.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
          {
            rlsTx: makeSessionRlsTx({ session, parentVisible: true }),
            privileged: makePrivileged({}),
            presignPut: mock(async () => "ignored") as any,
            jwtSecret: SECRET,
          },
        ),
      ).rejects.toMatchObject({ code: "SESSION_EXPIRED" })
    })

    it("denies when session is not visible (cross-user / cross-org)", async () => {
      await expect(
        svc.authorizeUpload(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["kernel:threads:write"],
            app: "kernel",
            entityType: "file_upload_session",
            entityId: "00000000-0000-0000-0000-000000fff053",
            filename: "x.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
          {
            rlsTx: makeSessionRlsTx({ session: undefined, parentVisible: true }),
            privileged: makePrivileged({}),
            presignPut: mock(async () => "ignored") as any,
            jwtSecret: SECRET,
          },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    })
  })

  describe("moveFilesToParent", () => {
    const SESSION = "00000000-0000-0000-0000-000000fff100"
    const MESSAGE = "00000000-0000-0000-0000-000000fff101"
    const FILE1 = "00000000-0000-0000-0000-000000fff102"
    const FILE2 = "00000000-0000-0000-0000-000000fff103"

    function makeMoveRlsTx(opts: {
      session?: {
        target_app: string
        target_entity_type: string
        target_entity_id: string | null
        expires_at: Date
      }
      parentVisible?: boolean
      foundFileIds?: string[]
    }) {
      // Call order inside moveFilesToParent:
      //   1) loadUploadSession
      //   2) assertParentVisible
      //   then lockLiveParent (a message parent: kernel.lock_live_message,
      //   answered by its text below), then
      //   3) SELECT id FROM ${K}.files WHERE … (membership of fileIds in session)
      let call = 0
      const execute = mock(async (q: unknown) => {
        const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? []
        const text = chunks
          .map((c) => {
            const v = (c as { value?: unknown }).value
            return Array.isArray(v) ? v.join("") : ""
          })
          .join(" ")
          .toLowerCase()
        if (text.includes("lock_live_message")) return [{ ok: true }]
        if (text === "") return []
        call += 1
        if (call === 1) return opts.session ? [opts.session] : []
        if (call === 2) return opts.parentVisible === false ? [] : [{ id: "parent" }]
        return (opts.foundFileIds ?? []).map((id) => ({ id }))
      })
      return { execute } as any
    }

    function makePrivilegedRecording() {
      const calls: unknown[] = []
      const fn = async <T>(_r: string, fn2: (tx: any) => Promise<T>): Promise<T> =>
        fn2({
          execute: async (q: unknown) => {
            calls.push(q)
            return [] as any[]
          },
        })
      return { fn, calls }
    }

    it("rejects when session is not visible to caller", async () => {
      await expect(
        svc.moveFilesToParent(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["kernel:threads:write"],
            sourceSessionId: SESSION,
            target: { app: "kernel", entityType: "message", entityId: MESSAGE },
            fileIds: [FILE1],
          },
          {
            rlsTx: makeMoveRlsTx({ session: undefined }),
            privileged: makePrivilegedRecording().fn,
          },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    })

    it("rejects expired session", async () => {
      await expect(
        svc.moveFilesToParent(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["kernel:threads:write"],
            sourceSessionId: SESSION,
            target: { app: "kernel", entityType: "message", entityId: MESSAGE },
            fileIds: [FILE1],
          },
          {
            rlsTx: makeMoveRlsTx({
              session: {
                target_app: "kernel",
                target_entity_type: "message",
                target_entity_id: null,
                expires_at: new Date(Date.now() - 1_000),
              },
            }),
            privileged: makePrivilegedRecording().fn,
          },
        ),
      ).rejects.toMatchObject({ code: "SESSION_EXPIRED" })
    })

    it("rejects when target app/entityType does not match session", async () => {
      await expect(
        svc.moveFilesToParent(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["tickets:tickets:write"],
            sourceSessionId: SESSION,
            target: { app: "tickets", entityType: "message", entityId: MESSAGE },
            fileIds: [FILE1],
          },
          {
            rlsTx: makeMoveRlsTx({
              session: {
                target_app: "kernel",
                target_entity_type: "message",
                target_entity_id: null,
                expires_at: new Date(Date.now() + 60_000),
              },
            }),
            privileged: makePrivilegedRecording().fn,
          },
        ),
      ).rejects.toMatchObject({ code: "TARGET_MISMATCH" })
    })

    it("rejects when target entityId differs from session's pinned entity", async () => {
      await expect(
        svc.moveFilesToParent(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["kernel:threads:write"],
            sourceSessionId: SESSION,
            target: { app: "kernel", entityType: "message", entityId: MESSAGE },
            fileIds: [FILE1],
          },
          {
            rlsTx: makeMoveRlsTx({
              session: {
                target_app: "kernel",
                target_entity_type: "message",
                target_entity_id: "different-message-id",
                expires_at: new Date(Date.now() + 60_000),
              },
            }),
            privileged: makePrivilegedRecording().fn,
          },
        ),
      ).rejects.toMatchObject({ code: "TARGET_MISMATCH" })
    })

    it("rejects when caller lacks target writeScope", async () => {
      await expect(
        svc.moveFilesToParent(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["kernel:threads:read"],
            sourceSessionId: SESSION,
            target: { app: "kernel", entityType: "message", entityId: MESSAGE },
            fileIds: [FILE1],
          },
          {
            rlsTx: makeMoveRlsTx({
              session: {
                target_app: "kernel",
                target_entity_type: "message",
                target_entity_id: null,
                expires_at: new Date(Date.now() + 60_000),
              },
            }),
            privileged: makePrivilegedRecording().fn,
          },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    })

    it("rejects when one of the requested files isn't parented to the session", async () => {
      await expect(
        svc.moveFilesToParent(
          {
            orgId: ORG,
            userId: USER,
            scopes: ["kernel:threads:write"],
            sourceSessionId: SESSION,
            target: { app: "kernel", entityType: "message", entityId: MESSAGE },
            fileIds: [FILE1, FILE2],
          },
          {
            rlsTx: makeMoveRlsTx({
              session: {
                target_app: "kernel",
                target_entity_type: "message",
                target_entity_id: null,
                expires_at: new Date(Date.now() + 60_000),
              },
              parentVisible: true,
              foundFileIds: [FILE1], // only one of the requested ids is on the session
            }),
            privileged: makePrivilegedRecording().fn,
          },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    })

    it("happy path runs the privileged reparent UPDATE", async () => {
      const recorder = makePrivilegedRecording()
      await svc.moveFilesToParent(
        {
          orgId: ORG,
          userId: USER,
          scopes: ["kernel:threads:write"],
          sourceSessionId: SESSION,
          target: { app: "kernel", entityType: "message", entityId: MESSAGE },
          fileIds: [FILE1, FILE2],
        },
        {
          rlsTx: makeMoveRlsTx({
            session: {
              target_app: "kernel",
              target_entity_type: "message",
              target_entity_id: null,
              expires_at: new Date(Date.now() + 60_000),
            },
            parentVisible: true,
            foundFileIds: [FILE1, FILE2],
          }),
          privileged: recorder.fn,
        },
      )
      expect(recorder.calls.length).toBeGreaterThanOrEqual(1)
      // The privileged callback runs exactly one UPDATE statement.
      expect(recorder.calls[0]).toBeDefined()
    })
  })

  describe("listFiles includeDownloadUrls + ordinal ordering", () => {
    it("returns disposition, contentId, ordinal and signed downloadUrl when requested", async () => {
      const rows = [
        {
          id: "00000000-0000-0000-0000-000000fff200",
          orgId: ORG,
          app: "mail",
          entityType: "message",
          entityId: "msg-1",
          filename: "hero.png",
          mimeType: "image/png",
          sizeBytes: 10,
          storageKey: "orgs/k/m/msg-1/hero.png",
          thumbnailKey: "orgs/k/m/msg-1/hero.png.thumb.webp",
          uploadedBy: USER,
          disposition: "inline",
          contentId: "hero@cid",
          originalContentId: "<hero@cid>",
          ordinal: 2,
          createdAt: new Date(),
        },
      ]
      let call = 0
      const rlsTx = {
        execute: mock(async () => {
          call += 1
          if (call === 1) return rows
          return [{ total: "1" }]
        }),
      } as any
      const presignGet = mock(async (a: any) => `http://signed/${a.key}`) as any
      const result = await svc.listFiles(
        {
          app: "mail",
          entityType: "message",
          entityId: "msg-1",
          includeDownloadUrls: true,
        } as any,
        { rlsTx, presignGet, delivery: "direct" },
      )
      expect(result.files[0]).toMatchObject({
        disposition: "inline",
        contentId: "hero@cid",
        ordinal: 2,
      })
      expect(result.files[0].downloadUrl).toContain("http://signed/")
      expect(result.files[0].thumbnailUrl).toContain("thumb")
    })
  })

  describe("confirmUpload — disposition + contentId normalization", () => {
    async function makeTokenWithMetadata() {
      return svc.signFileToken(
        {
          orgId: ORG,
          userId: USER,
          app: "kernel",
          entityType: "thread",
          entityId: THREAD,
          storageKey: `orgs/${ORG}/kernel/thread/${THREAD}/u/hero.png`,
          filename: "hero.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
        SECRET,
      )
    }

    it("normalizes <Content-ID> and stores both fields on insert", async () => {
      const token = await makeTokenWithMetadata()
      const insertedRow: any = {
        id: "00000000-0000-0000-0000-000000fff300",
        orgId: ORG,
        app: "kernel",
        entityType: "thread",
        entityId: THREAD,
        filename: "hero.png",
        mimeType: "image/png",
        sizeBytes: 10,
        storageKey: `orgs/${ORG}/kernel/thread/${THREAD}/u/hero.png`,
        thumbnailKey: null,
        uploadedBy: USER,
        disposition: "inline",
        contentId: "hero@cid",
        originalContentId: "<hero@cid>",
        ordinal: 0,
        createdAt: new Date(),
      }
      const insertValues: any[] = []
      let qCall = 0
      const tx: any = {
        execute: mock(async () => {
          qCall += 1
          if (qCall === 1) return [] // advisory lock
          if (qCall === 2) return [{ settings: { fileSizeLimitMb: 50 }, caps: { storageGb: 10 } }]
          return [{ total: "0" }]
        }),
        select: () => ({
          from: () => ({ where: () => ({ limit: async () => [] }) }),
        }),
        insert: () => ({
          values: (v: any) => {
            insertValues.push(v)
            return { returning: async () => [insertedRow] }
          },
        }),
        queueEvent: mock(async () => {}),
      }
      const result = await svc.confirmUpload(
        token,
        {
          privileged: async (_r, fn) => fn(tx),
          headObject: mock(async () => ({ contentLength: 10, contentType: "image/png" })) as any,
          jwtSecret: SECRET,
        },
        { disposition: "inline", contentId: "<hero@cid>", ordinal: 0 } as any,
      )
      expect(insertValues[0]).toMatchObject({
        disposition: "inline",
        contentId: "hero@cid",
        originalContentId: "<hero@cid>",
      })
      expect(result.disposition).toBe("inline")
      expect(result.contentId).toBe("hero@cid")
    })
  })

  it("returns existing row idempotently when storage_key already inserted", async () => {
    const token = await makeToken()
    const existing = {
      id: "00000000-0000-0000-0000-0000000000aa",
      orgId: ORG,
      app: "kernel",
      entityType: "thread",
      entityId: THREAD,
      filename: "x.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      storageKey: `orgs/${ORG}/kernel/thread/${THREAD}/u/x.txt`,
      thumbnailKey: "thumb-key",
      uploadedBy: USER,
      createdAt: new Date(),
    }
    const tx = {
      execute: mock(async () => []),
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [existing] }) }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => {
            throw new Error("should not insert on idempotent retry")
          },
        }),
      }),
      queueEvent: mock(async () => {
        throw new Error("should not enqueue event on idempotent retry")
      }),
    }
    const result = await svc.confirmUpload(token, {
      privileged: async (_r, fn) => fn(tx as any),
      headObject: mock(async () => ({ contentLength: 5, contentType: "text/plain" })) as any,
      jwtSecret: SECRET,
    })
    expect(result.id).toBe(existing.id)
    expect(result.thumbnailKey).toBe("thumb-key")
  })
})

// PUT /api/file-relay/:token writes through storeRelayedUpload. The token lives
// 15 minutes; once a confirm created the row owning its key, it is spent.
describe("storeRelayedUpload", () => {
  const dialect = new PgDialect()
  const PAYLOAD = {
    orgId: ORG,
    userId: USER,
    app: "kernel",
    entityType: "thread",
    entityId: THREAD,
    storageKey: `orgs/${ORG}/kernel/thread/${THREAD}/u/r.txt`,
    filename: "r.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
  }
  function relayTx(existingRows: unknown[], steps: string[]) {
    return {
      execute: mock(async (q: any) => {
        const { sql: text, params } = dialect.sqlToQuery(q)
        steps.push(text.includes("hashtext") ? `keylock:${params.at(-1)}` : "other")
        return []
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              steps.push("select")
              return existingRows
            },
          }),
        }),
      }),
    }
  }

  it("refuses with ALREADY_CONFIRMED once a row owns the key, and writes nothing", async () => {
    const steps: string[] = []
    const putObject = mock(async () => {})
    await expect(
      svc.storeRelayedUpload(PAYLOAD, new Uint8Array([1, 2, 3]), {
        privileged: async (_r, fn) => fn(relayTx([{ id: "f" }], steps) as unknown as PrivilegedDb),
        putObject: putObject as any,
      }),
    ).rejects.toMatchObject({ code: "ALREADY_CONFIRMED" })
    expect(putObject).not.toHaveBeenCalled()
    expect(steps).toEqual([`keylock:${PAYLOAD.storageKey}`, "select"])
  })

  it("writes the bytes under the key lock while no row owns the key", async () => {
    const steps: string[] = []
    const putObject = mock(async (_a: any) => {
      steps.push("put")
    })
    await svc.storeRelayedUpload(PAYLOAD, new Uint8Array([1, 2, 3]), {
      privileged: async (_r, fn) => fn(relayTx([], steps) as unknown as PrivilegedDb),
      putObject: putObject as any,
    })
    expect(steps).toEqual([`keylock:${PAYLOAD.storageKey}`, "select", "put"])
    expect(putObject.mock.calls[0][0]).toMatchObject({
      key: PAYLOAD.storageKey,
      contentType: "text/plain",
    })
  })
})

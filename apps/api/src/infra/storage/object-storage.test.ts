// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it, mock } from "bun:test"

type StorageModule = typeof import("./object-storage")
let storage: StorageModule

beforeAll(async () => {
  storage = await import("./object-storage")
})

function mockS3Send(behavior: (cmd: any) => any) {
  const send = mock(async (cmd: any) => behavior(cmd))
  return { send } as any
}

describe("object-storage — pure helpers", () => {
  it("rewritePublicHost preserves path and query when public URL is set", () => {
    const rewritten = storage.rewritePublicHostFor(
      "http://localhost:9000/liaison-test/some/key?X-Amz-Signature=abc",
      "http://cdn.example.test",
    )
    expect(rewritten.startsWith("http://cdn.example.test/liaison-test/some/key?")).toBe(true)
    expect(rewritten).toContain("X-Amz-Signature=abc")
  })

  it("rewritePublicHost is a no-op when public URL is empty/undefined", () => {
    const original = "http://localhost:9000/liaison-test/x?sig=1"
    expect(storage.rewritePublicHostFor(original, undefined)).toBe(original)
    expect(storage.rewritePublicHostFor(original, "")).toBe(original)
  })

  it("sanitizeFilename strips path separators and limits length", () => {
    expect(storage.sanitizeFilename("../../etc/passwd")).toBe("passwd")
    expect(storage.sanitizeFilename("a\\b\\c.txt")).toBe("c.txt")
    expect(storage.sanitizeFilename("")).toBe("file")
    const long = `${"x".repeat(400)}.txt`
    const out = storage.sanitizeFilename(long)
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(255)
  })
})

// listOrgPrefix accepts only an org uuid (orgPrefix).
const LIST_ORG = "00000000-0000-0000-0000-00000000a11a"

describe("object-storage — S3 interactions (mocked)", () => {
  it("headObject returns size and content-type", async () => {
    const s3 = mockS3Send(() => ({ ContentLength: 5, ContentType: "text/plain" }))
    const head = await storage.headObject("orgs/test/probe.txt", { s3 })
    expect(head.contentLength).toBe(5)
    expect(head.contentType).toBe("text/plain")
  })

  it("headObject defaults content-type when missing", async () => {
    const s3 = mockS3Send(() => ({ ContentLength: 0 }))
    const head = await storage.headObject("k", { s3 })
    expect(head.contentType).toBe("application/octet-stream")
  })

  it("deleteObjects chunks batches of >1000 keys", async () => {
    const seen: number[] = []
    const s3 = mockS3Send((cmd: any) => {
      seen.push(cmd.input.Delete.Objects.length)
      return {}
    })
    const keys = Array.from({ length: 2300 }, (_, i) => `k/${i}`)
    await storage.deleteObjects(keys, { s3 })
    expect(seen).toEqual([1000, 1000, 300])
  })

  it("deleteObjects no-op on empty list", async () => {
    const s3 = mockS3Send(() => {
      throw new Error("should not call")
    })
    await expect(storage.deleteObjects([], { s3 })).resolves.toBeUndefined()
  })

  it("listOrgPrefix iterates pages via continuation token", async () => {
    const pages = [
      {
        Contents: [
          { Key: `orgs/${LIST_ORG}/a`, LastModified: new Date("2026-01-01") },
          { Key: `orgs/${LIST_ORG}/b`, LastModified: new Date("2026-01-02") },
        ],
        IsTruncated: true,
        NextContinuationToken: "t1",
      },
      {
        Contents: [{ Key: `orgs/${LIST_ORG}/c`, LastModified: new Date("2026-01-03") }],
        IsTruncated: false,
      },
    ]
    let i = 0
    const s3 = mockS3Send(() => pages[i++])
    const out = await storage.listOrgPrefix({ orgId: LIST_ORG }, { s3 })
    expect(out.objects.map((o) => o.Key)).toEqual([
      `orgs/${LIST_ORG}/a`,
      `orgs/${LIST_ORG}/b`,
      `orgs/${LIST_ORG}/c`,
    ])
  })

  it("listOrgPrefix respects maxKeys", async () => {
    const s3 = mockS3Send(() => ({
      Contents: [{ Key: "k1" }, { Key: "k2" }, { Key: "k3" }],
      IsTruncated: false,
    }))
    const out = await storage.listOrgPrefix({ orgId: LIST_ORG, maxKeys: 2 }, { s3 })
    expect(out.objects.length).toBe(2)
  })

  it("deleteInstancePrefix lists an instance folder and deletes what it holds", async () => {
    const calls: Array<{ name: string; input: any }> = []
    const s3 = mockS3Send((cmd: any) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input })
      return cmd.constructor.name === "ListObjectsV2Command"
        ? { Contents: [{ Key: "instance/apps/demo/1.0.0.liaisonapp" }], IsTruncated: false }
        : {}
    })
    expect(await storage.deleteInstancePrefix("instance/apps/demo/", { s3 })).toBe(1)
    expect(calls[0]?.input.Prefix).toBe("instance/apps/demo/")
    expect(calls[1]?.input.Delete.Objects).toEqual([{ Key: "instance/apps/demo/1.0.0.liaisonapp" }])
  })

  it("deleteInstancePrefix refuses anything but an instance folder", async () => {
    const s3 = mockS3Send(() => ({}))
    for (const bad of ["", "instance/", "orgs/x/", "instance/apps", "instance/../orgs/"]) {
      await expect(storage.deleteInstancePrefix(bad, { s3 })).rejects.toThrow(/instance folder/)
    }
  })

  it("copyObject issues a CopyObjectCommand with bucket-qualified, encoded CopySource", async () => {
    const calls: { Bucket?: string; CopySource?: string; Key?: string }[] = []
    const s3 = mockS3Send((cmd: any) => {
      calls.push(cmd.input)
      return {}
    })
    await storage.copyObject(
      {
        sourceKey: "orgs/o1/mail/message/m1/abc/Return Label.pdf",
        destKey: "orgs/o1/mail/message/m2/def/Return Label.pdf",
      },
      { s3, bucket: "liaison-files" },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].Bucket).toBe("liaison-files")
    expect(calls[0].Key).toBe("orgs/o1/mail/message/m2/def/Return Label.pdf")
    expect(calls[0].CopySource).toBe(
      "liaison-files/orgs%2Fo1%2Fmail%2Fmessage%2Fm1%2Fabc%2FReturn%20Label.pdf",
    )
  })
})

describe("object-storage — authentication mode", () => {
  const base = {
    OBJECT_STORAGE_ENDPOINT: "https://s3.eu-west-1.amazonaws.com",
    OBJECT_STORAGE_REGION: "eu-west-1",
    OBJECT_STORAGE_ACCESS_KEY: "static-key",
    OBJECT_STORAGE_SECRET_KEY: "static-secret",
    OBJECT_STORAGE_FORCE_PATH_STYLE: false,
  }

  it("keys: signs with the configured access key", () => {
    const cfg = storage.storageClientConfig({ ...base, OBJECT_STORAGE_AUTH: "keys" } as never)
    expect(cfg.credentials).toEqual({ accessKeyId: "static-key", secretAccessKey: "static-secret" })
  })

  it("aws-default: leaves credentials to the SDK chain, which presigns with them", async () => {
    const cfg = storage.storageClientConfig({
      ...base,
      OBJECT_STORAGE_AUTH: "aws-default",
    } as never)
    expect(cfg.credentials).toBeUndefined()
    // The default chain reads the environment first (the instance role comes
    // after it on the box): a presigned URL must carry THAT key, never the
    // static one from the .env.
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY }
    process.env.AWS_ACCESS_KEY_ID = "AKIACHAINTEST"
    process.env.AWS_SECRET_ACCESS_KEY = "chain-secret"
    try {
      const { S3Client } = await import("@aws-sdk/client-s3")
      const url = await storage.presignGet(
        { key: "k" },
        { s3: new S3Client(cfg), bucket: "b", publicUrl: undefined },
      )
      expect(url).toContain("X-Amz-Credential=AKIACHAINTEST")
      expect(url).not.toContain("static-key")
    } finally {
      if (saved.id === undefined) delete process.env.AWS_ACCESS_KEY_ID
      else process.env.AWS_ACCESS_KEY_ID = saved.id
      if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY
      else process.env.AWS_SECRET_ACCESS_KEY = saved.secret
    }
  })
})

// The S3 switch (OBJECT_STORAGE_AUTH=aws-default on the EC2 box) gets its
// credentials from the instance metadata service (IMDS, 169.254.169.254). The
// app's outbound guard (lib/outbound-fetch.ts) refuses link-local and private
// targets, so the storage credentials must NOT go through it: the AWS SDK
// reaches IMDS with its own HTTP client. This drives the real default chain
// against a fake IMDS on loopback (an address the guard refuses too), and
// checks that the guard still refuses IMDS for anything a user can aim.
describe("object-storage — instance-role credentials vs the outbound guard", () => {
  it("aws-default signs with the credentials IMDS serves", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (req.method === "PUT" && url.pathname === "/latest/api/token")
          return new Response("imds-token")
        if (req.headers.get("x-aws-ec2-metadata-token") !== "imds-token")
          return new Response("no token", { status: 401 })
        if (url.pathname === "/latest/meta-data/iam/security-credentials/")
          return new Response("liaison-role")
        if (url.pathname === "/latest/meta-data/iam/security-credentials/liaison-role")
          return Response.json({
            Code: "Success",
            Type: "AWS-HMAC",
            AccessKeyId: "ASIAFROMIMDS",
            SecretAccessKey: "imds-secret",
            Token: "imds-session",
            Expiration: new Date(Date.now() + 3_600_000).toISOString(),
          })
        return new Response("not found", { status: 404 })
      },
    })
    const keys = [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_CONFIG_FILE",
      "AWS_EC2_METADATA_SERVICE_ENDPOINT",
      "AWS_EC2_METADATA_DISABLED",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
    ] as const
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    for (const k of keys) delete process.env[k]
    // No environment keys and no profile: the chain must fall through to IMDS.
    process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/credentials"
    process.env.AWS_CONFIG_FILE = "/nonexistent/config"
    process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = `http://127.0.0.1:${server.port}`
    try {
      const { S3Client } = await import("@aws-sdk/client-s3")
      const cfg = storage.storageClientConfig({
        OBJECT_STORAGE_ENDPOINT: "https://s3.eu-west-1.amazonaws.com",
        OBJECT_STORAGE_REGION: "eu-west-1",
        OBJECT_STORAGE_ACCESS_KEY: "static-key",
        OBJECT_STORAGE_SECRET_KEY: "static-secret",
        OBJECT_STORAGE_FORCE_PATH_STYLE: false,
        OBJECT_STORAGE_AUTH: "aws-default",
      } as never)
      const url = await storage.presignGet(
        { key: "k" },
        { s3: new S3Client(cfg), bucket: "b", publicUrl: undefined },
      )
      expect(url).toContain("X-Amz-Credential=ASIAFROMIMDS")
      expect(url).toContain("X-Amz-Security-Token=imds-session")
    } finally {
      server.stop(true)
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  it("the outbound guard still refuses IMDS for user-aimed fetches", async () => {
    const { validateOutboundUrl, UnsafeOutboundUrlError } = await import("~/lib/outbound-fetch")
    for (const url of [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://[fd00:ec2::254]/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/latest/api/token",
    ]) {
      await expect(validateOutboundUrl(url, { requireHttps: false })).rejects.toBeInstanceOf(
        UnsafeOutboundUrlError,
      )
    }
  })
})

// A presigned URL the BROWSER uses. Signing is offline: no request leaves.
describe("object-storage — presigned URLs for direct browser delivery", () => {
  // Every existing caller (the invoicing logo upload, e2e helpers, chaos
  // seeds, the google-drive app's instructions) PUTs with Content-Type only:
  // nothing else may become a required signed header.
  it("presignPut signs exactly Content-Type and Content-Length, with the asked expiry", async () => {
    const url = new URL(
      await storage.presignPut({
        key: "orgs/o/kernel/thread/t/u/x.png",
        contentLength: 1234,
        contentType: "image/png",
        expiresInSec: 300,
      }),
    )
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";").sort()).toEqual([
      "content-length",
      "content-type",
      "host",
    ])
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300")
  })

  // The SDK's default checksum adds x-amz-checksum-crc32 of the EMPTY body it
  // sees when signing; S3 then refuses the browser's real bytes (BadDigest).
  it("presignPut carries no checksum of an empty body", async () => {
    const url = await storage.presignPut({ key: "k", contentLength: 5, contentType: "text/plain" })
    expect(url).not.toContain("x-amz-checksum")
    expect(url).not.toContain("x-amz-sdk-checksum-algorithm")
  })

  it("presignGet signs the response overrides and a short default expiry", async () => {
    const url = new URL(
      await storage.presignGet({
        key: "k",
        responseContentDisposition: 'attachment; filename="a.html"',
        responseContentType: "text/html",
        responseCacheControl: "private, max-age=60",
        responseContentEncoding: "identity",
      }),
    )
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="a.html"',
    )
    expect(url.searchParams.get("response-content-type")).toBe("text/html")
    expect(url.searchParams.get("response-cache-control")).toBe("private, max-age=60")
    expect(url.searchParams.get("response-content-encoding")).toBe("identity")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300")
    expect(url.searchParams.has("x-amz-checksum-mode")).toBe(false)
  })
})

describe("object-storage — headObject reports the stored encoding", () => {
  it("returns ContentEncoding, or null when the object has none", async () => {
    const enc = mockS3Send(() => ({
      ContentLength: 5,
      ContentType: "text/plain",
      ContentEncoding: "gzip",
    }))
    expect(await storage.headObject("k", { s3: enc, bucket: "b" })).toMatchObject({
      contentEncoding: "gzip",
    })
    const plain = mockS3Send(() => ({ ContentLength: 5, ContentType: "text/plain" }))
    expect((await storage.headObject("k", { s3: plain, bucket: "b" })).contentEncoding).toBeNull()
  })
})

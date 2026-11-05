// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { S3Client } from "@aws-sdk/client-s3"
import { browserStorageOrigin, storageDelivery } from "./delivery"
import { presignClientConfig, presignGet, presignPut } from "./object-storage"

const AWS = {
  OBJECT_STORAGE_BROWSER_DIRECT: true,
  OBJECT_STORAGE_ENDPOINT: "https://s3.eu-west-1.amazonaws.com",
  OBJECT_STORAGE_PUBLIC_URL: undefined,
  OBJECT_STORAGE_BUCKET: "acme-liaison-objects",
  OBJECT_STORAGE_FORCE_PATH_STYLE: false,
} as const

const OBJECTSTORE = {
  OBJECT_STORAGE_BROWSER_DIRECT: false,
  OBJECT_STORAGE_ENDPOINT: "http://objectstore:8333",
  OBJECT_STORAGE_PUBLIC_URL: undefined,
  OBJECT_STORAGE_BUCKET: "liaison",
  OBJECT_STORAGE_FORCE_PATH_STYLE: true,
} as const

describe("storageDelivery — the one direct-vs-relay decision", () => {
  it("relays unless the deployment says the store is browser reachable", () => {
    expect(storageDelivery({}, { OBJECT_STORAGE_BROWSER_DIRECT: false })).toBe("relay")
    expect(storageDelivery({}, { OBJECT_STORAGE_BROWSER_DIRECT: true })).toBe("direct")
  })

  it("always relays a sealed attachment", () => {
    expect(storageDelivery({ sealed: true }, { OBJECT_STORAGE_BROWSER_DIRECT: true })).toBe("relay")
  })

  it("defaults to relay (the switch is off unless set)", () => {
    expect(storageDelivery()).toBe("relay")
  })
})

describe("browserStorageOrigin — what the CSP and the bucket CORS name", () => {
  it("is null when delivery relays", () => {
    expect(browserStorageOrigin(OBJECTSTORE)).toBeNull()
    expect(browserStorageOrigin({ ...AWS, OBJECT_STORAGE_BROWSER_DIRECT: false })).toBeNull()
  })

  it("is the virtual-hosted bucket host on Amazon S3", () => {
    expect(browserStorageOrigin(AWS)).toBe(
      "https://acme-liaison-objects.s3.eu-west-1.amazonaws.com",
    )
  })

  it("is the endpoint itself for a path-style store or a dotted bucket", () => {
    expect(
      browserStorageOrigin({
        ...AWS,
        OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
        OBJECT_STORAGE_FORCE_PATH_STYLE: true,
      }),
    ).toBe("http://localhost:9000")
    expect(browserStorageOrigin({ ...AWS, OBJECT_STORAGE_BUCKET: "files.example.com" })).toBe(
      "https://s3.eu-west-1.amazonaws.com",
    )
  })

  it("is the public URL's origin when one replaces the signed host", () => {
    expect(
      browserStorageOrigin({ ...AWS, OBJECT_STORAGE_PUBLIC_URL: "https://files.example.com/x" }),
    ).toBe("https://files.example.com")
  })

  // The origin is computed, not read off a URL, so it must agree with what
  // the SDK actually signs, or the CSP would block the very PUT it is for.
  for (const [label, cfg] of [
    ["virtual-hosted", AWS],
    ["dotted bucket", { ...AWS, OBJECT_STORAGE_BUCKET: "files.example.com" }],
    [
      "path style",
      {
        ...AWS,
        OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
        OBJECT_STORAGE_FORCE_PATH_STYLE: true,
      },
    ],
  ] as const) {
    it(`matches the host of a real presigned URL (${label})`, async () => {
      const s3 = new S3Client(
        presignClientConfig({
          ...cfg,
          OBJECT_STORAGE_REGION: "eu-west-1",
          OBJECT_STORAGE_AUTH: "keys",
          OBJECT_STORAGE_ACCESS_KEY: "AKIATEST",
          OBJECT_STORAGE_SECRET_KEY: "test-secret",
        } as never),
      )
      const deps = { s3, bucket: cfg.OBJECT_STORAGE_BUCKET, publicUrl: undefined }
      const put = await presignPut({ key: "orgs/o/k", contentLength: 1, contentType: "a/b" }, deps)
      const get = await presignGet({ key: "orgs/o/k" }, deps)
      expect(new URL(put).origin).toBe(browserStorageOrigin(cfg) as string)
      expect(new URL(get).origin).toBe(browserStorageOrigin(cfg) as string)
    })
  }
})

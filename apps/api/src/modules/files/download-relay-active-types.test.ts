// SPDX-License-Identifier: FSL-1.1-ALv2
// The download relay serves an object on the app's own origin to anyone holding
// its short-lived token, with the MIME type the uploader declared. The page CSP
// allows `script-src 'self'`, so a relayed object answered as JavaScript is a
// same-origin script any later HTML injection could load past the CSP. Active
// types must be answered as inert bytes.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as objectStorage from "~/infra/storage/object-storage"
import { fileDownloadRelay } from "~/modules/files/routes"
import * as fileService from "~/modules/files/service"
import { signFileDownloadToken } from "~/modules/files/service"

const ORG = "00000000-0000-0000-0000-000000000001"
const SCRIPT_TYPES =
  /^(?:application|text)\/(?:x-)?(?:javascript|ecmascript)|^text\/html|^image\/svg\+xml|^application\/xhtml|^text\/xml|^application\/xml/i

describe("download relay and active content types", () => {
  afterEach(() => mock.restore())

  for (const declared of [
    "application/javascript",
    "text/javascript",
    "text/html",
    "image/svg+xml",
  ]) {
    it(`does not answer a relayed ${declared} object as ${declared}`, async () => {
      spyOn(fileService, "isRelayedFileServable").mockResolvedValue(true)
      const bytes = new TextEncoder().encode("alert(document.domain)")
      spyOn(objectStorage, "getObjectStream").mockResolvedValue({
        stream: new ReadableStream({
          start(c) {
            c.enqueue(bytes)
            c.close()
          },
        }),
        contentType: declared,
        contentLength: bytes.byteLength,
      })
      const token = await signFileDownloadToken({
        orgId: ORG,
        fileId: "f-js",
        storageKey: "orgs/o/x/f-js/x",
        filename: "x.js",
        mimeType: declared,
      })
      const res = await fileDownloadRelay.request(`/${token}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type") ?? "").not.toMatch(SCRIPT_TYPES)
    })
  }
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// Guards every compose file against images that can no longer be pulled, and
// pins the bundled object store to a known-good tag.
//
// MinIO can no longer be pulled at all: `minio/minio` and `minio/mc` were
// withdrawn from Docker Hub (pull access denied), and quay.io/minio/* now
// refuses anonymous pulls too — so a fresh self-host cannot bring MinIO up
// at any tag. Liaison bundles SeaweedFS instead (Apache-2.0, chrislusf/
// seaweedfs), and no compose file here may name a MinIO image at all.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")
const COMPOSE_FILES = ["docker-compose.yml", "deploy/docker-compose.yml"]
const SEAWEEDFS_TAG = "chrislusf/seaweedfs:4.48"

/** Every top-level service's `image:` value in a compose file, keyed by service name. */
function imagesByService(relativePath: string): Record<string, string> {
  const text = readFileSync(join(REPO_ROOT, relativePath), "utf8")
  const lines = text.split("\n")
  const out: Record<string, string> = {}
  let currentService: string | null = null
  for (const line of lines) {
    // A service may carry a YAML anchor (`  app: &liaison-app`).
    const serviceHeader = /^ {2}([\w-]+):(?:\s+&[\w-]+)?\s*$/.exec(line)
    if (serviceHeader) {
      currentService = serviceHeader[1]!
      continue
    }
    // Any other top-level (non-indented, or differently-indented) section —
    // e.g. `volumes:`/`networks:` at the file root — ends the current service.
    if (/^\S/.test(line)) currentService = null
    if (!currentService) continue
    const image = /^\s+image:\s*(\S+)\s*$/.exec(line)
    if (image) out[currentService] = image[1]!
  }
  return out
}

describe("compose images", () => {
  for (const file of COMPOSE_FILES) {
    it(`${file} pins the object store to the bundled SeaweedFS tag`, () => {
      const images = imagesByService(file)
      // The deployment file adds the digest (dockerfile-pins.test.ts); the tag is the same.
      expect(images.objectstore?.split("@")[0]).toBe(SEAWEEDFS_TAG)
    })

    it(`${file} never names a MinIO image`, () => {
      const images = imagesByService(file)
      for (const [, image] of Object.entries(images)) {
        expect(image).not.toMatch(/(^|\/)minio\/(minio|mc)[:@]/)
      }
    })

    it(`${file} pins every image to a tag`, () => {
      for (const image of Object.values(imagesByService(file))) {
        // A bare repository name (no tag, no interpolated variable) would
        // float on whatever `latest` happens to be on the day of a rebuild.
        if (image.startsWith("${")) continue
        expect(image).toMatch(/:[^/]+$/)
      }
    })
  }
})

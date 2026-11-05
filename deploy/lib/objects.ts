// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Object-storage half of deploy/backup.sh and deploy/restore.sh. It runs INSIDE
// the stack's own app image (`docker compose run --entrypoint bun app ...`), so
// it reaches the object store on the compose network with the app's scoped
// credentials and needs nothing installed on the host. Bun built-ins only: the
// file is mounted from the checkout, outside the image's module tree.
//
//   bun objects.ts dump  <dir>          every object of the bucket -> <dir>/data/<n>,
//                                       one JSON line per object in <dir>/index.jsonl
//   bun objects.ts load  <dir>          the reverse: put every indexed object back
//   bun objects.ts verify <dir>         read every archived object against its checksum
//                                       and list the bucket once: changes nothing
//   bun objects.ts check <dir> <key>    fetch one object and compare it with the index
//
// Objects are stored under a sequence number, never under their key: a key is
// any string the app chose, and must not become a path on the host. The index
// keeps the key, size, content type and sha256 of each object. Prints only
// counts and byte totals; exits non-zero on any failure.

import { mkdirSync } from "node:fs"
import { join } from "node:path"

interface IndexEntry {
  n: number
  key: string
  size: number
  type: string
  sha256: string
}

function client(): Bun.S3Client {
  const need = (name: string): string => {
    const v = process.env[name]
    if (!v) throw new Error(`${name} is not set in the app environment`)
    return v
  }
  return new Bun.S3Client({
    endpoint: need("OBJECT_STORAGE_ENDPOINT"),
    bucket: need("OBJECT_STORAGE_BUCKET"),
    accessKeyId: need("OBJECT_STORAGE_ACCESS_KEY"),
    secretAccessKey: need("OBJECT_STORAGE_SECRET_KEY"),
    region: process.env.OBJECT_STORAGE_REGION || "us-east-1",
    virtualHostedStyle: false,
  })
}

async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}

async function* listAll(s3: Bun.S3Client): AsyncGenerator<{ key: string; size: number }> {
  let continuationToken: string | undefined
  do {
    const page = await s3.list({ maxKeys: 1000, continuationToken })
    for (const o of page.contents ?? []) yield { key: o.key, size: o.size ?? 0 }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
  } while (continuationToken)
}

async function dump(dir: string): Promise<void> {
  const s3 = client()
  mkdirSync(join(dir, "data"), { recursive: true })
  const lines: string[] = []
  let n = 0
  let bytes = 0
  for await (const { key } of listAll(s3)) {
    const file = s3.file(key)
    const stat = await file.stat()
    const path = join(dir, "data", String(n))
    await Bun.write(path, new Response(file.stream()))
    const size = Bun.file(path).size
    if (size !== stat.size)
      throw new Error(`object #${n}: wrote ${size} bytes, store says ${stat.size}`)
    const entry: IndexEntry = { n, key, size, type: stat.type || "", sha256: await sha256Of(path) }
    lines.push(JSON.stringify(entry))
    bytes += size
    n++
  }
  await Bun.write(join(dir, "index.jsonl"), lines.length ? `${lines.join("\n")}\n` : "")
  console.log(JSON.stringify({ objects: n, bytes }))
}

async function readIndex(dir: string): Promise<IndexEntry[]> {
  const text = await Bun.file(join(dir, "index.jsonl")).text()
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as IndexEntry)
}

async function load(dir: string): Promise<void> {
  const s3 = client()
  const entries = await readIndex(dir)
  let bytes = 0
  for (const e of entries) {
    const path = join(dir, "data", String(e.n))
    const got = await sha256Of(path)
    if (got !== e.sha256) throw new Error(`object #${e.n}: checksum mismatch in the archive`)
    await s3.write(e.key, Bun.file(path), e.type ? { type: e.type } : {})
    const stat = await s3.file(e.key).stat()
    if (stat.size !== e.size)
      throw new Error(`object #${e.n}: stored ${stat.size} bytes, expected ${e.size}`)
    bytes += e.size
  }
  console.log(JSON.stringify({ objects: entries.length, bytes }))
}

async function verify(dir: string): Promise<void> {
  const entries = await readIndex(dir)
  for (const e of entries) {
    const path = join(dir, "data", String(e.n))
    if ((await sha256Of(path)) !== e.sha256)
      throw new Error(`object #${e.n}: checksum mismatch in the archive`)
  }
  // Reach the store with this host's credentials before anything is written.
  await client().list({ maxKeys: 1 })
  console.log(JSON.stringify({ objects: entries.length, store: "reachable" }))
}

async function check(dir: string, key: string): Promise<void> {
  const s3 = client()
  const entry = (await readIndex(dir)).find((e) => e.key === key)
  if (!entry) throw new Error("the sample key is not in the archive index")
  const hasher = new Bun.CryptoHasher("sha256")
  let size = 0
  for await (const chunk of s3.file(key).stream()) {
    hasher.update(chunk)
    size += chunk.byteLength
  }
  const ok = size === entry.size && hasher.digest("hex") === entry.sha256
  console.log(JSON.stringify({ sample: ok ? "ok" : "mismatch", bytes: size }))
  if (!ok) process.exit(1)
}

const [cmd, dir, key] = process.argv.slice(2)
try {
  if (cmd === "dump" && dir) await dump(dir)
  else if (cmd === "load" && dir) await load(dir)
  else if (cmd === "verify" && dir) await verify(dir)
  else if (cmd === "check" && dir && key) await check(dir, key)
  else {
    console.error("usage: bun objects.ts dump|load|verify <dir> | check <dir> <key>")
    process.exit(2)
  }
} catch (err) {
  console.error(`objects: ${(err as Error).message}`)
  process.exit(1)
}

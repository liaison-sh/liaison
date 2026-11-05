// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A streaming zip writer for the whole-org export (fflate's streaming `Zip`,
 * never `zipSync`).
 *
 * fflate has no ZIP64 and no backpressure, so this wrapper adds both halves the
 * export needs:
 *
 *  - Limits. Without ZIP64 an archive must stay under 4 GiB and 65,535
 *    entries. The writer refuses the entry that would pass either limit with
 *    `EXPORT_TOO_LARGE`, naming both numbers, before it writes a byte of it
 *    when the size is known, and as soon as the bytes pass otherwise.
 *  - A bounded queue between fflate's synchronous `ondata` and the async
 *    consumer (the object-store upload): the producer awaits after each chunk
 *    while more than `highWaterBytes` are waiting, so memory stays bounded
 *    however large the files are.
 *
 * Entries are written one at a time. Files go in stored (they are mostly
 * compressed already); NDJSON and the manifest are deflated.
 */
import { Zip, ZipDeflate, ZipPassThrough } from "fflate"
import { sanitizeFilename } from "~/infra/storage/object-storage"

/** The largest archive the zip format holds without ZIP64, less one byte. */
export const ZIP_MAX_BYTES = 4 * 1024 ** 3 - 1
/** Below the format's 65,535 entries, with room for the manifest. */
export const ZIP_MAX_ENTRIES = 65_000
const DEFAULT_HIGH_WATER = 8 * 1024 * 1024
/** Local header + data descriptor + central directory record, per entry, past the name. */
const PER_ENTRY_OVERHEAD = 30 + 16 + 46
const END_RECORD = 22

export class ExportTooLargeError extends Error {
  readonly code = "EXPORT_TOO_LARGE"
  constructor(
    readonly limits: { maxBytes: number; maxEntries: number },
    readonly reached: { bytes: number; entries: number },
  ) {
    super(
      `EXPORT_TOO_LARGE: a zip archive without ZIP64 holds at most ${limits.maxBytes + 1} bytes and ${limits.maxEntries} entries; this export reached ${reached.bytes} bytes and ${reached.entries} entries`,
    )
    this.name = "ExportTooLargeError"
  }
}

/** `files/<file-id>/<name>`: the stored name can never leave its folder. */
export function fileEntryName(fileId: string, filename: string): string {
  const base = sanitizeFilename(filename)
  return `files/${sanitizeFilename(fileId)}/${base === "." || base === ".." ? "file" : base}`
}

export interface ZipStreamOptions {
  maxBytes?: number
  maxEntries?: number
  highWaterBytes?: number
}

type Source = string | Uint8Array | AsyncIterable<Uint8Array>

export class ZipStreamWriter {
  private readonly zip: Zip
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly highWater: number
  private queue: Uint8Array[] = []
  private queued = 0
  private bytesOut = 0
  /** Central directory bytes still to come (one record per entry). */
  private centralBytes = END_RECORD
  private entries = 0
  private ended = false
  private failure: unknown = null
  private wakeConsumer: (() => void) | null = null
  private wakeProducer: (() => void) | null = null

  constructor(opts: ZipStreamOptions = {}) {
    this.maxBytes = opts.maxBytes ?? ZIP_MAX_BYTES
    this.maxEntries = opts.maxEntries ?? ZIP_MAX_ENTRIES
    this.highWater = opts.highWaterBytes ?? DEFAULT_HIGH_WATER
    this.zip = new Zip((err, data, final) => {
      if (err) {
        this.fail(err)
        return
      }
      if (data.byteLength > 0) {
        this.queue.push(data)
        this.queued += data.byteLength
        this.bytesOut += data.byteLength
      }
      if (final) this.ended = true
      this.wake()
    })
  }

  /** Bytes waiting for the consumer. */
  get queuedBytes(): number {
    return this.queued
  }

  /** Bytes fflate has produced so far. */
  get bytesWritten(): number {
    return this.bytesOut
  }

  get entryCount(): number {
    return this.entries
  }

  /** The archive bytes, for the upload. Throws the writer's failure, if any. */
  async *output(): AsyncGenerator<Uint8Array> {
    let finished = false
    try {
      for (;;) {
        if (this.failure) throw this.failure
        const next = this.queue.shift()
        if (next) {
          this.queued -= next.byteLength
          this.wake()
          yield next
          continue
        }
        if (this.ended) {
          finished = true
          return
        }
        await new Promise<void>((resolve) => {
          this.wakeConsumer = resolve
        })
      }
    } finally {
      if (!finished && !this.failure) {
        this.fail(new Error("the archive consumer stopped before the archive was complete"))
      }
    }
  }

  /** Add one entry and stream its bytes in. Resolves when the entry is written. */
  async addEntry(
    name: string,
    source: Source,
    opts: { deflate: boolean; sizeHint?: number },
  ): Promise<void> {
    this.throwIfFailed()
    const nameBytes = Buffer.byteLength(name, "utf8")
    if (this.entries + 1 > this.maxEntries) this.tooLarge(this.entries + 1)
    const reserve = this.centralBytes + PER_ENTRY_OVERHEAD + nameBytes * 2
    if (opts.sizeHint !== undefined && this.bytesOut + reserve + opts.sizeHint > this.maxBytes) {
      this.tooLarge(this.entries + 1, this.bytesOut + reserve + opts.sizeHint)
    }
    this.entries++
    this.centralBytes += 46 + nameBytes
    const file = opts.deflate ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
    this.zip.add(file)
    if (typeof source === "string" || source instanceof Uint8Array) {
      const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source
      file.push(bytes, true)
      this.checkBytes()
      await this.drain()
      return
    }
    for await (const chunk of source) {
      this.throwIfFailed()
      file.push(chunk, false)
      this.checkBytes()
      await this.drain()
    }
    file.push(new Uint8Array(0), true)
    this.checkBytes()
    await this.drain()
  }

  /** Write the central directory and close the archive. */
  async finish(): Promise<void> {
    this.throwIfFailed()
    this.zip.end()
    this.checkBytes()
    this.wake()
  }

  /** Stop: the consumer throws `err` and nothing more is written. */
  fail(err: unknown): void {
    if (this.failure) return
    this.failure = err
    try {
      this.zip.terminate()
    } catch {
      // already ended
    }
    this.wake()
  }

  private checkBytes(): void {
    if (this.bytesOut + this.centralBytes > this.maxBytes) {
      this.tooLarge(this.entries, this.bytesOut + this.centralBytes)
    }
  }

  private tooLarge(entries: number, bytes: number = this.bytesOut + this.centralBytes): never {
    const err = new ExportTooLargeError(
      { maxBytes: this.maxBytes, maxEntries: this.maxEntries },
      { bytes, entries },
    )
    this.fail(err)
    throw err
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure
  }

  private async drain(): Promise<void> {
    while (this.queued > this.highWater) {
      this.throwIfFailed()
      await new Promise<void>((resolve) => {
        this.wakeProducer = resolve
      })
    }
    this.throwIfFailed()
  }

  private wake(): void {
    const c = this.wakeConsumer
    this.wakeConsumer = null
    c?.()
    const p = this.wakeProducer
    this.wakeProducer = null
    p?.()
  }
}

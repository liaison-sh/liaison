// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reading a file after checking it, without a check-then-use gap.
//
// `stat(path)` then `readFile(path)` checks one file and may read another: the
// path can be replaced in between. These open the file once and give the
// caller the open descriptor's own stat and a reader over that descriptor
// (at most the size the stat saw), so the file checked is the file read.

import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs"
import { open } from "node:fs/promises"

// Non-blocking, so a FIFO put where a file was expected is opened (and then
// refused by its stat) instead of waiting for a writer.
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK

/** Opens `path` once and runs `use` with its stat and a reader over the same descriptor. */
export function withOpenFileSync<T>(path: string, use: (st: Stats, read: () => Buffer) => T): T {
  const fd = openSync(path, READ_FLAGS)
  try {
    const st = fstatSync(fd)
    return use(st, () => {
      const buf = Buffer.alloc(st.size)
      let off = 0
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off)
        if (n <= 0) break
        off += n
      }
      return off === st.size ? buf : buf.subarray(0, off)
    })
  } finally {
    closeSync(fd)
  }
}

/** The async form of `withOpenFileSync`. */
export async function withOpenFile<T>(
  path: string,
  use: (st: Stats, read: () => Promise<Buffer>) => Promise<T> | T,
): Promise<T> {
  const handle = await open(path, READ_FLAGS)
  try {
    const st = await handle.stat()
    return await use(st, async () => {
      const buf = Buffer.alloc(st.size)
      let off = 0
      while (off < st.size) {
        const { bytesRead } = await handle.read(buf, off, st.size - off, off)
        if (bytesRead <= 0) break
        off += bytesRead
      }
      return off === st.size ? buf : buf.subarray(0, off)
    })
  } finally {
    await handle.close()
  }
}

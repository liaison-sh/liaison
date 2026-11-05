// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reading a file the sidecar has just checked, without a check-then-use gap.
//
// A path checked with `lstat` and read again by name can be swapped for a
// symlink in between. Opening it once with O_NOFOLLOW and asking the open
// descriptor what it is (fstat) checks the very file that is read.

import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs"

/**
 * The UTF-8 text of `file` when it is a regular file (not a symlink), else
 * null. A file over `maxBytes` bytes is null, or with `truncate` its first
 * `maxBytes` bytes. `accept` sees the open file's own stat and may refuse it
 * (null). Never throws.
 */
export function readRegularFileNoFollow(
  file: string,
  maxBytes: number,
  opts: { truncate?: boolean; accept?: (st: Stats) => boolean } = {},
): string | null {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    if (opts.accept && !opts.accept(st)) return null
    if (st.size > maxBytes && !opts.truncate) return null
    const size = Math.min(st.size, maxBytes)
    const buf = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off)
      if (n <= 0) break
      off += n
    }
    return buf.toString("utf8", 0, off)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

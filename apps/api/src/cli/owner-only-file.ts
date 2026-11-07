// SPDX-License-Identifier: FSL-1.1-ALv2

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs"

/** The file can be read by more than its owner. */
export class NotOwnerOnlyError extends Error {}

/**
 * The content of a file only its owner can read. The mode is checked on the
 * open descriptor and the content read from it, so both concern the same file
 * even when the path is replaced in between.
 */
export function readOwnerOnlyFile(path: string): string {
  const fd = openSync(path, "r")
  try {
    if ((fstatSync(fd).mode & 0o077) !== 0) {
      throw new NotOwnerOnlyError(`${path} must be readable by its owner only (chmod 0600)`)
    }
    return readFileSync(fd, "utf8")
  } finally {
    closeSync(fd)
  }
}

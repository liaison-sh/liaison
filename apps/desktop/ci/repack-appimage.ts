#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Puts the PRISTINE sidecar back inside a built AppImage.
//
// WHY THIS EXISTS. linuxdeploy walks the AppDir and rewrites the rpath of
// every ELF file in it with patchelf, the Bun compiled sidecar included
// ("Setting rpath in ELF file .../Liaison.AppDir/usr/bin/liaison-sidecar to
// $ORIGIN/../lib", twice: once in its own pass and once inside the gtk
// plugin). On the runner the result does not run: dry run 34777230634
// extracted the finished AppImage and the sidecar died with SIGSEGV, exit
// 139, before printing a byte. The AppImage itself launches perfectly, so
// nothing else in the job notices, and the failure lands on a customer's
// first agent turn.
//
// Two things could produce that crash and this repack removes BOTH, which is
// why it is the fix rather than a narrower one:
//
//   1. patchelf rewriting the file. That could not be reproduced here: a Bun
//      1.3.14 binary with a 220 MB embedded asset, patchelf 0.18.0,
//      --set-rpath '$ORIGIN/../lib' applied twice, in an amd64 ubuntu:24.04
//      container, still runs. So it is not ruled IN, and it is not ruled out
//      either: the runner's binary is not this one.
//   2. the rpath itself. $ORIGIN/../lib inside the AppDir is a directory full
//      of the GTK stack linuxdeploy deployed for the Rust shell, and a Bun
//      runtime that resolves one of its own NEEDED libraries out of there
//      instead of the system is a segfault with no message. The pristine
//      binary carries no rpath at all, so the question stops being asked.
//
// The pristine bytes are the ones `prepare-sidecar.ts` produced and the ones
// the .deb, the DMG and the .exe all ship. Byte equality with that file is
// the assertion, before and after the pack, because "it runs on the runner"
// is a weaker statement than "it is the same file".
//
// HOW IT REPACKS. An AppImage is an ELF runtime with a squashfs filesystem
// concatenated onto it, and the filesystem starts where the ELF ends. So the
// runtime is taken from the original file VERBATIM (its first N bytes) and
// never rebuilt: everything appimagetool embedded in it stays exactly as
// tauri produced it, including the desktop integration behaviour and any
// update information, and no network download of a runtime is involved.
// Only the filesystem half is unpacked, edited and packed again.
//
// One thing does go stale, and it is recorded rather than hidden: the
// .digest_md5 section appimagetool embeds in the runtime describes the
// ORIGINAL bytes. It is read by AppImageUpdate's zsync delta path, which
// this distribution does not use: an installed copy updates through the tauri
// updater, which verifies the detached minisign .sig over the whole file, and
// that signature is produced AFTER this repack (the workflow's step order is
// pinned by a test).
//
// Usage:
//   bun apps/desktop/ci/repack-appimage.ts <image> --sidecar <pristine file>
//     [--sidecar-path usr/bin/liaison-sidecar] [--work <dir>]
//
// Exit 0 and "already pristine" when nothing touched the sidecar: the day
// linuxdeploy stops rewriting it, this becomes a no-op instead of a rebuild.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/** Where tauri places an externalBin inside the AppDir. */
export const DEFAULT_SIDECAR_PATH = "usr/bin/liaison-sidecar"

/** The ELF header is 64 bytes on the only class an AppImage runtime uses. */
const ELF_HEADER_BYTES = 64

/**
 * Where the squashfs filesystem starts, which is where the ELF runtime ends.
 *
 * This is the same arithmetic every AppImage tool uses (`appimage_get_elf_size`
 * in libappimage): the end of the section header table is the end of the file
 * as far as the ELF is concerned, and the payload was appended after it. It is
 * computed rather than read back with `--appimage-offset`, because running the
 * AppImage requires the AppImage's own architecture and this also has to work
 * from a test on a machine that is not it.
 */
export function appImageRuntimeSize(header: Buffer): number {
  if (header.length < ELF_HEADER_BYTES) {
    throw new Error("not an AppImage: fewer bytes than an ELF header")
  }
  if (header.subarray(0, 4).toString("latin1") !== "\x7fELF") {
    throw new Error("not an AppImage: no ELF magic at the start of the file")
  }
  if (header[4] !== 2) {
    throw new Error("not an AppImage: the runtime is not a 64 bit ELF")
  }
  // Bytes 8, 9 and 10 are the AppImage type marker ('A', 'I', type) written
  // into the ELF's padding. Type 2 is the squashfs format below.
  const marker = header.subarray(8, 10).toString("latin1")
  if (marker !== "AI") {
    throw new Error("not an AppImage: the AI magic is absent from the ELF padding")
  }
  if (header[10] !== 2) {
    throw new Error(`not a type 2 AppImage: type marker ${header[10]}`)
  }
  const sectionHeaderOffset = Number(header.readBigUInt64LE(0x28))
  const sectionHeaderSize = header.readUInt16LE(0x3a)
  const sectionHeaderCount = header.readUInt16LE(0x3c)
  return sectionHeaderOffset + sectionHeaderSize * sectionHeaderCount
}

function readHead(file: string, bytes: number): Buffer {
  const handle = openSync(file, "r")
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(handle, buffer, 0, bytes, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(handle)
  }
}

/** The offset of the payload inside an AppImage on disk, with the squashfs
 *  magic at that offset asserted: an offset that lands anywhere else means
 *  the arithmetic above no longer describes this file, and packing a new
 *  filesystem onto the wrong prefix would produce a plausible looking image
 *  that mounts nothing. */
export function payloadOffset(image: string): number {
  // Header, size and magic all read through one descriptor: one file.
  const handle = openSync(image, "r")
  try {
    const head = Buffer.alloc(ELF_HEADER_BYTES)
    const offset = appImageRuntimeSize(head.subarray(0, readSync(handle, head, 0, head.length, 0)))
    const size = fstatSync(handle).size
    if (offset <= 0 || offset >= size) {
      throw new Error(`${image}: computed payload offset ${offset} is outside the file (${size})`)
    }
    const magic = Buffer.alloc(4)
    readSync(handle, magic, 0, 4, offset)
    if (magic.toString("latin1") !== "hsqs") {
      throw new Error(
        `${image}: no squashfs filesystem at offset ${offset} (found ${magic.toString("hex")})`,
      )
    }
    return offset
  } finally {
    closeSync(handle)
  }
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (result.error) {
    throw new Error(`${command} could not be run: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}): ${output}`)
  }
}

/** The one file read back out of a packed filesystem, so the assertion is
 *  over what was WRITTEN rather than over what was about to be written. */
function extractOne(image: string, offset: number, member: string, into: string): string {
  rmSync(into, { recursive: true, force: true })
  run("unsquashfs", ["-no-progress", "-o", String(offset), "-d", into, image, member])
  const extracted = path.join(into, member)
  if (!existsSync(extracted)) {
    throw new Error(`${image} carries no ${member}`)
  }
  return extracted
}

/** The runtime prefix, then the packed filesystem, in 8 MB chunks: an AppImage
 *  is hundreds of megabytes and holding all of it in one buffer to write it is
 *  a runner that dies on memory rather than on anything real. */
function writeConcatenated(target: string, head: Buffer, tail: string): void {
  const out = openSync(target, "w")
  try {
    writeSync(out, head, 0, head.length)
    const source = openSync(tail, "r")
    try {
      const chunk = Buffer.alloc(8 * 1024 * 1024)
      for (;;) {
        const read = readSync(source, chunk, 0, chunk.length, null)
        if (read === 0) break
        writeSync(out, chunk, 0, read)
      }
    } finally {
      closeSync(source)
    }
  } finally {
    closeSync(out)
  }
}

export interface RepackOptions {
  image: string
  /** The build output every other package ships, byte for byte. */
  sidecar: string
  sidecarPath?: string
  workDir?: string
}

export interface RepackResult {
  repacked: boolean
  sidecarSha256: string
  imageSha256: string
  runtimeBytes: number
  imageBytes: number
}

export function repackAppImage(options: RepackOptions): RepackResult {
  const member = options.sidecarPath ?? DEFAULT_SIDECAR_PATH
  const image = path.resolve(options.image)
  const pristine = path.resolve(options.sidecar)
  if (!existsSync(image)) throw new Error(`no such AppImage: ${options.image}`)
  if (!existsSync(pristine)) {
    throw new Error(
      `no pristine sidecar at ${options.sidecar}: without the build output there is nothing to compare the shipped bytes with, and an unverified AppImage must not ship`,
    )
  }

  // A fresh, private directory of its own (mkdtemp), never a guessable name.
  const work = options.workDir ?? mkdtempSync(path.join(tmpdir(), "appimage-repack-"))
  if (options.workDir) {
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
  }
  try {
    const offset = payloadOffset(image)
    const wanted = sha256(pristine)

    const inspected = extractOne(image, offset, member, path.join(work, "inspect"))
    if (sha256(inspected) === wanted) {
      return {
        repacked: false,
        sidecarSha256: wanted,
        imageSha256: sha256(image),
        runtimeBytes: offset,
        imageBytes: statSync(image).size,
      }
    }

    // The whole filesystem, this time, because it is the thing being rebuilt.
    const root = path.join(work, "root")
    rmSync(root, { recursive: true, force: true })
    run("unsquashfs", ["-no-progress", "-o", String(offset), "-d", root, image])
    const target = path.join(root, member)
    if (!existsSync(target)) throw new Error(`${image} carries no ${member}`)
    copyFileSync(pristine, target)
    chmodSync(target, 0o755)

    // gzip and 128K blocks are appimagetool's own defaults, which is what
    // every AppImage runtime in the wild is known to mount. -all-root because
    // the runner's uid must not end up baked into a package.
    const filesystem = path.join(work, "payload.squashfs")
    run("mksquashfs", [
      root,
      filesystem,
      "-noappend",
      "-no-progress",
      "-all-root",
      "-no-xattrs",
      "-comp",
      "gzip",
      "-b",
      "128K",
    ])

    // The runtime, verbatim, then the new filesystem. Written beside the
    // original and moved into place, so a failure half way through leaves the
    // original file rather than a truncated one.
    const rebuilt = path.join(work, "rebuilt.AppImage")
    const runtime = readHead(image, offset)
    if (runtime.length !== offset) {
      throw new Error(`${image}: could not read the ${offset} byte runtime prefix`)
    }
    writeConcatenated(rebuilt, runtime, filesystem)
    chmodSync(rebuilt, 0o755)
    renameSync(rebuilt, image)
    chmodSync(image, 0o755)

    // Read back from the file that will be signed and uploaded, not from the
    // directory it was packed from.
    const packedOffset = payloadOffset(image)
    if (packedOffset !== offset) {
      throw new Error(
        `the repacked ${image} reports a payload offset of ${packedOffset}, not the ${offset} its own runtime prefix has`,
      )
    }
    const shipped = extractOne(image, packedOffset, member, path.join(work, "verify"))
    const got = sha256(shipped)
    if (got !== wanted) {
      throw new Error(
        `the repacked AppImage does not carry the pristine sidecar: ${got} inside the image, ${wanted} in the build output`,
      )
    }
    return {
      repacked: true,
      sidecarSha256: wanted,
      imageSha256: sha256(image),
      runtimeBytes: offset,
      imageBytes: statSync(image).size,
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  repack-appimage.ts <image> --sidecar <pristine file> [--sidecar-path <path in AppDir>] [--work <dir>]",
    ].join("\n"),
  )
  process.exit(2)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  let image = ""
  let sidecar = ""
  let sidecarPath = DEFAULT_SIDECAR_PATH
  let workDir: string | undefined
  let index = 0
  while (index < argv.length) {
    const argument = argv[index] as string
    index += 1
    if (argument === "--sidecar") {
      sidecar = argv[index] ?? ""
      index += 1
    } else if (argument === "--sidecar-path") {
      sidecarPath = argv[index] ?? ""
      index += 1
    } else if (argument === "--work") {
      workDir = argv[index]
      index += 1
    } else if (argument.startsWith("-")) {
      usage()
    } else if (!image) {
      image = argument
    } else {
      usage()
    }
  }
  if (!image || !sidecar || !sidecarPath) usage()
  try {
    const result = repackAppImage({ image, sidecar, sidecarPath, workDir })
    if (result.repacked) {
      console.log(`repacked ${image} around the pristine ${sidecarPath}`)
    } else {
      console.log(`${image} already carries the pristine ${sidecarPath}, nothing repacked`)
    }
    console.log(`  sidecar sha256 ${result.sidecarSha256}`)
    console.log(`  image   sha256 ${result.imageSha256}`)
    console.log(`  runtime ${result.runtimeBytes} bytes, image ${result.imageBytes} bytes`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

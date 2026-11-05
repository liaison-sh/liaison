#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# An `ldd` that linuxdeploy may run over the AppDir, with ONE file exempted:
# the Bun compiled sidecar.
#
# WHY THIS EXISTS. linuxdeploy walks every ELF file in the AppDir and shells
# out to `ldd` for each one (src/core/elf_file.cpp, traceDynamicDependencies:
# it runs `ldd <canonical path>`, and when ldd exits non zero it throws
# `Failed to run ldd: exited with code N` unless the output holds the words
# "not a dynamic executable", which it treats as "not linked dynamically" and
# answers with an empty dependency list). On the Linux runner it reached
# Liaison.AppDir/usr/bin/liaison-sidecar, ldd exited 1, and the whole gtk
# plugin died with SIGABRT (exit 134), taking the AppImage with it.
#
# The sidecar is 325 MB of Bun runtime with the Claude Code CLI appended, and
# glibc's ldd is not a parser: it EXECUTES the file through the dynamic loader
# (/usr/bin/ldd, the `try_trace "$RTLD" "$file"` branch) and reports whatever
# the loader exits with. Running a third of a gigabyte of vendored runtime
# through the loader, after linuxdeploy has already rewritten its rpath with
# patchelf, is not a question worth asking: the answer is not used. The
# sidecar's own NEEDED list is libc, libm, libpthread, libdl and the loader,
# and linuxdeploy blacklists every one of them, so the pass that did succeed
# deployed exactly nothing for it (run 34774739558, build-linux: two
# "Skipping deployment of blacklisted library" lines and no other).
#
# So this answers for that one file the way linuxdeploy already knows how to
# handle, and delegates every other file to the real ldd unchanged.
#
# It is deliberately narrow. It matches ONE base name, it never reads the
# file, and it cannot answer for a library: a shim that lied about a library
# would produce an AppImage missing a dependency, which fails on a user's
# machine and nowhere else.
set -uo pipefail

# The name the sidecar ships under inside the AppDir. Tauri names an
# externalBin after its base name once it is placed beside the main binary.
SIDECAR_BASENAME="${LIAISON_LDD_SHIM_SIDECAR:-liaison-sidecar}"
# The real ldd, by absolute path: a PATH lookup here would find this shim
# again and recurse until the runner runs out of processes.
REAL_LDD="${LIAISON_LDD_SHIM_REAL:-/usr/bin/ldd}"

for argument in "$@"; do
  case "$argument" in
  -*) continue ;;
  esac
  if [ "$(basename -- "$argument")" = "$SIDECAR_BASENAME" ]; then
    # The exact sentence glibc's ldd prints, on the stream it prints it on.
    # linuxdeploy looks for it in both stdout and stderr.
    printf '\tnot a dynamic executable\n' >&2
    exit 1
  fi
done

exec "$REAL_LDD" "$@"

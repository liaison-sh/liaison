# The Windows installer: NSIS, per-user

Decided here so the signing step, the registration guard and the updater all
act on the same file. Tauri's bundler happily produces two installers from one
build, and two installers is the same as none: whichever one a later step
picked, nothing in the pipeline says which one the customer ran.

## The choice

**NSIS**, the setup `.exe` tauri writes to `src-tauri/target/release/bundle/nsis/`.

Why not **MSI**:

- The MSI (WiX) target installs per machine and asks for elevation. The
  updater then needs an elevated relaunch for every background update, which is
  exactly the prompt an auto-updating app must not produce on each release.
- Windows Installer owns its own uninstall entry and its own repair logic.
  Re-registering the URL scheme and the uninstall key on an update means fighting
  that ownership through custom actions, where NSIS gives a plain hook that runs
  on every install and every update alike (`installer-hooks.nsi`).
- The updater tauri ships replaces the installed app by running the new
  installer silently. NSIS takes `/S` and finishes without a UAC dialog under a
  per-user install. An MSI run silently still needs the elevation token.
- MSI cannot bundle the sidecar's dependencies as freely: an MSI's file table
  is validated at build time by WiX, and the sidecar binary is produced by a
  separate compile step in this same pipeline.

The cost of NSIS, recorded rather than hidden: no machine wide deployment, no
Group Policy installation, and an admin who wants Liaison for every account on
a shared machine has to install it per account. No customer of this product has
asked for either, and the alternative is an elevation prompt on every update.

## What tauri.conf.json sets

`bundle.targets` is an explicit list, never `"all"`:

```
"targets": ["app", "dmg", "nsis", "appimage", "deb"]
```

One entry per artifact this pipeline actually signs, publishes and names
(`ci/artifact-names.ts`). `msi` is absent on purpose: its presence is what would
silently reintroduce the second installer.

`bundle.windows.nsis` sets:

- `installMode: "currentUser"`, the per-user install the reasons above rest on.
- `installerHooks: "windows/installer-hooks.nsi"`, the hook file that
  re-registers the `liaison` URL scheme, the uninstall key and the PATH entry on
  every run of the installer, update runs included.

## What runs on it

- `ci/sign-windows.ps1` signs the sidecar `.exe`, then the app `.exe`, then this
  installer, in that order.
- `ci/verify-windows-registration.ps1` runs after a silent install and refuses a
  build whose URL scheme, uninstall key or PATH entry is missing.

## The PATH entry, and why a plugin

The hook does NOT read the user PATH into an NSIS variable and write it back.
An NSIS string holds 1024 characters by default, a real user PATH is routinely
longer than that, and the read-modify-write silently truncates it: every tool
the customer had on their command line yesterday stops resolving, with nothing
tying that to having installed Liaison.

`installer-hooks.nsi` uses the **EnVar** plugin instead. It edits ONE element
(`EnVar::AddValue`, `EnVar::DeleteValue`) inside the plugin, never materialising
the whole value, and `AddValue` returns success when the element is already
there, so it is the idempotency guard as well as the write. PATH membership is
therefore an ELEMENT question, and `ci/verify-windows-registration.ps1` asks it
the same way (split on `;`, compare entries) rather than as a substring.

`ci/install-nsis-envar.ps1` puts the plugin on the build machine:

- the archive is **pinned by sha256**, because a third party DLL ends up inside
  an installer this pipeline signs. A different archive at that URL stops the
  build instead of being packaged.
- it installs into a directory this pipeline owns (`LIAISON_NSIS_PLUGINS`, set
  by the workflow job), never into tauri's own NSIS directory: the bundler
  deletes and re-extracts that directory whenever a file it expects is missing,
  which on a cold runner happens after the plugin was put there. The hook file
  reaches it with `!addplugindir /x86-unicode "$%LIAISON_NSIS_PLUGINS%"`, and an
  unset variable is a compile time `!error`, not a build that quietly registers
  no PATH entry.

The hook file is included by tauri's template BEFORE the template's own
`!define` lines (PRODUCTNAME, VERSION, MAINBINARYNAME, BUNDLEID), so nothing at
the top level of the hook may read or define those symbols: the reads and the
"is it defined" guard live in the macros, which expand from the NSIS_HOOK
insertion points, after the defines. This is compiled locally, not only on the
runner: `brew install makensis`, put the pinned EnVar plugin's `EnVar.dll` in
`~/.cache/liaison-nsis-plugins` (or point `LIAISON_NSIS_PLUGINS` at it), and
`apps/desktop/windows-installer-hooks.test.ts` compiles the hooks under a script
shaped like tauri's template. Without makensis that test is skipped by name.

The alternative considered and rejected: building makensis with
`NSIS_MAX_STRLEN 8192`. It would need a from-source NSIS build on every Windows
runner, it moves rather than removes the limit, and tauri downloads its own
makensis anyway, so the custom build would not be the one that compiles this
installer.

## What the rename step does, and does not, change

"Name the windows artifacts" runs AFTER the installer is signed. That order is
deliberate and safe: a rename changes the directory entry, not one byte of the
file, so the Authenticode signature is untouched. Renaming BEFORE signing would
work too; renaming after keeps every downstream step (the updater signature, the
upload glob, the manifest) matching on one derived name.

## The bundle type warning, and why this distribution does not need the symbol

Every Windows and Linux build logs this, and the macOS build does not:

```
Warn Failed to add bundler type to the binary: __TAURI_BUNDLE_TYPE variable
not found in binary. ... Updater plugin may not be able to update this package.
```

It is expected, it is not fatal here, and the reason is worth writing down
because the earlier reading of it was wrong. The first guess was symbol
stripping; it is not.

**What the symbol is.** `tauri-utils` (2.9.3, `src/platform.rs`) declares a
placeholder in the shell:

```rust
#[used]
static mut __TAURI_BUNDLE_TYPE: &str = "__TAURI_BUNDLE_TYPE_VAR_UNK";
```

`tauri-bundler` (2.9.0, `src/bundle.rs`, `patch_binary`) finds that literal by a
raw byte search and overwrites it with a four letter code per package type, and
`bundle_type()` reads it back at runtime.

**Why macOS is different.** Two independent reasons, and neither is stripping:

1. `patch_binary` returns early for tauri's own macOS package types
   (`MacOsBundle | Dmg => return Ok(())`), so the macOS build never patches and
   so never warns.
2. `bundle_type()` falls back to `Some(BundleType::App)` on macOS when the
   placeholder is unpatched, so a macOS build has an answer either way.

**Why the literal is gone on Windows and Linux.** `#[used]` is `llvm.used`: it
stops the compiler dropping the static, and it does not stop the linker. On
Mach O it lowers to `.no_dead_strip` and survives a `-dead_strip`; on ELF and
PE there is no equivalent short of `#[used(linker)]`, so `--gc-sections` takes
it. Measured on this profile (`lto = true`, `codegen-units = 1`,
`strip = "debuginfo"`): the macOS release shell contains
`__TAURI_BUNDLE_TYPE_VAR_UNK` exactly once, and the Windows and Linux shells
warn that it is absent.

**Why it costs this distribution nothing.** `bundle_type()` is read by
`tauri-plugin-updater` 2.11.0 in three places, and none of them decides
anything we depend on:

- `get_urls` (`src/updater.rs`) uses it to try a MORE specific manifest key,
  `{os}-{arch}-{installer}`, before the generic `{os}-{arch}`. Our manifest
  publishes the generic keys only (`windows-x86_64`, `linux-x86_64`,
  `darwin-aarch64`: see `ci/build-publish-request.ts`), so with no bundle type
  the generic key is the only candidate and it is the one that is there.
- On Windows the installer kind comes from the downloaded BYTES, not from the
  bundle type: `extract_exe` asks `infer::app::is_exe` and answers Nsis. We
  publish an NSIS setup .exe and no MSI.
- On Linux `install_inner` falls through to `install_appimage` for anything
  that is not Deb or Rpm, and the AppImage is our updater payload. The .deb is
  installed by a package manager and never auto updates.

So the decision is to leave the profile alone (a thin LTO or a linker flag to
keep one unread string would trade real optimisation for nothing) and to make
the warning explicit instead: `ci/tauri-build.ts` prints a note beside it in the
build log saying it is expected and why.

**What would end that reasoning.** A manifest key with an installer suffix, or
an MSI beside the NSIS installer, or a Linux release whose updater payload is
the .deb. `apps/desktop/windows-installer-decision.test.ts` pins the generic
manifest keys so that change fails there rather than in a customer's update.

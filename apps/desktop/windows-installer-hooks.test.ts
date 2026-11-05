// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The installer hooks run on EVERY run of the installer, and an update is a
// run of the installer. That is the whole point of this file: an update that
// only re-copies the binaries leaves the URL scheme, the uninstall entry and
// the PATH entry pointing at whatever the previous version wrote, and on a
// version that changed the install directory they point at nothing. The app
// then launches fine, and only the deep links and the uninstaller are broken,
// which is why nobody notices until a customer does.
//
// The hook text is the first assertion: registration unconditional, the PATH
// append guarded so a second run cannot duplicate the entry. The second is a
// real makensis compile of the hooks under a script shaped like tauri's
// template, where the hook include comes BEFORE the template's own defines:
// the first Windows dry run died there, on a guard that read MAINBINARYNAME at
// include time. That compile runs wherever makensis (brew install makensis)
// and the EnVar plugin (LIAISON_NSIS_PLUGINS, or ~/.cache/liaison-nsis-plugins)
// are present, and says so when it cannot.
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { loadDesktopReleaseWorkflow, REPO_ROOT, step, stepIndex } from "./ci/workflow"

const HOOKS = path.join(import.meta.dir, "src-tauri", "windows", "installer-hooks.nsi")
const STOP_SCRIPT = path.join(import.meta.dir, "src-tauri", "windows", "stop-leftovers.ps1")
const hooks = readFileSync(HOOKS, "utf8")
const config = JSON.parse(
  readFileSync(path.join(import.meta.dir, "src-tauri", "tauri.conf.json"), "utf8"),
) as {
  identifier: string
  productName: string
  bundle: {
    publisher?: string
    windows?: { nsis?: { installerHooks?: string; installMode?: string } }
  }
}

function at(marker: string): number {
  const index = hooks.indexOf(marker)
  expect(index, `marker not in installer-hooks.nsi: ${marker}`).toBeGreaterThanOrEqual(0)
  return index
}

describe("the NSIS installer hooks", () => {
  it("are the hooks tauri's bundler actually includes", () => {
    expect(config.bundle.windows?.nsis?.installerHooks).toBe("windows/installer-hooks.nsi")
    expect(hooks).toContain("!macro NSIS_HOOK_POSTINSTALL")
  })

  it("refuses to guess the name of the main binary, from inside a macro", () => {
    // Every path this file registers points at ${MAINBINARYNAME}.exe. A
    // fallback value there is a registry entry naming an executable that does
    // not exist: the app still installs, still launches, and every deep link
    // opens nothing. A missing define has to stop the build instead. And the
    // guard has to live inside a macro: tauri includes this file before its
    // own defines, so a top level !ifndef fires on every build.
    const guard = hooks.slice(at("!ifndef MAINBINARYNAME"))
    expect(guard.slice(0, guard.indexOf("!endif"))).toContain("!error")
    const firstMacro = at("!macro ")
    const topLevel = hooks.slice(0, firstMacro)
    for (const symbol of ["MAINBINARYNAME", "BUNDLEID", "PRODUCTNAME", "VERSION"]) {
      expect(topLevel, `${symbol} read or defined before the first macro`).not.toMatch(
        new RegExp(`^\\s*!(ifn?def|define)\\s+${symbol}\\b`, "m"),
      )
    }
  })

  const makensis = spawnSync("makensis", ["-VERSION"], { encoding: "utf8" }).status === 0
  const pluginDir =
    process.env.LIAISON_NSIS_PLUGINS ?? path.join(homedir(), ".cache", "liaison-nsis-plugins")
  const envar = existsSync(path.join(pluginDir, "EnVar.dll"))
  const canCompile = makensis && envar
  const why = !makensis
    ? "makensis is not on PATH (brew install makensis)"
    : `EnVar.dll is not in ${pluginDir} (apps/desktop/ci/install-nsis-envar.ps1 fetches it)`

  // Shaped like tauri-bundler's installer.nsi: the hook include first, the
  // defines after it, the hooks inserted from the sections.
  // `aumidMacro` stands in for the template's utils.nsh, which defines
  // SetLnkAppUserModelId before the hook include.
  function templateShaped(hookFile: string, aumidMacro = true): string {
    return [
      "Unicode true",
      "!include MUI2.nsh",
      ...(aumidMacro ? ["!macro SetLnkAppUserModelId shortcut", "!macroend"] : []),
      "Var UpdateMode",
      "Var DeleteAppDataCheckboxState",
      `!include "${hookFile}"`,
      '!define PRODUCTNAME "Liaison"',
      '!define VERSION "0.1.0"',
      '!define MAINBINARYNAME "liaison-desktop"',
      `!define BUNDLEID "${config.identifier}"`,
      'Name "$' + '{PRODUCTNAME}"',
      'OutFile "stub-setup.exe"',
      'InstallDir "$LOCALAPPDATA\\$' + '{PRODUCTNAME}"',
      "RequestExecutionLevel user",
      "Section Install",
      "  SetOutPath $INSTDIR",
      "  !ifmacrodef NSIS_HOOK_PREINSTALL",
      "    !insertmacro NSIS_HOOK_PREINSTALL",
      "  !endif",
      "  !insertmacro NSIS_HOOK_POSTINSTALL",
      "SectionEnd",
      "Section Uninstall",
      "  !ifmacrodef NSIS_HOOK_PREUNINSTALL",
      "    !insertmacro NSIS_HOOK_PREUNINSTALL",
      "  !endif",
      "  !insertmacro NSIS_HOOK_POSTUNINSTALL",
      "SectionEnd",
      "",
    ].join("\n")
  }

  function compile(hookText: string, aumidMacro = true): { status: number | null; output: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "liaison-nsis-"))
    writeFileSync(path.join(dir, "hooks.nsi"), hookText)
    writeFileSync(path.join(dir, "stop-leftovers.ps1"), readFileSync(STOP_SCRIPT, "utf8"))
    writeFileSync(path.join(dir, "stub.nsi"), templateShaped("hooks.nsi", aumidMacro))
    const run = spawnSync("makensis", ["-V2", "stub.nsi"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, LIAISON_NSIS_PLUGINS: pluginDir },
    })
    return { status: run.status, output: `${run.stdout}${run.stderr}` }
  }

  it.skipIf(!canCompile)(
    `compile under tauri's include order (${canCompile ? "makensis" : why})`,
    () => {
      const real = compile(hooks)
      expect(real.output, real.output).not.toContain("!error")
      expect(real.status).toBe(0)
    },
  )

  it.skipIf(!canCompile)(
    "the compile test sees the guard: a top level guard fails the way the runner did",
    () => {
      const hoisted = hooks.replace(
        "!macro LiaisonRequireTemplateDefines",
        '!ifndef MAINBINARYNAME\n  !error "MAINBINARYNAME is not defined"\n!endif\n!macro LiaisonRequireTemplateDefines',
      )
      expect(hoisted).not.toBe(hooks)
      const broken = compile(hoisted)
      expect(broken.status).not.toBe(0)
      expect(broken.output).toContain("MAINBINARYNAME is not defined")
    },
  )

  it.skipIf(!canCompile)(
    "a template without SetLnkAppUserModelId stops the build instead of skipping the restamp",
    () => {
      const broken = compile(hooks, false)
      expect(broken.status).not.toBe(0)
      expect(broken.output).toContain("no longer defines SetLnkAppUserModelId")
    },
  )

  it("re-registers the url scheme on every run, update runs included", () => {
    expect(hooks).toContain('WriteRegStr HKCU "Software\\Classes\\liaison"')
    expect(hooks).toContain("Software\\Classes\\liaison\\shell\\open\\command")
    expect(hooks).toContain("$INSTDIR")
  })

  it("writes no uninstall entry of its own: tauri's template owns Uninstall\\Liaison", () => {
    // The template writes `Uninstall\${PRODUCTNAME}` in full on every install
    // and deletes it on uninstall. A second key written here, under the bundle
    // identifier, was a second "Liaison" row in Installed Apps on the first
    // real Windows install.
    expect(hooks).not.toMatch(
      /WriteReg(Str|DWORD)\s+HKCU\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/,
    )
    expect(hooks).not.toMatch(
      /DeleteRegKey\s+HKCU\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/,
    )
  })

  it("registers unconditionally: the URL scheme first", () => {
    // A conditional around the scheme is how "only on a fresh install" comes
    // back.
    expect(at("Software\\Classes\\liaison")).toBeLessThan(at("EnVar::"))
  })

  it("never reads the whole PATH into an NSIS string", () => {
    // An NSIS string is 1024 characters by default. Reading a user PATH into
    // one and writing it back TRUNCATES it, silently, and the user loses every
    // entry past the limit: the tools they had on their command line yesterday
    // are simply gone, and nothing connects that to having installed Liaison.
    expect(hooks).not.toMatch(/ReadRegStr\s+\$\d\s+HKCU\s+"Environment"\s+"Path"/i)
    expect(hooks).not.toContain("WriteRegExpandStr")
    expect(hooks).not.toContain("{WordFind}")
  })

  it("appends the install directory as a PATH ELEMENT, through the EnVar plugin", () => {
    // EnVar adds and removes one element without ever materialising the whole
    // value, and it is idempotent: twenty updates leave one entry.
    expect(hooks).toContain("EnVar::SetHKCU")
    expect(hooks).toContain('EnVar::AddValue "Path" "$INSTDIR"')
    expect(at("EnVar::SetHKCU")).toBeLessThan(at('EnVar::AddValue "Path"'))
  })

  it("stops the install when the PATH entry could not be written", () => {
    // EnVar returns its error code on the stack. Dropping it means the entry
    // silently did not happen and the command line does not find the app.
    expect(hooks).toContain("Pop $0")
  })

  it("tells the shell the environment changed", () => {
    // Without the broadcast the new PATH exists in the registry and in no
    // running process, so the first thing the customer tries still fails.
    expect(hooks).toContain("WM_SETTINGCHANGE")
  })

  it("removes the scheme registration when the app is uninstalled", () => {
    expect(hooks).toContain("!macro NSIS_HOOK_POSTUNINSTALL")
    expect(hooks).toContain('DeleteRegKey HKCU "Software\\Classes\\liaison"')
  })

  it("removes the PATH entry when the app is uninstalled", () => {
    // An uninstall that leaves the directory in PATH leaves a broken entry
    // there forever, and it accumulates one per install over a machine's life.
    const uninstall = hooks.slice(at("!macro NSIS_HOOK_POSTUNINSTALL"))
    expect(uninstall).toContain("EnVar::SetHKCU")
    expect(uninstall).toContain('EnVar::DeleteValue "Path" "$INSTDIR"')
  })
})

describe("the bundle identifier change installs over the legacy build", () => {
  // tauri-bundler's template (checked against @tauri-apps/cli 2.12.0) keys an
  // existing install on Uninstall\${PRODUCTNAME}, Software\${MANUFACTURER}\
  // ${PRODUCTNAME} and $LOCALAPPDATA\${PRODUCTNAME}, never on BUNDLEID. And
  // MANUFACTURER is bundle.publisher, or the identifier's second segment when
  // that is unset: drop the publisher and the remembered install directory
  // moves with the identifier.
  const migration = readFileSync(
    path.join(import.meta.dir, "src-tauri", "src", "identifier_migration.rs"),
    "utf8",
  )
  const legacyInRust = migration.match(/pub const LEGACY_IDENTIFIER: &str = "([^"]+)"/)?.[1]
  const legacyInHooks = hooks.match(/!define LIAISON_LEGACY_BUNDLEID "([^"]+)"/)?.[1]

  it("keeps every key the template finds the old install by", () => {
    expect(config.productName).toBe("Liaison")
    expect(config.bundle.publisher?.length ?? 0).toBeGreaterThan(0)
    expect(config.bundle.windows?.nsis?.installMode).toBe("currentUser")
  })

  it("names the same legacy identifier as the shell's migration, and not the current one", () => {
    expect(legacyInHooks).toBeDefined()
    expect(legacyInHooks).toBe(legacyInRust)
    expect(legacyInHooks).not.toBe(config.identifier)
  })

  it("restamps the shortcuts' AppUserModelID on every install, update runs included", () => {
    const post = hooks.slice(at("!macro NSIS_HOOK_POSTINSTALL"))
    expect(post.slice(0, post.indexOf("!macroend"))).toContain("LiaisonRestampShortcutIds")
    const restamp = hooks.slice(at("!macro LiaisonRestampShortcutIds"))
    const body = restamp.slice(0, restamp.indexOf("!macroend"))
    expect(body).toContain('SetLnkAppUserModelId "$SMPROGRAMS\\$' + '{PRODUCTNAME}.lnk"')
    expect(body).toContain('SetLnkAppUserModelId "$DESKTOP\\$' + '{PRODUCTNAME}.lnk"')
    expect(body).not.toContain("$" + "{If} $UpdateMode")
  })

  it("removes the legacy data directories only when the user asked to delete app data", () => {
    const uninstall = hooks.slice(at("!macro NSIS_HOOK_POSTUNINSTALL"))
    const body = uninstall.slice(0, uninstall.indexOf("!macroend"))
    const guard = body.indexOf("$DeleteAppDataCheckboxState = 1")
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(body).toContain("$UpdateMode <> 1")
    for (const root of ["$APPDATA", "$LOCALAPPDATA"]) {
      const removal = body.indexOf(
        ['RmDir /r "', root, "\\$", '{LIAISON_LEGACY_BUNDLEID}"'].join(""),
      )
      expect(removal, root).toBeGreaterThan(guard)
    }
  })
})

describe("the installer frees $INSTDIR before it writes (2026-09-28)", () => {
  // An update is this installer started by the OLD app, whose updater exits
  // without stopping its children. tauri's template kills a running main
  // binary and nothing else, and Windows refuses to overwrite the file a
  // running process was started from: a leftover liaison-sidecar.exe turned
  // the passive update into an error box nobody saw. The hook is in the NEW
  // build's installer, which is the code every update actually runs.
  const pre = hooks.slice(at("!macro NSIS_HOOK_PREINSTALL"))
  const preBody = pre.slice(0, pre.indexOf("!macroend"))
  const stop = hooks.slice(at("!macro LiaisonStopProcessesInInstdir"))
  const stopBody = stop.slice(0, stop.indexOf("!macroend"))

  it("has a PREINSTALL hook that stops what runs from $INSTDIR", () => {
    expect(preBody).toContain("!insertmacro LiaisonStopProcessesInInstdir")
    expect(preBody).toContain("LiaisonRequireTemplateDefines")
  })

  it("runs the stop script shipped beside the hooks, with its inputs in the environment", () => {
    // A file rather than an inline -Command: the logic outgrew an NSIS string
    // (1024 characters), and a file is what the tests below can run.
    expect(hooks).toContain('!define LIAISON_HOOKS_DIR "$' + '{__FILEDIR__}"')
    expect(stopBody).toContain(
      'File "/oname=$PLUGINSDIR\\liaison-stop-leftovers.ps1" "$' +
        '{LIAISON_HOOKS_DIR}\\stop-leftovers.ps1"',
    )
    expect(stopBody).toContain('-File "$PLUGINSDIR\\liaison-stop-leftovers.ps1"')
    // Every input through the environment, never spliced into the command
    // text, where an apostrophe in a user name breaks it.
    for (const name of ["LIAISON_INSTDIR", "LIAISON_NAMES", "LIAISON_SELF_PID"]) {
      expect(stopBody).toContain(`SetEnvironmentVariable(t "${name}"`)
    }
    expect(stopBody).toContain("kernel32::GetCurrentProcessId()")
    // Our names only, from the bundler's own define.
    expect(stopBody).toContain('t "$' + "{MAINBINARYNAME}.exe,$" + '{LIAISON_SIDECAR_EXE}"')
    const command = stopBody.slice(stopBody.indexOf("powershell.exe"))
    expect(command.slice(0, command.indexOf("\n"))).not.toContain("$INSTDIR")
  })

  it("never waits on PowerShell forever", () => {
    // A hung WMI query would otherwise hold a passive installer, with no
    // window anyone can close, until the machine restarts.
    const call = stopBody.slice(stopBody.indexOf("nsExec::ExecToStack"))
    expect(call.slice(0, call.indexOf("\n"))).toMatch(/nsExec::ExecToStack \/TIMEOUT=\d+ /)
    for (const line of stopBody.split("\n").filter((l) => l.includes("nsExec::"))) {
      expect(line, line).toMatch(/\/TIMEOUT=\d+/)
    }
  })

  it("waits until BOTH binaries can be written, then falls back to a kill by name", () => {
    // After the hook kills Liaison.exe the template's own check finds nothing
    // running and does not sleep, so `File` could meet a file still locked by
    // a process on its way out: an Abort/Retry box in a passive install.
    const main = 'LiaisonWaitWritable "$INSTDIR\\$' + '{MAINBINARYNAME}.exe"'
    const sidecar = 'LiaisonWaitWritable "$INSTDIR\\$' + '{LIAISON_SIDECAR_EXE}"'
    expect(stopBody).toContain(main)
    expect(stopBody).toContain(sidecar)
    // The fallback runs whatever PowerShell did (a timeout included): the
    // sidecar with its tree, the main binary ALONE (it may be the installer's
    // parent), both for this user only.
    expect(stopBody).toMatch(
      /taskkill\.exe \/F \/T \/IM \$\{LIAISON_SIDECAR_EXE\} \/FI "USERNAME eq \$1"/,
    )
    expect(stopBody).toMatch(
      /taskkill\.exe \/F \/IM \$\{MAINBINARYNAME\}\.exe \/FI "USERNAME eq \$1"/,
    )
    expect(stopBody).not.toMatch(/\/T \/IM \$\{MAINBINARYNAME\}/)
    // The user is read at RUN time: $%USERNAME% is the build machine's.
    expect(stopBody).toContain("ReadEnvStr $1 USERNAME")
    expect(stopBody).not.toMatch(/eq \$%USERNAME%/)
  })

  it("names the sidecar the way tauri installs the externalBin", () => {
    const full = JSON.parse(
      readFileSync(path.join(import.meta.dir, "src-tauri", "tauri.conf.json"), "utf8"),
    ) as { bundle: { externalBin: string[] } }
    const sidecar = full.bundle.externalBin.find((bin) => bin.includes("liaison-sidecar"))
    expect(sidecar).toBeDefined()
    expect(hooks).toContain(`!define LIAISON_SIDECAR_EXE "${path.basename(sidecar ?? "")}.exe"`)
  })

  // The script the hook runs, against a faked process table: Get-CimInstance
  // and taskkill are Windows only, and text assertions cannot see either a
  // PowerShell syntax error or a kill that reaches the wrong process.
  type Proc = {
    id: number
    parent: number
    name: string
    path: string | null
    /** Minutes after 10:00, as Win32_Process.CreationDate. */
    created?: number
  }
  const INSTDIR = "C:\\Users\\O'Brien\\AppData\\Local\\Liaison"
  const INSTALLER = 300

  // The update as it really runs: Liaison.exe (100, in $INSTDIR) started the
  // installer, here through an intermediate process (150) so the installer is
  // a GRANDCHILD; the sidecar (101) runs the Claude CLI (102) from %TEMP%;
  // WebView2 (103) is another child of the app.
  const UPDATE: Proc[] = [
    { id: 4, parent: 0, name: "System", path: null },
    { id: 100, parent: 50, name: "liaison-desktop.exe", path: `${INSTDIR}\\liaison-desktop.exe` },
    { id: 101, parent: 100, name: "liaison-sidecar.exe", path: `${INSTDIR}\\liaison-sidecar.exe` },
    {
      id: 102,
      parent: 101,
      name: "claude.exe",
      path: "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\claude.exe",
    },
    {
      id: 103,
      parent: 100,
      name: "msedgewebview2.exe",
      path: "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\msedgewebview2.exe",
    },
    { id: 150, parent: 100, name: "cmd.exe", path: "C:\\Windows\\System32\\cmd.exe" },
    {
      id: INSTALLER,
      parent: 150,
      name: "Liaison_0.2.0_setup.exe",
      path: "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\liaison-update\\Liaison_0.2.0_setup.exe",
    },
    // Not ours: an unrelated program in the same (shared) folder, and a
    // same-named sidecar of another install next door.
    { id: 200, parent: 50, name: "other.exe", path: `${INSTDIR}\\other.exe` },
    { id: 201, parent: 50, name: "liaison-sidecar.exe", path: `${INSTDIR}2\\liaison-sidecar.exe` },
  ]

  function runStop(
    procs: Proc[],
    options: {
      exitsAfterCalls?: number
      constrained?: boolean
      script?: string
      slowQueryMs?: number
      waitSeconds?: number
    } = {},
  ): { code: number; stdout: string; killed: string[] } {
    const pwsh = Bun.which("pwsh")
    expect(pwsh, "pwsh is required (brew install powershell)").toBeTruthy()
    const dir = mkdtempSync(path.join(tmpdir(), "liaison-kill-"))
    const q = (text: string) => `'${text.replaceAll("'", "''")}'`
    const rows = procs
      .map(
        (p) =>
          // UInt32, as Win32_Process really types them: the first real
          // Windows run found every id arithmetic turning them into Int64
          // keys that an Int32 lookup never matched, so the ancestor chain
          // was always empty and the app was tree killed with the installer.
          `[pscustomobject]@{ ProcessId = [uint32]${p.id}; ParentProcessId = [uint32]${p.parent}; Name = ${q(p.name)}; ExecutablePath = ${p.path === null ? "$null" : q(p.path)}${p.created === undefined ? "" : `; CreationDate = [datetime]'2026-09-28T10:${String(p.created).padStart(2, "0")}:00'`} }`,
      )
      .join(",\n  ")
    const wrapper = path.join(dir, "run.ps1")
    writeFileSync(
      wrapper,
      [
        `$global:procs = @(\n  ${rows}\n)`,
        "$global:calls = 0",
        `$global:exitsAfter = ${options.exitsAfterCalls ?? -1}`,
        "$global:killed = @()",
        "function Get-CimInstance {",
        "  param([string]$ClassName)",
        "  $global:calls++",
        `  Start-Sleep -Milliseconds ${options.slowQueryMs ?? 0}`,
        "  if ($global:exitsAfter -ge 0 -and $global:calls -gt $global:exitsAfter) {",
        "    return @($global:procs | Where-Object { $_.ProcessId -ne 100 })",
        "  }",
        "  $global:procs",
        "}",
        "function taskkill.exe { $global:killed += ($args -join ' ') }",
        `$env:LIAISON_INSTDIR = ${q(`${INSTDIR}\\`)}`,
        "$env:LIAISON_NAMES = 'liaison-desktop.exe,liaison-sidecar.exe'",
        `$env:LIAISON_SELF_PID = '${INSTALLER}'`,
        `$env:LIAISON_WAIT_SECONDS = '${options.waitSeconds ?? 1}'`,
        options.constrained
          ? "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'"
          : "",
        "$started = Get-Date",
        `$out = & ${q(options.script ?? STOP_SCRIPT)}`,
        "Write-Output ('ELAPSED=' + [int]((Get-Date) - $started).TotalMilliseconds)",
        "Write-Output ('MODE=' + $ExecutionContext.SessionState.LanguageMode)",
        "Write-Output ('KILLED=' + ($global:killed -join ';'))",
        "Write-Output ('CALLS=' + $global:calls)",
        "Write-Output ('OUT=' + ($out -join ';'))",
      ].join("\n"),
    )
    const run = Bun.spawnSync([pwsh as string, "-NoProfile", "-File", wrapper])
    const stdout = `${run.stdout.toString()}\n${run.stderr.toString()}`
    const line = stdout.split("\n").find((l) => l.startsWith("KILLED=")) ?? "KILLED="
    const killed = line.slice("KILLED=".length).split(";").filter(Boolean)
    return { code: run.exitCode ?? -1, stdout, killed }
  }

  it("never tree kills the app the installer descends from, even when it does not exit", () => {
    // The review's blocker: /T on Liaison.exe kills the installer below it.
    const run = runStop(UPDATE)
    expect(run.code, run.stdout).toBe(0)
    for (const kill of run.killed) {
      expect(kill, run.stdout).not.toMatch(/\/T \/PID (100|150|300)$/)
    }
    // Still alive after the wait: killed ALONE.
    expect(run.killed).toContain("/F /PID 100")
    // The sidecar with its tree (the Claude CLI), the app's other child with
    // its own.
    expect(run.killed).toContain("/F /T /PID 101")
    expect(run.killed).toContain("/F /T /PID 103")
    // Nothing that is not ours, even in the same folder or with our name.
    expect(run.killed.join(";")).not.toMatch(/PID (150|200|201|300)\b/)
    expect(run.killed).toHaveLength(3)
  })

  it("waits for the app to exit on its own and then leaves it alone", () => {
    // The shell quits right after it starts the installer; the usual case is
    // an app that is gone a moment later. Nothing of it is killed then.
    const run = runStop(UPDATE, { exitsAfterCalls: 2 })
    expect(run.code, run.stdout).toBe(0)
    expect(run.killed.join(";")).not.toMatch(/PID 100\b/)
    expect(run.killed).toContain("/F /T /PID 101")
    expect(run.stdout).toMatch(/OUT=waited [1-9]\d* ms/)
  })

  it("bounds the wait by the clock, however slow a process query is", () => {
    // The first real Windows run: sixty checks of about a second each held the
    // installer for more than a minute. With a one second budget and a query
    // that takes a second, the script is done in about three (the wait, one
    // sleep, the final query); counting checks took six.
    const run = runStop(UPDATE, { slowQueryMs: 1000 })
    expect(run.code, run.stdout).toBe(0)
    const elapsed = Number(/ELAPSED=(\d+)/.exec(run.stdout)?.[1])
    expect(elapsed).toBeGreaterThanOrEqual(1000)
    expect(elapsed).toBeLessThan(4500)
  }, 20_000)

  it("does not take a reused process id for the installer's parent", () => {
    // The installer's real parent (150) exited and Windows handed its id to a
    // NEW liaison-desktop.exe, started after the installer. That process is
    // not above the installer: waiting for it would hold the install for
    // nothing, and killing it alone would leave its children. It started
    // later than its supposed child, which is how the chain tells.
    const reused = UPDATE.filter((p) => p.id !== 150).map((p) =>
      p.id === INSTALLER ? { ...p, created: 5 } : p,
    )
    reused.push({
      id: 150,
      parent: 60,
      name: "liaison-desktop.exe",
      path: `${INSTDIR}\\liaison-desktop.exe`,
      created: 9,
    })
    // A ten second budget, so a wait for the reused id is unmistakable: it
    // queries again every 250 ms for ten seconds. Not waiting is one query in
    // the loop and the final one, however slow a busy machine makes each.
    const run = runStop(reused, { waitSeconds: 10 })
    expect(run.code, run.stdout).toBe(0)
    expect(run.killed).toContain("/F /T /PID 150")
    expect(run.killed).not.toContain("/F /PID 150")
    expect(run.stdout).toMatch(/^CALLS=2$/m)
    const waited = Number(/OUT=waited (\d+) ms/.exec(run.stdout)?.[1])
    expect(waited).toBeLessThan(10_000)
  }, 30_000)

  it("tree kills a leftover of ours that the installer does not descend from", () => {
    // A launch by hand of the downloaded installer, or an uninstall: the
    // installer is nobody's child of ours, so every one of ours goes whole.
    const alone = UPDATE.map((p) => (p.id === INSTALLER ? { ...p, parent: 60 } : p))
    const run = runStop(alone)
    expect(run.code, run.stdout).toBe(0)
    expect(run.killed).toEqual(["/F /T /PID 100", "/F /T /PID 101"])
  })

  it("runs under Constrained Language Mode, which Smart App Control imposes", () => {
    const run = runStop(UPDATE, { constrained: true })
    expect(run.stdout).toContain("MODE=ConstrainedLanguage")
    expect(run.stdout).not.toMatch(/not supported in this language mode|Cannot invoke method/i)
    expect(run.code, run.stdout).toBe(0)
    expect(run.killed).toContain("/F /PID 100")
    expect(run.killed).toContain("/F /T /PID 101")
  })

  it("stops the same processes before an uninstall", () => {
    const un = hooks.slice(at("!macro NSIS_HOOK_PREUNINSTALL"))
    expect(un.slice(0, un.indexOf("!macroend"))).toContain(
      "!insertmacro LiaisonStopProcessesInInstdir",
    )
  })

  it("logs the caller's registers, not the clock's", () => {
    // ${GetTime} writes $0 to $6. The first Windows run logged "powershell
    // exit 28): 09", the day and the month, because the text naming the
    // caller's $0 and $1 was expanded after the clock had overwritten them.
    const log = hooks.slice(at("!macro LiaisonLog"))
    const body = log.slice(0, log.indexOf("!macroend"))
    const copy = body.indexOf('StrCpy $8 "$' + '{text}"')
    expect(copy).toBeGreaterThanOrEqual(0)
    expect(copy).toBeLessThan(body.indexOf("$" + "{GetTime}"))
    expect(body.slice(body.indexOf("FileWrite"))).not.toContain("$" + "{text}")
  })

  it("writes its steps to the shell's updater.log", () => {
    // The same file updater.rs writes, so one file tells the whole story.
    expect(hooks).toContain('"$LOCALAPPDATA\\$' + '{BUNDLEID}\\logs\\updater.log"')
    expect(preBody).toContain("LiaisonLog")
    const post = hooks.slice(at("!macro NSIS_HOOK_POSTINSTALL"))
    expect(post.slice(0, post.indexOf("!macroend"))).toContain("LiaisonLog")
  })
})

describe("the EnVar plugin the hooks depend on", () => {
  // The hooks call a plugin that is not part of NSIS. If nobody puts it on the
  // build machine the installer does not build at all, which is the good case;
  // the bad case is a plugin fetched unpinned from the internet and packaged
  // inside a signed installer nobody reviewed.
  const SCRIPT = path.join(import.meta.dir, "ci", "install-nsis-envar.ps1")
  const script = readFileSync(SCRIPT, "utf8")
  const steps = loadDesktopReleaseWorkflow().jobs["build-windows"].steps

  it("is fetched from a pinned URL and refused on a hash mismatch", () => {
    expect(script).toMatch(/https:\/\/\S+EnVar_plugin\.zip/)
    expect(script).toMatch(/\$Sha256 = "[0-9A-F]{64}"/)
    expect(script).toContain("Get-FileHash")
    expect(script).toContain("exit 1")
  })

  it("installs where the hooks look, not into the directory tauri wipes", () => {
    // tauri deletes and re-extracts its own NSIS directory whenever a file it
    // expects is missing, which on a cold runner happens AFTER this step: a
    // plugin dropped in there is gone by the time makensis runs.
    expect(script).toContain("LIAISON_NSIS_PLUGINS")
    expect(script).toContain("x86-unicode")
    expect(script).not.toContain("tauri\\NSIS")
  })

  it("is reached by the hooks through addplugindir, and its absence is an error", () => {
    expect(hooks).toContain("!addplugindir /x86-unicode")
    expect(hooks).toContain("$%LIAISON_NSIS_PLUGINS%")
    expect(hooks).toContain("!error")
  })

  it("gets its directory from a step, by that name, before the plugin is installed", () => {
    // The `runner` context is not available in a job level `env` block:
    // GitHub refuses to dispatch a workflow that reads it there (seen live on
    // the first dry run). The directory is named by a step writing GITHUB_ENV.
    const name = stepIndex(steps, "Name the NSIS plugin directory")
    expect(name).toBeGreaterThanOrEqual(0)
    expect(name).toBeLessThan(stepIndex(steps, "Install the NSIS EnVar plugin"))
    const run = String((steps[name] as { run?: string }).run ?? "")
    expect(run).toContain("LIAISON_NSIS_PLUGINS=")
    expect(run).toContain("GITHUB_ENV")
    const job = loadDesktopReleaseWorkflow().jobs["build-windows"] as unknown as {
      env?: Record<string, string>
    }
    expect(job.env?.LIAISON_NSIS_PLUGINS).toBeUndefined()
  })

  it("never reads the runner context from a job level env block, in any workflow", () => {
    for (const file of [
      "apps/desktop/ci/desktop-release.workflow.yml",
      "apps/mobile/ci/mobile-release.workflow.yml",
    ]) {
      const doc = Bun.YAML.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as {
        jobs: Record<string, { env?: Record<string, string> }>
      }
      for (const [jobName, job] of Object.entries(doc.jobs)) {
        for (const [key, value] of Object.entries(job.env ?? {})) {
          expect(`${file} ${jobName} env ${key}: ${value}`).not.toMatch(/runner\./)
        }
      }
    }
  })

  it("is installed before the bundler runs", () => {
    const install = stepIndex(steps, "Install the NSIS EnVar plugin")
    expect(install).toBeGreaterThanOrEqual(0)
    expect(install).toBeLessThan(stepIndex(steps, "Build the app bundle"))
    expect(step(steps, "Install the NSIS EnVar plugin").run).toContain(
      "apps/desktop/ci/install-nsis-envar.ps1",
    )
  })
})

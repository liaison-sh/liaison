// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The PowerShell scripts in this repo, run through the real PowerShell parser.
//
// WHY: every other Windows test in this directory asserts the SHAPE of these
// scripts as text, because the machines that wrote them had no pwsh. Text
// cannot see a syntax error, and a syntax error is total: the script does not
// run at all. A Windows release job proved it by building for twenty minutes,
// reaching the signing step, and dying there because "$Binaries:" inside a
// double quoted string is a scope qualified variable reference to PowerShell,
// not a variable followed by a colon. Every earlier fix in that job was
// correct; none of them ever executed.
//
// So: parse every script with [Parser]::ParseFile, and where a script's pure
// logic can run on macOS, run it. When pwsh is absent this file FAILS. It does
// not skip: a silent skip is exactly how the class of defect above reached a
// release runner in the first place.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadDesktopReleaseWorkflow } from "./ci/workflow"

const DESKTOP = import.meta.dir
const REPO = path.resolve(DESKTOP, "..", "..")
const MOBILE = path.join(REPO, "apps", "mobile")
const PARSER = path.join(DESKTOP, "ci", "parse-powershell.ps1")

const pwsh = Bun.which("pwsh")

type Run = { code: number; stdout: string; stderr: string; all: string }

function runPwshFile(file: string, args: string[] = [], env?: Record<string, string>): Run {
  const proc = Bun.spawnSync([pwsh as string, "-NoProfile", "-File", file, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
  })
  const stdout = proc.stdout.toString()
  const stderr = proc.stderr.toString()
  return { code: proc.exitCode ?? -1, stdout, stderr, all: `${stdout}\n${stderr}` }
}

/** Runs a snippet of PowerShell from a temp file, so a snippet with a syntax
 *  error is reported the same way a repo script would be. */
function runPwshScript(source: string, args: string[] = []): Run {
  const dir = mkdtempSync(path.join(tmpdir(), "liaison-pwsh-"))
  const file = path.join(dir, "snippet.ps1")
  writeFileSync(file, source)
  return runPwshFile(file, args)
}

/** Dot sources one function out of a repo script without running the script.
 *  verify-windows-registration.ps1 and sign-windows.ps1 both do real work at
 *  top level (they read a Windows registry, they sign binaries), so the
 *  function under test is lifted out of the AST and defined on its own. */
function extractFunction(scriptPath: string, name: string): string {
  return [
    "$tokens = $null; $errors = $null",
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}', [ref]$tokens, [ref]$errors)`,
    'if ($errors.Count -gt 0) { throw "parse errors in the script under test" }',
    `$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq '${name}' }, $true)`,
    `if (-not $fn) { throw "no function ${name} in ${scriptPath}" }`,
    ". ([scriptblock]::Create($fn.Extent.Text))",
  ].join("\n")
}

describe("PowerShell scripts parse with the real parser", () => {
  it("has pwsh on PATH (install it: brew install powershell)", () => {
    expect(
      pwsh,
      "pwsh is not on PATH. The Windows release scripts cannot be parse checked without it, " +
        "and text-only checking is what let a syntax error reach a release runner. " +
        "Install PowerShell (macOS: brew install powershell) and run this suite again.",
    ).toBeTruthy()
  })

  // Proves the parser is actually rejecting things, so a green run above means
  // the scripts are clean rather than the check being inert. This is the exact
  // shape that broke the release job.
  it("rejects a scope qualified variable reference inside a double quoted string", () => {
    expect(pwsh).toBeTruthy()
    const planted = runPwshScript(
      ['$Binaries = "C:\\x"', 'Write-Error "no exe under $Binaries: nothing to sign"', ""].join(
        "\n",
      ),
    )
    expect(planted.code).not.toBe(0)
    expect(planted.all).toContain("Variable reference is not valid")
  })

  it("parses every .ps1 under apps/desktop and apps/mobile without an error", () => {
    expect(pwsh).toBeTruthy()
    const run = runPwshFile(PARSER, ["-Path", `${DESKTOP},${MOBILE}`])
    const errors = run.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("ok ") && !line.startsWith("==="))
    expect(errors.join("\n"), "PowerShell parse errors (file:line)").toBe("")
    expect(run.code, run.all).toBe(0)
    // The sweep found the scripts, rather than finding nothing and passing.
    const parsed = run.stdout.split("\n").filter((line) => line.startsWith("ok "))
    expect(parsed.length).toBeGreaterThanOrEqual(7)
    expect(run.stdout).toContain("sign-windows.ps1")
    expect(run.stdout).toContain("verify-windows-registration.ps1")
  })

  it("parses every PowerShell step body in the release workflow too", () => {
    // The .ps1 files are swept above; the workflow's own inline steps were
    // not, and they are the same hazard in the same language. On
    // a Windows runner pwsh is the DEFAULT shell, so a step with no `shell:` key
    // in that job is PowerShell as well, and a syntax error in one of them is
    // twenty minutes of compiling followed by a step that never ran.
    expect(pwsh).toBeTruthy()
    const workflow = loadDesktopReleaseWorkflow()
    const bodies: { name: string; source: string }[] = []
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const defaultsToPwsh = job["runs-on"].includes("windows")
      for (const entry of job.steps) {
        if (!entry.run) continue
        const shell = (entry as { shell?: string }).shell
        if (shell === "pwsh" || (!shell && defaultsToPwsh)) {
          bodies.push({ name: `${jobName} / ${entry.name ?? "unnamed"}`, source: entry.run })
        }
      }
    }
    expect(bodies.length).toBeGreaterThanOrEqual(8)
    // PARSED, never executed: these bodies install dependencies and compile a
    // Rust binary, and a test that ran them would be a test that builds the
    // app. Each one is written out under a name that says where it came from,
    // so a parse error names the step rather than a temp file.
    const dir = mkdtempSync(path.join(tmpdir(), "liaison-workflow-pwsh-"))
    for (const [index, body] of bodies.entries()) {
      // A workflow expression is substituted before pwsh ever sees the body,
      // so one left in here would be parsed as PowerShell and is its own bug.
      expect(body.source, `${body.name} interpolates a workflow expression`).not.toContain("${{")
      const slug = body.name.replace(/[^A-Za-z0-9]+/g, "-")
      writeFileSync(path.join(dir, `${String(index).padStart(2, "0")}-${slug}.ps1`), body.source)
    }
    const run = runPwshFile(PARSER, ["-Path", dir])
    const errors = run.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("ok ") && !line.startsWith("==="))
    expect(errors.join("\n"), "PowerShell parse errors in workflow step bodies").toBe("")
    expect(run.code, run.all).toBe(0)
  })
})

// Logic that is pure enough to run on a Mac. signtool, Get-AuthenticodeSignature
// with a real file, and the uninstall registry key are Windows only: those are
// parse checked above and nothing more.
describe("PowerShell logic that runs on macOS", () => {
  it("ConvertTo-PathEntry normalises a PATH element the way the installer writes it", () => {
    expect(pwsh).toBeTruthy()
    const script = path.join(DESKTOP, "ci", "verify-windows-registration.ps1")
    const run = runPwshScript(
      [
        extractFunction(script, "ConvertTo-PathEntry"),
        '$entries = @(\'  "C:\\Program Files\\Liaison\\"  \', "C:\\Program Files\\Liaison", "C:\\Program Files\\Liaison Extra") | ForEach-Object { ConvertTo-PathEntry $_ }',
        '$wanted = ConvertTo-PathEntry "C:\\Program Files\\Liaison"',
        'Write-Host ("matches=" + @($entries | Where-Object { $_ -eq $wanted }).Count)',
        'Write-Host ("contains=" + ($entries -contains $wanted))',
      ].join("\n"),
    )
    expect(run.code, run.all).toBe(0)
    // Quotes and a trailing separator are the same directory; a longer
    // directory that merely shares the prefix is not.
    expect(run.stdout).toContain("matches=2")
    expect(run.stdout).toContain("contains=True")
  })

  it("Write-SigningMarker writes the marker the publish gate reads", () => {
    expect(pwsh).toBeTruthy()
    const script = path.join(DESKTOP, "ci", "sign-windows.ps1")
    const out = mkdtempSync(path.join(tmpdir(), "liaison-marker-"))
    const run = runPwshScript(
      [
        `$Installers = '${out}'`,
        '$Stage = "installer"',
        '$Publisher = "Mathieu Frohlich"',
        extractFunction(script, "Write-SigningMarker"),
        'Write-SigningMarker -Signed $true -Reason "signtool signed and verified 3 file(s)"',
      ].join("\n"),
    )
    expect(run.code, run.all).toBe(0)
    const marker = JSON.parse(readFileSync(path.join(out, "windows-signing.json"), "utf8"))
    expect(marker.signed).toBe(true)
    expect(marker.publisher).toBe("Mathieu Frohlich")
    expect(marker.reason).toContain("signtool signed and verified")
  })

  it("Get-LiaisonSignatureFailures reports a file that is not there", () => {
    expect(pwsh).toBeTruthy()
    const script = path.join(DESKTOP, "ci", "windows-signature.ps1")
    const run = runPwshScript(
      [
        `. '${script}'`,
        '$failures = Get-LiaisonSignatureFailures -Files @("/nowhere/liaison-sidecar-x86_64.exe")',
        'Write-Host ("count=" + @($failures).Count)',
        "Write-Host (@($failures)[0])",
      ].join("\n"),
    )
    expect(run.code, run.all).toBe(0)
    expect(run.stdout).toContain("count=1")
    expect(run.stdout).toContain("does not exist at")
  })

  it("sign-windows.ps1 takes the documented unsigned skip path with no Azure credential", () => {
    expect(pwsh).toBeTruthy()
    const script = path.join(DESKTOP, "ci", "sign-windows.ps1")
    const run = runPwshFile(script, ["-Stage", "binaries"], { AZURE_CLIENT_ID: "" })
    expect(run.code, run.all).toBe(0)
    expect(run.stdout).toContain("*** UNSIGNED BUILD ***")
    expect(run.stdout).toContain("SKIPPING code signing")
  })

  it("sign-windows.ps1 refuses a stage name it does not know", () => {
    expect(pwsh).toBeTruthy()
    const script = path.join(DESKTOP, "ci", "sign-windows.ps1")
    const run = runPwshFile(script, ["-Stage", "everything"], { AZURE_CLIENT_ID: "" })
    expect(run.code).not.toBe(0)
    expect(run.all).toContain("ValidateSet")
    expect(run.stdout).not.toContain("Liaison desktop Windows signing")
  })
})

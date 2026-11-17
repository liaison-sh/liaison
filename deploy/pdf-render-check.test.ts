// SPDX-License-Identifier: FSL-1.1-ALv2
//
// deploy/pdf-render-check.sh against a `docker` shim: it probes inside the
// render service and from the app with the stack's own compose options, says
// isolated only when every probe passed, and never when a probe failed or
// printed nothing. The probes themselves run against the composed service.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const SCRIPT = path.join(import.meta.dir, "pdf-render-check.sh")

const SHIM = `#!/bin/sh
{ printf '%s' "$*" | tr '\\n' ' '; echo; } >> "$SHIM_STATE/calls.log"
case "$*" in
  *" ps --status running "*) printf '%s\\n' "\${SHIM_RUNNING-pdf-render}" ;;
  *" ps -a "*) printf '%s\\n' "pdf-render restarting Restarting (1) 3 seconds ago" ;;
  *" pdf-render bun "*) [ -n "$SHIM_HANG" ] && sleep 30; printf '%s\\n' "$SHIM_INSIDE" ;;
  *) printf '%s\\n' "$SHIM_APP" ;;
esac
`

const pass = (n: number, from: string) =>
  Array.from({ length: n }, (_, i) => `PASS ${from} probe ${i + 1}`).join("\n")

let dir = ""

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pdf-render-check-"))
  writeFileSync(path.join(dir, "docker"), SHIM)
  chmodSync(path.join(dir, "docker"), 0o755)
  writeFileSync(path.join(dir, "calls.log"), "")
  // The script bounds each probe with coreutils' timeout (in /usr/bin on Linux).
  const timeout = Bun.which("timeout")
  if (timeout) symlinkSync(timeout, path.join(dir, "timeout"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(
  inside: string,
  fromApp: string,
  args: string[] = [],
  extra: Record<string, string> = {},
) {
  const r = Bun.spawnSync(["sh", SCRIPT, ...args], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      SHIM_STATE: dir,
      SHIM_INSIDE: inside,
      SHIM_APP: fromApp,
      ...extra,
    },
  })
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    calls: readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n"),
  }
}

describe("the render service isolation check", () => {
  it("probes inside the service and from the app with the stack's compose options", () => {
    const r = run(pass(11, "inside"), pass(3, "app"), ["-p", "liaison", "--env-file", "/srv/x.env"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("pdf-render: isolated")
    expect(r.calls).toHaveLength(3)
    expect(r.calls[0]).toBe("compose -p liaison --env-file /srv/x.env ps --status running --services")
    expect(r.calls[1]).toStartWith(
      "compose -p liaison --env-file /srv/x.env exec -T -e HOME=/tmp pdf-render bun --eval",
    )
    expect(r.calls[2]).toStartWith("compose -p liaison --env-file /srv/x.env exec -T app bun --eval")
  })

  it("one failed probe fails the check", () => {
    const r = run(
      `${pass(10, "inside")}\nFAIL no connection to postgres (open)`,
      pass(3, "app"),
    )
    expect(r.code).toBe(1)
    expect(r.out).not.toContain("isolated")
  })

  it("probes that printed nothing, or stopped early, fail the check", () => {
    expect(run("", "").code).toBe(1)
    const early = run(pass(11, "inside"), "")
    expect(early.code).toBe(1)
    expect(early.out).toContain("did not finish")
  })

  it("a service that is not running fails at once, with its state, and runs no probe", () => {
    const started = Date.now()
    const r = run(pass(11, "inside"), pass(3, "app"), [], { SHIM_RUNNING: "app" })
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL the pdf-render service is not running (pdf-render restarting")
    expect(r.calls.some((c) => c.includes(" exec "))).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("a probe that hangs fails at its bound with a FAIL line", () => {
    const r = run(pass(11, "inside"), pass(3, "app"), [], {
      SHIM_HANG: "1",
      LIAISON_PDF_RENDER_CHECK_TIMEOUT: "1",
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL the probe inside pdf-render did not finish")
  })
})

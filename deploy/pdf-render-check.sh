#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Checks the isolation of the running render service (service `pdf-render`,
# docs/self-hosting/docker.md) from the inside, then sends it two crafted
# files from the app, as an upload would:
#
#   inside pdf-render  connect() to Postgres, Redis and the internet fails;
#                      no other process (the API's included) is visible, and
#                      no other process's environment can be read; nothing
#                      outside /tmp can be written; its environment holds no
#                      secret; it runs as its own UID, not root and not the
#                      app's
#   from the app       an inflate bomb and a cross-reference cycle are refused
#                      (the service's child is killed), and nothing is kept
#
# Every line it prints is PASS or FAIL; it exits 1 on any FAIL or when a probe
# printed nothing. Compose options go first, as for `docker compose`, and must
# be the ones the stack runs with:
#   deploy/pdf-render-check.sh -p liaison --env-file /srv/liaison.env
set -eu

APP_SERVICE="${LIAISON_PDF_RENDER_CHECK_APP:-app}"

INSIDE_PROBE='
const net = require("node:net")
const fs = require("node:fs")
const out = []
const say = (ok, name, detail) => out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`)
const reach = (host, port) =>
  new Promise((done) => {
    const s = net.connect({ host, port })
    const t = setTimeout(() => { s.destroy(); done("timeout") }, 3000)
    s.on("connect", () => { clearTimeout(t); s.destroy(); done("open") })
    s.on("error", (e) => { clearTimeout(t); done(e.code || "error") })
  })
for (const [name, host, port] of [["postgres", "postgres", 5432], ["redis", "redis", 6379], ["internet", "1.1.1.1", 443]]) {
  const r = await reach(host, port)
  say(r !== "open", `no connection to ${name}`, r)
}
const me = process.pid
let others = 0
let readable = 0
for (const pid of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
  let cmd = ""
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "latin1") } catch { continue }
  if (Number(pid) === me) continue
  if (cmd.includes("src/index.ts") || cmd.includes("liaison-api")) others++
  try {
    if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) { fs.readFileSync(`/proc/${pid}/environ`); readable++ }
  } catch {}
}
say(others === 0, "the API process is not visible", String(others))
say(readable === 0, "no other process environment is readable", String(readable))
for (const p of ["/app/.render-probe", "/etc/.render-probe", "/run/pdf-render/.render-probe"]) {
  let wrote = false
  try { fs.writeFileSync(p, "x"); wrote = true; fs.unlinkSync(p) } catch {}
  say(!wrote, `${p} cannot be written`)
}
let tmp = false
try { fs.writeFileSync("/tmp/.render-probe", "x"); fs.unlinkSync("/tmp/.render-probe"); tmp = true } catch {}
say(tmp, "/tmp can be written")
const secrets = Object.keys(process.env).filter((k) => /SECRET|PASSWORD|PASS$|TOKEN|_KEY$|DATABASE_URL|REDIS_URL|SMTP_/.test(k))
say(secrets.length === 0, "the environment holds no secret", secrets.join(","))
const uid = process.getuid()
say(uid !== 0 && uid !== 1000, "runs as its own user", String(uid))
console.log(out.join("\n"))
'

APP_PROBE='
const { deflateSync } = require("node:zlib")
const { checkUploadedPdf } = await import("/app/apps/api/src/modules/pdf-render/upload.ts")
const out = []
const say = (ok, name, detail) => out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`)
say(Boolean(process.env.LIAISON_PDF_RENDER_SOCKET), "the app reads uploads through the render socket", process.env.LIAISON_PDF_RENDER_SOCKET || "unset")
const bomb = deflateSync(Buffer.alloc(80 * 1024 * 1024))
const bombFile = Buffer.concat([
  Buffer.from(`%PDF-1.7\n9 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${bomb.byteLength} >>\nstream\n`, "latin1"),
  bomb,
  Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
])
const org = "00000000-0000-4000-8000-000000000000"
const b = await checkUploadedPdf(org, new Uint8Array(bombFile))
say(b.status === "refused", "an inflate bomb is refused", b.status === "refused" ? b.code : b.status)
const parts = ["%PDF-1.7\n"]
const offsets = []
const add = (s) => { offsets.push(parts.join("").length); parts.push(s) }
add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
add("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")
add("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n")
const at = parts.join("").length
const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
parts.push(`xref\n0 4\n0000000000 65535 f \n${rows}trailer\n<< /Size 4 /Root 1 0 R /Prev ${at} >>\nstartxref\n${at}\n%%EOF\n`)
const c = await checkUploadedPdf(org, new Uint8Array(Buffer.from(parts.join(""), "latin1")))
say(c.status === "refused", "a cross-reference cycle is refused", c.status === "refused" ? c.code : c.status)
console.log(out.join("\n"))
'

# The service must be running before any probe: a stopped or restarting
# service fails here at once, with its state, instead of hanging the probes.
running=$(docker compose "$@" ps --status running --services 2>&1 || true)
if ! printf '%s\n' "$running" | grep -qx 'pdf-render'; then
  state=$(docker compose "$@" ps -a --format '{{.Service}} {{.State}} {{.Status}}' 2>/dev/null | grep '^pdf-render ' || true)
  echo "FAIL the pdf-render service is not running (${state:-not found}): see docker compose logs pdf-render"
  exit 1
fi

# Every probe is bounded: a probe that hangs prints a FAIL line, not nothing.
PROBE_SECONDS="${LIAISON_PDF_RENDER_CHECK_TIMEOUT:-120}"
bounded() {
  if command -v timeout >/dev/null 2>&1; then timeout "$PROBE_SECONDS" "$@"; else "$@"; fi
}

report=$(
  bounded docker compose "$@" exec -T -e HOME=/tmp pdf-render bun --eval "$INSIDE_PROBE" 2>&1 \
    || echo "FAIL the probe inside pdf-render did not finish (exit $?)"
  bounded docker compose "$@" exec -T "$APP_SERVICE" bun --eval "$APP_PROBE" 2>&1 \
    || echo "FAIL the probe from the app did not finish (exit $?)"
)
printf '%s\n' "$report"

if ! printf '%s\n' "$report" | grep -q '^PASS '; then
  echo "FAIL the probes printed nothing: is the stack running with these compose options?"
  exit 1
fi
if printf '%s\n' "$report" | grep -q '^FAIL '; then exit 1; fi
if [ "$(printf '%s\n' "$report" | grep -c '^PASS ')" -lt 14 ]; then
  echo "FAIL a probe did not finish (expected 14 PASS lines)"
  exit 1
fi
echo "pdf-render: isolated"

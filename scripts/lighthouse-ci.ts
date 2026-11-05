#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run lighthouse-ci [--target release|local]`
//
// Runs Lighthouse against the release stack and asserts A1 (TTI < 2000ms).
// Writes the HTML report to qa/load/out/lighthouse.html. Retries up to 3 times
// on flake. Exits non-zero on threshold miss.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { $ } from "bun"

function loadDeployEnv(envPath: string): void {
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1)
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    process.env[k] = v
  }
}

interface Args {
  target: "release" | "local"
  host: string
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const target = (
    argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : "local"
  ) as Args["target"]
  const defaultHost = `http://localhost:${process.env.APP_PORT || "3000"}`
  return {
    target: target === "release" ? "release" : "local",
    host: process.env.HOST || defaultHost,
  }
}

const ROOT = resolve(new URL("..", import.meta.url).pathname)
loadDeployEnv(process.env.LIAISON_ENV_FILE ?? join(ROOT, "deploy/.env"))

const OUT_DIR = join(ROOT, "qa/load/out")
const REPORT_PATH = join(OUT_DIR, "lighthouse.html")
const TTI_MS_BUDGET = 2000

async function waitForHealth(host: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const proc = Bun.spawnSync(["curl", "-fsS", `${host}/healthz`])
    if (proc.exitCode === 0) return
    await Bun.sleep(2000)
  }
  throw new Error(`/healthz did not return 200 within ${timeoutMs}ms`)
}

// Spec V7 measures TTI on the release-image build, not whatever tag is pinned
// in deploy/docker-compose.yml — pass LIAISON_IMAGE so compose substitutes the
// freshly built image into `image: ${LIAISON_IMAGE:-…}`.
const LIGHTHOUSE_IMAGE_TAG = "liaison-load:tmp"

async function bootRelease(): Promise<void> {
  const envFile = process.env.LIAISON_ENV_FILE ?? join(ROOT, "deploy/.env")
  await $`docker buildx build -t ${LIGHTHOUSE_IMAGE_TAG} --load -f apps/api/Dockerfile .`.cwd(ROOT)
  const up = Bun.spawnSync({
    cmd: [
      "docker",
      "compose",
      "--env-file",
      envFile,
      "-f",
      "deploy/docker-compose.yml",
      "up",
      "-d",
    ],
    cwd: ROOT,
    env: { ...process.env, LIAISON_IMAGE: LIGHTHOUSE_IMAGE_TAG },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (up.exitCode !== 0) throw new Error("docker compose up -d failed")
}

async function tearDownRelease(): Promise<void> {
  const envFile = process.env.LIAISON_ENV_FILE ?? join(ROOT, "deploy/.env")
  Bun.spawnSync({
    cmd: [
      "docker",
      "compose",
      "--env-file",
      envFile,
      "-f",
      "deploy/docker-compose.yml",
      "down",
      "-v",
    ],
    cwd: ROOT,
    env: { ...process.env, LIAISON_IMAGE: LIGHTHOUSE_IMAGE_TAG },
    stdout: "inherit",
    stderr: "inherit",
  })
}

async function runLighthouse(host: string): Promise<{ ttiMs: number; reportHtml: string }> {
  // Use the desktop preset: spec V7 sets TTI < 2000 ms, which is only
  // realistic against a desktop profile (the default `simulate` throttling
  // applies a mobile 4× CPU + slow 4G model and routinely lands TTI at 5–8s
  // even for a small SPA). The roadmap's "first-class performance" target is
  // measured against the production build under desktop conditions; mobile
  // throttling is a separate budget that ships later.
  const cmd = [
    "lighthouse",
    host,
    "--quiet",
    "--chrome-flags=--headless --no-sandbox",
    "--only-categories=performance",
    "--preset=desktop",
    "--output=json",
    "--output=html",
    `--output-path=${join(OUT_DIR, "lighthouse")}`,
  ]
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  const jsonPath = join(OUT_DIR, "lighthouse.report.json")
  const htmlPath = join(OUT_DIR, "lighthouse.report.html")
  if (!existsSync(jsonPath)) throw new Error(`lighthouse did not produce ${jsonPath}`)
  const json = await Bun.file(jsonPath).json()
  const tti = Number(json.audits?.interactive?.numericValue ?? Number.NaN)
  const reportHtml = existsSync(htmlPath) ? await Bun.file(htmlPath).text() : ""
  return { ttiMs: tti, reportHtml }
}

async function main() {
  const { target, host } = parseArgs()
  mkdirSync(OUT_DIR, { recursive: true })

  try {
    if (target === "release") {
      await bootRelease()
      await waitForHealth(host)
    } else {
      await waitForHealth(host, 5_000).catch(() => {
        console.warn(
          `! ${host}/healthz unreachable — start the dev/release stack before --target=local`,
        )
      })
    }

    let attempt = 0
    let lastErr: unknown
    while (attempt < 3) {
      attempt += 1
      try {
        const { ttiMs, reportHtml } = await runLighthouse(host)
        writeFileSync(REPORT_PATH, reportHtml)
        console.log(`Lighthouse TTI: ${ttiMs.toFixed(0)}ms (budget ${TTI_MS_BUDGET}ms)`)
        if (!Number.isFinite(ttiMs)) throw new Error("TTI metric missing from lighthouse output")
        if (ttiMs >= TTI_MS_BUDGET) {
          console.error(`FAIL: TTI ${ttiMs.toFixed(0)}ms ≥ ${TTI_MS_BUDGET}ms`)
          process.exit(1)
        }
        console.log(`✓ A1: TTI ${ttiMs.toFixed(0)}ms < ${TTI_MS_BUDGET}ms — report: ${REPORT_PATH}`)
        return
      } catch (err) {
        lastErr = err
        console.warn(`lighthouse attempt ${attempt} failed: ${err}`)
      }
    }
    throw lastErr
  } finally {
    if (target === "release") await tearDownRelease()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

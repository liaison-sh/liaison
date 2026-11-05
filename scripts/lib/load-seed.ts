// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How `bun run load-test` seeds its workload: `liaison seed --tier load`, run
// where the target's own env and database are (the release stack's app
// container, or apps/api for a local dev stack), and the org it reports.

/** The load org the k6 scripts sign into: `liaison seed --tier load` (one org, with volume). */
export const LOAD_SEED_ARGS = [
  "seed",
  "--tier",
  "load",
  "--orgs",
  "1",
  "--prefix",
  "loadtest-",
  "--volume",
  "--ttl-hours",
  "24",
  "--passwords-env",
  "LOAD_PASSWORD",
]

/**
 * The command that runs the seed CLI on the target: inside the release stack's
 * app container (its own env and database), or from apps/api against the
 * local dev stack.
 */
export function loadSeedCommand(target: "release" | "local", envFile: string): string[] {
  const cli = ["bun", "run", "src/cli/index.ts", ...LOAD_SEED_ARGS]
  if (target === "local") return cli
  return [
    "docker",
    "compose",
    "--env-file",
    envFile,
    "-f",
    "deploy/docker-compose.yml",
    "-f",
    "deploy/docker-compose.loadtest.yml",
    "exec",
    "-T",
    "-e",
    "LOAD_PASSWORD",
    "-w",
    "/app/apps/api",
    "app",
    ...cli,
  ]
}

/** The `[load-seed] result <json>` line the seed CLI prints: the seeded orgs. */
export function parseLoadSeedResult(stdout: string): { slug: string; adminEmail: string }[] {
  const line = stdout.split("\n").find((l) => l.startsWith("[load-seed] result "))
  if (!line) throw new Error("the load seed printed no result line")
  const parsed = JSON.parse(line.slice("[load-seed] result ".length)) as {
    orgs: { slug: string; adminEmail: string }[]
  }
  return parsed.orgs
}

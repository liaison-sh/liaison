// SPDX-License-Identifier: FSL-1.1-ALv2
// `bun run app:create <name>` — scaffold a new Liaison plugin app across the
// backend (`apps/api/src/apps/<name>/`) and frontend
// (`apps/web/src/modules/<name>/`) trees from the template skeletons.
//
// The new app is picked up automatically by the filesystem auto-discovery — no
// edits to kernel code are required.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SCRIPTS_DIR, "..")
const TEMPLATE_BACKEND = join(SCRIPTS_DIR, "templates", "app-template")
const TEMPLATE_FRONTEND = join(SCRIPTS_DIR, "templates", "app-template-web")

// Must match `packageManifestSchema`'s name rule: kebab-case, starts with a letter.
const NAME_REGEX = /^[a-z][a-z0-9-]*$/

export interface CreateAppOptions {
  name: string
  /** Monorepo root. Defaults to the repo root resolved from this script. */
  repoRoot?: string
  /**
   * Out-of-tree target directory. When set, the scaffold lands as a single
   * flat tree at `outDir/` (backend files at the top level, frontend at
   * `outDir/web/`) — bypassing the `apps/api/src/apps/<name>` +
   * `apps/web/src/modules/<name>` split used by in-tree scaffolds.
   *
   * Used for installable plugin apps that live outside the kernel monorepo
   * (e.g. `bundled-apps/shopify/`). When `outDir` is set, `repoRoot`
   * is ignored.
   */
  outDir?: string
}

export interface CreateAppResult {
  name: string
  backendDir: string
  frontendDir: string
}

/** kebab-case → PascalCase, e.g. `my-cool-app` → `MyCoolApp`. */
function toPascalCase(kebab: string): string {
  return kebab
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

/** Apply the placeholder substitution to template file contents. */
function substitute(content: string, name: string): string {
  return content
    .replaceAll("__APP_NAME__", name)
    .replaceAll("__APP_CLASS__", toPascalCase(name))
    .replaceAll("__APP_DESCRIPTION__", "TODO: describe your app")
}

/** Recursively assert no template file collides with an existing file under destDir. */
function assertNoTemplateCollisions(srcDir: string, destDir: string): void {
  if (!existsSync(destDir)) return
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      assertNoTemplateCollisions(join(srcDir, entry.name), destPath)
    } else if (existsSync(destPath)) {
      throw new Error(`Refusing to overwrite existing file: ${destPath}`)
    }
  }
}

/** Copy a template directory into `dest`, substituting placeholders in every file. */
function copyTemplate(srcDir: string, destDir: string, name: string): void {
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      copyTemplate(srcPath, destPath, name)
    } else {
      writeFileSync(destPath, substitute(readFileSync(srcPath, "utf8"), name))
    }
  }
}

export async function createApp(opts: CreateAppOptions): Promise<CreateAppResult> {
  const { name } = opts
  if (!NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid app name '${name}' — must be kebab-case (lowercase, start with a letter, e.g. 'my-app')`,
    )
  }

  let backendDir: string
  let frontendDir: string
  if (opts.outDir) {
    // Out-of-tree mode: flat tree, no apps/api / apps/web split.
    backendDir = opts.outDir
    frontendDir = join(opts.outDir, "web")
  } else {
    const repoRoot = opts.repoRoot ?? REPO_ROOT
    backendDir = join(repoRoot, "apps/api/src/apps", name)
    frontendDir = join(repoRoot, "apps/web/src/modules", name)
  }

  // In-tree mode: collide if the dir exists at all (preserves prior contract).
  // Out-of-tree mode: allow pre-existing sibling files/dirs (scripts/, env, ...)
  // — collide only if any template file would overwrite an existing file.
  if (opts.outDir) {
    assertNoTemplateCollisions(TEMPLATE_BACKEND, backendDir)
    assertNoTemplateCollisions(TEMPLATE_FRONTEND, frontendDir)
  } else {
    if (existsSync(backendDir)) {
      throw new Error(`Backend app directory already exists: ${backendDir}`)
    }
    if (existsSync(frontendDir)) {
      throw new Error(`Frontend module directory already exists: ${frontendDir}`)
    }
  }

  copyTemplate(TEMPLATE_BACKEND, backendDir, name)
  copyTemplate(TEMPLATE_FRONTEND, frontendDir, name)

  return { name, backendDir, frontendDir }
}

// CLI entry point.
if (import.meta.main) {
  const argv = process.argv.slice(2)
  let name: string | undefined
  let outDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out") {
      outDir = argv[++i]
    } else if (a.startsWith("--out=")) {
      outDir = a.slice("--out=".length)
    } else if (!name) {
      name = a
    }
  }
  if (!name) {
    console.error("usage: bun run app:create <name> [--out <dir>]")
    process.exit(1)
  }
  // Resolve outDir relative to the invoker's CWD, not this script's location,
  // so e.g. `cd liaison/bundled-apps && bun ../../scripts/create-app.ts shopify`
  // lands the scaffold at `liaison/bundled-apps/shopify/`.
  if (outDir && !outDir.startsWith("/")) {
    outDir = join(process.cwd(), outDir)
  }
  createApp({ name, outDir })
    .then(({ backendDir, frontendDir }) => {
      console.log(`✓ created app '${name}'`)
      console.log(`  backend:  ${backendDir}`)
      console.log(`  frontend: ${frontendDir}`)
      console.log("")
      console.log("Next steps:")
      console.log("  1. Run `bun dev` — the app is auto-discovered, no kernel edits needed.")
      console.log(`  2. Test your handler: bun test apps/api/src/apps/${name}/`)
      console.log("  3. See docs/app-development.md for the full developer guide.")
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    })
}

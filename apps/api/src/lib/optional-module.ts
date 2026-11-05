// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A module a build may legitimately not carry.
//
// Some opt-in surfaces (the local chaos fault injector, above all) live in
// source that a distribution, or this repository, leaves out. Importing them with a literal
// specifier makes every build that lacks the file fail to compile, even though
// the surface is off. This resolves the module at run time from an absolute
// path instead, and only when the feature is switched on.
//
// It fails CLOSED: a feature that was explicitly enabled but whose module is
// absent refuses to start with a message naming the feature and the path. It
// never degrades to "enabled but silently missing".

import { existsSync } from "node:fs"
import path from "node:path"

/**
 * The local chaos fault injector's routes, mounted by app.ts under CHAOS_DEBUG=1.
 * The injector is not part of this repository: the harness that sets
 * CHAOS_DEBUG names the module's absolute path in CHAOS_DEBUG_INJECTOR_MODULE.
 * Unset, the path is empty and CHAOS_DEBUG=1 refuses to boot.
 */
export function chaosInjectorModulePath(): string {
  return process.env.CHAOS_DEBUG_INJECTOR_MODULE?.trim() ?? ""
}

/**
 * The QA-seed and install harness routes, mounted by app.ts under
 * `qaSeedRoutesEnabled`. They live in apps/api/test-support, which the
 * production image does not carry.
 */
export const QA_SEED_ROUTES_MODULE = path.join(
  import.meta.dir,
  "../../test-support/qa-seed-routes.ts",
)

export class OptionalModuleMissingError extends Error {
  constructor(
    readonly feature: string,
    readonly modulePath: string,
  ) {
    super(
      `${feature} is enabled but its module is not part of this build (${modulePath || "no module path configured"}). ` +
        `Unset the flag, or point it at a module that exists.`,
    )
    this.name = "OptionalModuleMissingError"
  }
}

/**
 * Import the module at `modulePath` (absolute, extension included) for an
 * enabled `feature`. Throws `OptionalModuleMissingError` after logging it when
 * the file is absent; any other import failure propagates unchanged.
 */
export async function importOptionalModule<T>(opts: {
  feature: string
  modulePath: string
  log: (message: string) => void
}): Promise<T> {
  if (opts.modulePath === "" || !existsSync(opts.modulePath)) {
    const err = new OptionalModuleMissingError(opts.feature, opts.modulePath)
    opts.log(err.message)
    throw err
  }
  return (await import(opts.modulePath)) as T
}

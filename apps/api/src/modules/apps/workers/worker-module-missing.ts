// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The typed refusal of a run whose installed app version carries no Worker
// module, on an instance whose apps run on Workers or the sandbox service
// (run-app.ts resolveWorkersTarget; backfill: worker-module-backfill.ts).

export const APP_WORKER_MODULE_MISSING = "app_worker_module_missing"

/**
 * An installed app version that carries no Worker module, on an instance whose
 * apps run on Workers or the sandbox service: reinstall (or republish) it from
 * a package built by this release, or run every app on QuickJS for now
 * (LIAISON_APP_RUNTIME=quickjs, this release only).
 */
export class AppWorkerModuleMissingError extends Error {
  readonly status = 409
  readonly code = APP_WORKER_MODULE_MISSING
  readonly retryable = false
  constructor(
    readonly appName: string,
    readonly version: string | null,
  ) {
    super(
      `${APP_WORKER_MODULE_MISSING}: ${appName}${version ? `@${version}` : ""} has no Worker module, so it cannot run in the sandbox. Reinstall or republish it from a package built by this release; until then LIAISON_APP_RUNTIME=quickjs runs every app on the local sandbox (this release only).`,
    )
    this.name = "AppWorkerModuleMissingError"
  }
}

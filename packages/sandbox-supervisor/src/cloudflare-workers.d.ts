// SPDX-License-Identifier: FSL-1.1-ALv2
// The piece of `cloudflare:workers` the host Worker uses. workerd provides the
// module; it stays external in the host build (host-build.ts).
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected ctx: { props: Props }
    protected env: Env
    constructor(ctx: unknown, env: Env)
  }
}

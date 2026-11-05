// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Synthetic tool registrar. When an inbound MCP connection advertises
// `capabilities.resources` or `capabilities.prompts`, we project a small set
// of synthetic tools onto the kernel registry so the agent can interact with
// resources/prompts using the same tool-call interface as plain `tools/*`.
//
// Resource synthetics: resource_list, resource_read, resource_subscribe,
//                      resource_unsubscribe
// Prompt synthetics:   prompt_list, prompt_get
//
// The synthetics follow the same connection-default rule as upstream tools
// (apps/mcp-manager/default-policy.ts): under `gate_writes`, the read-only ones
// (resource_list, prompt_list, prompt_get) run without approval and the rest park.
// `resource_read` MUST be marked destructive (spec §3.7) so `gate_writes` resolves
// it to `gate`: arbitrary URI fetch is treated as data exfiltration. Subscribe and
// unsubscribe carry no readOnlyHint, so they park too. The annotations reach both
// deciders: the projector's static `gated` flag and the repo annotation cache
// (read by `McpRepo.getPolicyForCall`), written before the projection.

import type { McpRepo, McpToolAnnotations } from "~/apps/mcp-manager/types"
import type { ProjectedToolInput, ToolProjector } from "./projector"

export interface SyntheticToolRegistrarDeps {
  projector: ToolProjector
  repo: McpRepo
}

export interface AdvertisedCapabilities {
  resources: boolean
  prompts: boolean
  /** Whether the upstream advertises any tools — informational only here. */
  tools: boolean
}

export interface RegisterForCapabilitiesArgs {
  orgId: string
  connectionId: string
  slug: string
  exposeViaGateway?: boolean
  capabilities: AdvertisedCapabilities
}

const RESOURCE_TOOLS: ProjectedToolInput[] = [
  {
    name: "resource_list",
    description: "List resources exposed by this MCP server.",
    inputSchema: {
      type: "object",
      properties: { cursor: { type: "string" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "resource_read",
    description:
      "Read a resource by URI. Treated as destructive by default: fetching arbitrary URIs is an exfiltration vector and must be gated under gate_writes.",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string" } },
      required: ["uri"],
    },
    // SPEC §3.7: must resolve to "gate" under gate_writes default.
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "resource_subscribe",
    description:
      "Subscribe to change notifications for a resource. Pass thread_id to route updates into a thread.",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string" }, thread_id: { type: "string" } },
      required: ["uri"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "resource_unsubscribe",
    description: "Cancel a resource subscription by its subscription_id.",
    inputSchema: {
      type: "object",
      properties: { subscription_id: { type: "string" } },
      required: ["subscription_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
]

const PROMPT_TOOLS: ProjectedToolInput[] = [
  {
    name: "prompt_list",
    description: "List prompts exposed by this MCP server.",
    inputSchema: {
      type: "object",
      properties: { cursor: { type: "string" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "prompt_get",
    description: "Fetch a prompt by name. Returns the upstream messages payload verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
]

export class SyntheticToolRegistrar {
  constructor(private readonly deps: SyntheticToolRegistrarDeps) {}

  /**
   * Project the appropriate synthetic tool set based on advertised capabilities.
   * Replaces any previously-registered synthetics for this `(orgId, slug)` by
   * re-projecting through the projector (which retires the slug's tool set).
   *
   * NOTE: this co-projects with `tools/list` — the kernel boot path (Task 27)
   * concatenates upstream tools + synthetics into a single `registerTools` call
   * so the projector retire-on-rewrite semantic keeps both sets in sync.
   */
  async registerForCapabilities(args: RegisterForCapabilitiesArgs): Promise<void> {
    const synthetics: ProjectedToolInput[] = []
    if (args.capabilities.resources) synthetics.push(...RESOURCE_TOOLS)
    if (args.capabilities.prompts) synthetics.push(...PROMPT_TOOLS)
    // Cache the hints before projecting so McpRepo.getPolicyForCall agrees with the
    // projected `gated` flag from the moment the tools appear.
    if (synthetics.length > 0) {
      const annotationRows = synthetics.map((t) => ({
        name: t.name,
        annotations: t.annotations as McpToolAnnotations,
      }))
      await this.deps.repo.upsertToolAnnotations(args.connectionId, annotationRows)
    }
    await this.deps.projector.registerTools({
      orgId: args.orgId,
      connectionId: args.connectionId,
      slug: args.slug,
      exposeViaGateway: args.exposeViaGateway,
      tools: synthetics,
    })
  }
}

/** Exposed for tests + projector composition. */
export { PROMPT_TOOLS, RESOURCE_TOOLS }

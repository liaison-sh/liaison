// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The deployment's host rules applied when an adapter is validated on the
 * server (upload, `config apply`, the CLI, every stored row re-read): the
 * same outbound-fetch classifiers the egress guard uses, so a token host the
 * transport would refuse is refused at upload, with a path-precise issue.
 *
 *   - link-local and metadata addresses: always refused;
 *   - private addresses: refused unless the deployment sets
 *     LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true (a loopback development
 *     host stays accepted by the schema; the runtime gates it on the flag);
 *   - an IPv6 literal embedding an IPv4 address: refused without the flag.
 */
import {
  isLoopbackHostname,
  parseAdapterText,
  type ValidateOptions,
  type ValidateResult,
  validateAdapter,
} from "@liaison/api-connector-core"
import { isAlwaysBlockedIp, isPrivateIp } from "~/lib/ip-classify"

/** Has the operator allowed connector hosts on private and loopback addresses (dev, LAN)? */
export function privateApiConnectorHostsAllowed(): boolean {
  return process.env.LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS === "true"
}

function tokenHostPolicy(hostname: string): string | null {
  if (isAlwaysBlockedIp(hostname)) return "is a link-local or metadata address"
  if (isLoopbackHostname(hostname) || isLoopbackHostname(`[${hostname}]`)) return null
  if (isPrivateIp(hostname) && !privateApiConnectorHostsAllowed()) {
    return "is a private address (allowed only with LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true)"
  }
  return null
}

/** The validation options of this deployment. */
export function adapterValidateOptions(): ValidateOptions {
  return { allowPrivateHosts: privateApiConnectorHostsAllowed(), tokenHostPolicy }
}

export function validateAdapterDocument(input: unknown): ValidateResult {
  return validateAdapter(input, adapterValidateOptions())
}

/**
 * A document read back from storage: validated like a save, except for the
 * rules it may predate (`saveOnlyIssues`), which the caller reports as
 * warnings. A stored adapter never vanishes because a newer rule exists.
 */
export function validateStoredAdapterDocument(input: unknown): ValidateResult {
  return validateAdapter(input, { ...adapterValidateOptions(), stored: true })
}

export function parseAdapterDocument(text: string): ValidateResult {
  return parseAdapterText(text, adapterValidateOptions())
}

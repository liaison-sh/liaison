// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Turning one intercepted Shopify request into one Shopify-shaped response.
//
// Split from provider.ts on purpose: provider.ts is imported by the sandbox
// egress bridge and so is on every deployment's hot path, while THIS module and
// everything it pulls in (the fixtures, the search parser, the node builders)
// are behind a dynamic import that only a demo request ever takes.
import { demoReadContext, demoShopIsRequested, demoShopifyRead, demoShopPayload } from "./reads"
import { DEMO_SHOP_DOMAIN } from "./sentinel"
import { demoShopifyWrite, demoShopifyWriteOperations } from "./writes"

export interface AnswerInput {
  orgId: string
  path: string
  method: string
  body: string | undefined
  unsupported: string
  writeBlocked: string
  json: (body: unknown, status?: number) => Response
  extensions: unknown
}

interface GraphqlRequest {
  document: string
  operationName: string | null
  variables: Record<string, unknown>
}

function parseRequest(body: string | undefined): GraphqlRequest | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as {
      query?: unknown
      operationName?: unknown
      variables?: unknown
    }
    const document = typeof parsed.query === "string" ? parsed.query : ""
    const named =
      typeof parsed.operationName === "string" && parsed.operationName !== ""
        ? parsed.operationName
        : (document.match(/\b(?:query|mutation)\s+(\w+)/)?.[1] ?? null)
    const variables =
      parsed.variables && typeof parsed.variables === "object"
        ? (parsed.variables as Record<string, unknown>)
        : {}
    return { document, operationName: named, variables }
  } catch {
    return null
  }
}

function isMutation(request: GraphqlRequest): boolean {
  return /^\s*mutation\b/m.test(request.document) || /\bmutation\s+\w+/.test(request.document)
}

/**
 * Does this request run one of the demo store's modelled mutations, the only
 * requests that change it (and so the only ones the shared write log keeps)?
 */
export function isDemoShopifyStoreWrite(path: string, body: string | undefined): boolean {
  if (!path.includes("/graphql")) return false
  const request = parseRequest(body)
  if (!request || !isMutation(request) || !request.operationName) return false
  return demoShopifyWriteOperations().includes(request.operationName)
}

export function answerDemoShopify(input: AnswerInput): Response {
  const { json, extensions } = input

  // The OAuth token exchange can only ever be an attempt to become a real
  // install. Refused, loudly, rather than answered with a fake token.
  if (input.path.includes("/admin/oauth/")) {
    return json({ errors: input.writeBlocked }, 403)
  }

  if (!input.path.includes("/graphql")) {
    // The Admin REST surface. The bundled app does not use it; anything that
    // reaches here is asking for something the demo does not model.
    return json(
      { errors: [{ message: input.unsupported, extensions: { code: "DEMO_UNSUPPORTED" } }] },
      404,
    )
  }

  const request = parseRequest(input.body)
  if (!request) {
    return json({
      errors: [{ message: input.unsupported, extensions: { code: "DEMO_UNSUPPORTED" } }],
    })
  }

  if (isMutation(request)) {
    const data = request.operationName
      ? demoShopifyWrite(request.operationName, {
          orgId: input.orgId,
          variables: request.variables,
          refusal: input.writeBlocked,
        })
      : undefined
    if (!data) {
      return json({
        data: null,
        errors: [
          {
            message: input.writeBlocked,
            extensions: { code: "DEMO_WRITE_BLOCKED", operation: request.operationName },
          },
        ],
        extensions,
      })
    }
    return json({ data, extensions })
  }

  const handler = request.operationName ? demoShopifyRead(request.operationName) : undefined
  if (handler) {
    const ctx = demoReadContext(input.orgId, request.variables, request.document)
    return json({ data: handler(ctx), extensions })
  }
  // Several call sites probe the connection with an unnamed `{ shop { ... } }`.
  if (demoShopIsRequested(request.document)) {
    return json({ data: demoShopPayload(DEMO_SHOP_DOMAIN), extensions })
  }
  return json({
    data: null,
    errors: [
      {
        message: input.unsupported,
        extensions: { code: "DEMO_UNSUPPORTED", operation: request.operationName },
      },
    ],
    extensions,
  })
}

// SPDX-License-Identifier: FSL-1.1-ALv2
import Ajv, { type Options, type SchemaObject, type ValidateFunction } from "ajv"
import { withFormats } from "~/lib/ajv-formats"
import { manifestAjvRegExp } from "~/lib/manifest-regex"

// Formats (uuid): ~/lib/ajv-formats. Strict mode stays on here: a manifest
// naming any other format still fails to compile, and the bundled-manifest
// compile test catches it.

/**
 * A compile-once cache of JSON Schema validators whose entries die with their
 * schema object.
 *
 * Tool param schemas are replaced whenever an app re-registers at a new version
 * in the same process. A single shared Ajv cannot let the old ones go: besides
 * its `_cache`, its code-generation `scope` keeps a reference to every schema and
 * validator it ever compiled, and `removeSchema` does not clear that. So each
 * schema is compiled by its own short-lived Ajv, reachable only from the
 * validator it produced, and the validator is held weakly by its schema.
 *
 * Measured on the 252 bundled-app tool schemas: a fresh instance costs about
 * 60us and the whole compile about 0.43-0.54ms, the same as the shared-instance
 * compile (0.42-0.45ms). A fresh instance that also checked the schema against
 * the meta-schema cost 4.1ms, because every instance compiles the meta-schema
 * again, so that check runs once, on one shared instance, which validates the
 * schema as data and keeps no reference to it. It throws the same "schema is
 * invalid" error `compile` would.
 */
/**
 * A47. Manifest tool parameter DEFAULTS, filled for the handler and for nobody else.
 *
 * Validation deliberately runs without `useDefaults`, so the approval policy and the approval
 * card keep seeing exactly what the agent sent: a default silently added before the policy would
 * make a card show a value the agent never chose. But a declared default is still the handler's
 * contract, and until now it never reached one.
 *
 * So the fill is a SECOND pass, over a CLONE, run after the policy and immediately before the
 * handler. It is its own Ajv with `useDefaults` and nothing else: no `coerceTypes` (a default is
 * an addition, never a rewrite of a value the caller did send), and the result is discarded if
 * the schema does not validate the clone, which cannot happen after validateParamsForTool but
 * costs nothing to guarantee.
 */
function compileDefaultFiller(schema: SchemaObject, options: Options): ValidateFunction {
  return withFormats(
    new Ajv({
      ...options,
      validateSchema: false,
      useDefaults: true,
      coerceTypes: false,
      code: { regExp: manifestAjvRegExp },
    }),
  ).compile(schema)
}

/**
 * A47b. Why a default can be refused at REGISTRATION.
 *
 * Ajv in strict mode throws when a `default` sits where it cannot apply: inside a `oneOf`,
 * `anyOf` or `if` branch ("strict mode: default is ignored for: data.x"). The filler compiles
 * lazily, at the tool's FIRST dispatch, which is after the policy has judged the call and after
 * the approval card has been shown: the throw would land on a call that was already authorized.
 * So the same compile runs when the manifest is registered, and a manifest carrying such a
 * default is refused there, with the tool and the ajv message named.
 *
 * Returns the message, or undefined when the schema's defaults compile.
 */
export function defaultFillerCompileError(
  schema: SchemaObject,
  options: Options,
): string | undefined {
  try {
    compileDefaultFiller(schema, options)
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function createDefaultFillerCache(
  options: Options,
): (schema: SchemaObject, params: unknown) => unknown {
  const fillers = new WeakMap<SchemaObject, ValidateFunction>()
  return (schema, params) => {
    if (params === null || typeof params !== "object" || Array.isArray(params)) return params
    let fill = fillers.get(schema)
    if (!fill) {
      fill = compileDefaultFiller(schema, options)
      fillers.set(schema, fill)
    }
    const clone = structuredClone(params)
    // `useDefaults` mutates the clone in place while validating it.
    return fill(clone) ? clone : params
  }
}

export function createParamValidatorCache(
  options: Options,
): (schema: SchemaObject) => ValidateFunction {
  const metaSchemaAjv = withFormats(new Ajv(options))
  const validators = new WeakMap<SchemaObject, ValidateFunction>()
  return (schema) => {
    let validate = validators.get(schema)
    if (!validate) {
      metaSchemaAjv.validateSchema(schema, true)
      validate = withFormats(
        new Ajv({ ...options, validateSchema: false, code: { regExp: manifestAjvRegExp } }),
      ).compile(schema)
      validators.set(schema, validate)
    }
    return validate
  }
}

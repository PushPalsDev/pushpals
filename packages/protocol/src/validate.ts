import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv({ strict: true });

// Add format validators for date-time, etc.
addFormats(ajv);

/**
 * Expected runtime layout (after `npm run build` / `bun --cwd packages/protocol build`):
 *
 * packages/protocol/dist/index.js
 * packages/protocol/dist/validate.js
 * packages/protocol/dist/schemas/*.json
 *
 * The loader below prefers `dist/schemas` when running compiled JS and falls
 * back to `../src/schemas` during development. The `scripts/copy-schemas.js`
 * build step copies `src/schemas` into `dist/schemas` to satisfy runtime loads.
 */

/**
 * Load schema from file. Deterministic order:
 * 1. Built/runtime: `dist/schemas` (when running compiled JS)
 * 2. Development: `src/schemas` (when running from source)
 */
function loadSchema(filename: string): Record<string, unknown> {
  const distSchemasPath = join(__dirname, "schemas", filename); // dist/schemas when compiled
  const srcSchemasPath = join(__dirname, "..", "src", "schemas", filename); // src/schemas during development
  const envSchemasDir = String(process.env.PUSHPALS_PROTOCOL_SCHEMAS_DIR ?? "").trim();
  const envSchemasPath = envSchemasDir ? join(envSchemasDir, filename) : "";
  const candidates = [distSchemasPath, srcSchemasPath, envSchemasPath].filter(Boolean);

  for (const pathValue of candidates) {
    try {
      return JSON.parse(readFileSync(pathValue, "utf-8"));
    } catch {
      // try next path
    }
  }

  throw new Error(
    `Failed to load schema ${filename}. Expected at dist/schemas (build), src/schemas (dev), or PUSHPALS_PROTOCOL_SCHEMAS_DIR.`,
  );
}

// Load schemas
const envelopeSchema = loadSchema("envelope.schema.json");
const eventsSchema = loadSchema("events.schema.json");
const httpSchema = loadSchema("http.schema.json");

// Register schemas with AJV (helps with $ref resolution across files)
try {
  ajv.addSchema(envelopeSchema as object, "envelope.schema.json");
  ajv.addSchema(eventsSchema as object, "events.schema.json");
  ajv.addSchema(httpSchema as object, "http.schema.json");
} catch (_e) {
  // addSchema may throw in strict modes for malformed schemas; compilation below
  // will still attempt to compile standalone validators.
}

// Compile validators
const validateEnvelopeBase = ajv.compile(envelopeSchema as object);
const validateEventPayload = ajv.compile(eventsSchema as object);
const validateMessageRequestSchema = ajv.compile({
  $ref: "http.schema.json#/definitions/MessageRequest",
});
const validateMessageResponseSchema = ajv.compile({
  $ref: "http.schema.json#/definitions/MessageResponse",
});
const validateApprovalDecisionRequestSchema = ajv.compile({
  $ref: "http.schema.json#/definitions/ApprovalDecisionRequest",
});
const validateApprovalDecisionResponseSchema = ajv.compile({
  $ref: "http.schema.json#/definitions/ApprovalDecisionResponse",
});
const validateCommandRequestSchema = ajv.compile({
  $ref: "http.schema.json#/definitions/CommandRequest",
});
const validateSessionEventFrameSchema = ajv.compile({
  $ref: "http.schema.json#/definitions/SessionEventFrame",
});

export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

/**
 * Validate an EventEnvelope against the full schema
 */
export function validateEventEnvelope(data: unknown): ValidationResult {
  const baseValid = validateEnvelopeBase(data);
  if (!baseValid) {
    const errors = (validateEnvelopeBase.errors ?? []).map((e) =>
      `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
    );
    return { ok: false, errors };
  }

  // Validate only the `{ type, payload }` pairing against the events schema.
  // This ensures branch validation focuses on the event discriminant and
  // its payload shape, while envelope-level fields are handled above.
  const maybe = data as any;
  const pair = { type: maybe?.type, payload: maybe?.payload };

  const payloadValid = validateEventPayload(pair);
  if (!payloadValid) {
    const errors = (validateEventPayload.errors ?? []).map((e) =>
      `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
    );
    return { ok: false, errors };
  }

  return { ok: true };
}

export function validateMessageRequest(data: unknown): ValidationResult {
  const valid = validateMessageRequestSchema(data);
  return {
    ok: valid,
    errors: valid ? undefined : ajv.errorsText(validateMessageRequestSchema.errors).split(", "),
  };
}

export function validateMessageResponse(data: unknown): ValidationResult {
  const valid = validateMessageResponseSchema(data);
  return {
    ok: valid,
    errors: valid ? undefined : ajv.errorsText(validateMessageResponseSchema.errors).split(", "),
  };
}

export function validateApprovalDecisionRequest(data: unknown): ValidationResult {
  const valid = validateApprovalDecisionRequestSchema(data);
  return {
    ok: valid,
    errors: valid
      ? undefined
      : ajv.errorsText(validateApprovalDecisionRequestSchema.errors).split(", "),
  };
}

export function validateApprovalDecisionResponse(data: unknown): ValidationResult {
  const valid = validateApprovalDecisionResponseSchema(data);
  return {
    ok: valid,
    errors: valid
      ? undefined
      : ajv.errorsText(validateApprovalDecisionResponseSchema.errors).split(", "),
  };
}

export function validateCommandRequest(data: unknown): ValidationResult {
  const valid = validateCommandRequestSchema(data);
  return {
    ok: valid,
    errors: valid ? undefined : ajv.errorsText(validateCommandRequestSchema.errors).split(", "),
  };
}

export function validateSessionEventFrame(data: unknown): ValidationResult {
  const valid = validateSessionEventFrameSchema(data);
  if (!valid) {
    return {
      ok: false,
      errors: ajv.errorsText(validateSessionEventFrameSchema.errors).split(", "),
    };
  }
  return validateEventEnvelope((data as { envelope: unknown }).envelope);
}

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

  try {
    return JSON.parse(readFileSync(distSchemasPath, "utf-8"));
  } catch (_e1) {
    try {
      return JSON.parse(readFileSync(srcSchemasPath, "utf-8"));
    } catch (_e2) {
      throw new Error(
        `Failed to load schema ${filename}. Expected at dist/schemas (build) or src/schemas (dev).`
      );
    }
  }
}

// Load and compile schemas
const envelopeSchema = loadSchema("envelope.schema.json");
const eventsSchema = loadSchema("events.schema.json");

// Compile validators
const validateEnvelopeBase = ajv.compile(envelopeSchema);
const validateEventPayload = ajv.compile(eventsSchema);
const validateMessageRequestSchema = ajv.compile({
  type: "object",
  required: ["text"],
  properties: {
    text: { type: "string" },
  },
  additionalProperties: false,
});
const validateMessageResponseSchema = ajv.compile({
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
  },
  additionalProperties: false,
});
const validateApprovalDecisionRequestSchema = ajv.compile({
  type: "object",
  required: ["decision"],
  properties: {
    decision: {
      type: "string",
      enum: ["approve", "deny"],
    },
  },
  additionalProperties: false,
});
const validateApprovalDecisionResponseSchema = ajv.compile({
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
  },
  additionalProperties: false,
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
    return {
      ok: false,
      errors: ajv.errorsText(validateEnvelopeBase.errors).split(", "),
    };
  }

  const payloadValid = validateEventPayload(data);
  if (!payloadValid) {
    return {
      ok: false,
      errors: ajv.errorsText(validateEventPayload.errors).split(", "),
    };
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
    errors: valid ? undefined : ajv.errorsText(validateApprovalDecisionRequestSchema.errors).split(", "),
  };
}

export function validateApprovalDecisionResponse(data: unknown): ValidationResult {
  const valid = validateApprovalDecisionResponseSchema(data);
  return {
    ok: valid,
    errors: valid ? undefined : ajv.errorsText(validateApprovalDecisionResponseSchema.errors).split(", "),
  };
}

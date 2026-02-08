import Ajv from "ajv";
import addFormats from "ajv-formats";
import envelopeSchema from "./schemas/envelope.schema.json";
import eventsSchema from "./schemas/events.schema.json";

const ajv = new Ajv({ strict: true });
addFormats(ajv);

// Register schemas to help $ref linking when present
try {
  ajv.addSchema(envelopeSchema as object, "envelope.schema.json");
  ajv.addSchema(eventsSchema as object, "events.schema.json");
} catch (_e) {
  // ignore addSchema failures; we'll still compile below
}

const validateEnvelopeBase = ajv.compile(envelopeSchema as unknown as object);
const validateEventPayload = ajv.compile(eventsSchema as unknown as object);

const validateMessageRequestSchema = ajv.compile({
  type: "object",
  required: ["text"],
  properties: { text: { type: "string" } },
  additionalProperties: false,
});

const validateMessageResponseSchema = ajv.compile({
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
  additionalProperties: false,
});

const validateApprovalDecisionRequestSchema = ajv.compile({
  type: "object",
  required: ["decision"],
  properties: { decision: { type: "string", enum: ["approve", "deny"] } },
  additionalProperties: false,
});

const validateApprovalDecisionResponseSchema = ajv.compile({
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
  additionalProperties: false,
});

export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

export function validateEventEnvelope(data: unknown): ValidationResult {
  const baseValid = validateEnvelopeBase(data);
  if (!baseValid) {
    const errors = (validateEnvelopeBase.errors ?? []).map((e) =>
      `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
    );
    return { ok: false, errors };
  }

  const payloadValid = validateEventPayload(data);
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
  const errors = valid
    ? undefined
    : (validateMessageRequestSchema.errors ?? []).map((e) =>
        `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
      );
  return { ok: valid, errors };
}

export function validateMessageResponse(data: unknown): ValidationResult {
  const valid = validateMessageResponseSchema(data);
  const errors = valid
    ? undefined
    : (validateMessageResponseSchema.errors ?? []).map((e) =>
        `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
      );
  return { ok: valid, errors };
}

export function validateApprovalDecisionRequest(data: unknown): ValidationResult {
  const valid = validateApprovalDecisionRequestSchema(data);
  const errors = valid
    ? undefined
    : (validateApprovalDecisionRequestSchema.errors ?? []).map((e) =>
        `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
      );
  return { ok: valid, errors };
}

export function validateApprovalDecisionResponse(data: unknown): ValidationResult {
  const valid = validateApprovalDecisionResponseSchema(data);
  const errors = valid
    ? undefined
    : (validateApprovalDecisionResponseSchema.errors ?? []).map((e) =>
        `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
      );
  return { ok: valid, errors };
}

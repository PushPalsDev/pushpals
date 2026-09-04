import Ajv from "ajv";
import addFormats from "ajv-formats";
import envelopeSchema from "./schemas/envelope.schema.json";
import eventsSchema from "./schemas/events.schema.json";
import httpSchema from "./schemas/http.schema.json";

const ajv = new Ajv({ strict: true });
addFormats(ajv);

// Register schemas to help $ref linking when present
try {
  ajv.addSchema(envelopeSchema as object, "envelope.schema.json");
  ajv.addSchema(eventsSchema as object, "events.schema.json");
  ajv.addSchema(httpSchema as object, "http.schema.json");
} catch (_e) {
  // ignore addSchema failures; we'll still compile below
}

const validateEnvelopeBase = ajv.compile(envelopeSchema as unknown as object);
const validateEventPayload = ajv.compile(eventsSchema as unknown as object);

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

export function validateEventEnvelope(data: unknown): ValidationResult {
  const baseValid = validateEnvelopeBase(data);
  if (!baseValid) {
    const errors = (validateEnvelopeBase.errors ?? []).map((e) =>
      `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
    );
    return { ok: false, errors };
  }

  // Validate only the `{ type, payload }` pairing against the events schema.
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

export function validateCommandRequest(data: unknown): ValidationResult {
  const valid = validateCommandRequestSchema(data);
  const errors = valid
    ? undefined
    : (validateCommandRequestSchema.errors ?? []).map((e) =>
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

export function validateSessionEventFrame(data: unknown): ValidationResult {
  const valid = validateSessionEventFrameSchema(data);
  if (!valid) {
    const errors = (validateSessionEventFrameSchema.errors ?? []).map((e) =>
      `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
    );
    return { ok: false, errors };
  }
  return validateEventEnvelope((data as { envelope: unknown }).envelope);
}

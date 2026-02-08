export { PROTOCOL_VERSION } from "./version.js";
export type {
  EventEnvelope,
  AnyEventEnvelope,
  EventType,
  EventPayload,
  EventTypePayloadMap,
  CreateSessionResponse,
  MessageRequest,
  MessageResponse,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
} from "./types.js";
export {
  validateEventEnvelope,
  validateMessageRequest,
  validateMessageResponse,
  validateApprovalDecisionRequest,
  validateApprovalDecisionResponse,
  type ValidationResult,
} from "./validate.browser";

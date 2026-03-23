/**
 * A2A Protocol Adapter Placeholders
 *
 * This file contains placeholder interfaces for A2A integration.
 * No implementation yet; serves as a design document and future interface.
 */

/**
 * Represents the mapping between PushPals approval workflow
 * and A2A tool invocation + result pattern.
 */
export interface A2AApprovalMapping {
  /**
   * PushPals approvalId ↔ A2A invocationId
   */
  approvalId: string;
  invocationId: string;

  /**
   * PushPals action (git.commit, git.push, etc.) ↔ A2A tool name
   */
  pushpalsAction: string;
  a2aToolName: string;
}

/**
 * Represents the mapping between PushPals EventEnvelope
 * and A2A message envelope.
 */
export interface A2AEventMapping {
  /**
   * PushPals msgId ↔ A2A message id
   */
  pushpalsMessageId: string;
  a2aMessageId: string;

  /**
   * Event type mapping (e.g., "approval_required" → "tool_invocation")
   */
  pushpalsEventType: string;
  a2aMessageType: string;

  /**
   * Whether the payload needs re-serialization to comply with A2A spec
   */
  requiresPayloadTransform: boolean;
}

/**
 * Future: adapter functions will live here
 *
 * export function pushpalsToA2AMessage(envelope: EventEnvelope): A2AMessage { ... }
 * export function a2aMessageToPushpals(message: A2AMessage): EventEnvelope { ... }
 * export function createApprovalMapping(approval: ApprovalRequiredEvent, tool: A2ATool): A2AApprovalMapping { ... }
 */

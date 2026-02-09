import { validateEventEnvelope, PROTOCOL_VERSION } from "protocol";
import { randomUUID } from "crypto";

const event = {
  protocolVersion: PROTOCOL_VERSION,
  id: randomUUID(),
  ts: new Date().toISOString(),
  sessionId: randomUUID(),
  type: "assistant_message",
  payload: { text: "Got it — I'm going to plan tasks..." },
};

const res = validateEventEnvelope(event);
console.log(JSON.stringify(res, null, 2));

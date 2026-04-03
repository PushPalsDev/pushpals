import { describe, expect, test } from "bun:test";
import {
  buildClientIdentityStorageKey,
  resolveClientRegistration,
} from "../apps/client/src/lib/clientIdentity";

describe("client identity resolution", () => {
  test("reuses a persisted client id for the same kind and session", async () => {
    const store = new Map<string, string>();
    let writes = 0;
    const read = async (key: string) => store.get(key) ?? null;
    const write = async (key: string, value: string) => {
      writes += 1;
      store.set(key, value);
    };

    const first = await resolveClientRegistration({ kind: "web", label: "Web Client" }, "dev", {
      read,
      write,
      createId: (kind) => `${kind}-generated`,
    });
    const second = await resolveClientRegistration({ kind: "web", label: "Web Client" }, "dev", {
      read,
      write,
      createId: (kind) => `${kind}-different`,
    });

    expect(buildClientIdentityStorageKey("web", "dev")).toBe("pushpals:client-id:web:dev");
    expect(first.clientId).toBe("web-generated");
    expect(second.clientId).toBe("web-generated");
    expect(writes).toBe(1);
  });

  test("prefers an explicit client id over persisted storage", async () => {
    const store = new Map<string, string>([["pushpals:client-id:web:dev", "web-stored"]]);

    const client = await resolveClientRegistration(
      {
        clientId: "web-explicit",
        kind: "web",
        label: "Web Client",
        version: "1.2.3",
      },
      "dev",
      {
        read: async (key) => store.get(key) ?? null,
        write: async () => {
          throw new Error("write should not be called when clientId is explicit");
        },
      },
    );

    expect(client).toMatchObject({
      clientId: "web-explicit",
      kind: "web",
      label: "Web Client",
      version: "1.2.3",
    });
  });
});

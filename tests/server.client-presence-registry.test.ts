import { describe, expect, test } from "bun:test";
import { ClientPresenceRegistry } from "../apps/server/src/client_presence";

describe("server client presence registry", () => {
  test("keeps overlapping same-transport connections independent until each one disconnects", () => {
    const registry = new ClientPresenceRegistry();
    const client = {
      clientId: "web-1",
      kind: "web",
      label: "Web Client",
    };

    registry.connect("demo", client, "sse", "conn-a");
    registry.connect("demo", client, "sse", "conn-b");

    let snapshot = registry.snapshot();
    expect(snapshot.connected).toBe(1);
    expect(snapshot.items[0]).toMatchObject({
      clientId: "web-1",
      status: "connected",
      connectedTransports: ["sse"],
    });

    registry.disconnect("web-1", "sse", "conn-a");

    snapshot = registry.snapshot();
    expect(snapshot.connected).toBe(1);
    expect(snapshot.items[0]).toMatchObject({
      clientId: "web-1",
      status: "connected",
      connectedTransports: ["sse"],
    });

    registry.disconnect("web-1", "sse", "conn-b");

    snapshot = registry.snapshot();
    expect(snapshot.connected).toBe(0);
    expect(snapshot.items[0]).toMatchObject({
      clientId: "web-1",
      status: "announced",
      connectedTransports: [],
    });
  });

  test("pruneExpired removes stale announced clients without relying on snapshot polling", () => {
    let now = 1_000;
    const registry = new ClientPresenceRegistry({
      retentionMs: 50,
      now: () => now,
    });

    registry.announce(
      "demo",
      {
        clientId: "web-stale",
        kind: "web",
        label: "Web Client",
      },
      "session",
    );

    now += 75;

    expect(registry.pruneExpired()).toBe(1);
    expect(registry.snapshot()).toMatchObject({
      total: 0,
      connected: 0,
      items: [],
    });
  });

  test("pruneExpired removes stale connected clients when heartbeats stop", () => {
    let now = 2_000;
    const registry = new ClientPresenceRegistry({
      retentionMs: 5_000,
      connectedRetentionMs: 50,
      now: () => now,
    });

    registry.connect(
      "demo",
      {
        clientId: "vscode-stale",
        kind: "vscode",
        label: "VS Code",
      },
      "ws",
      "conn-1",
    );
    registry.touch("vscode-stale", "ws", "conn-1");

    now += 75;

    expect(registry.pruneExpired()).toBe(1);
    expect(registry.snapshot()).toMatchObject({
      total: 0,
      connected: 0,
      items: [],
    });
  });
});

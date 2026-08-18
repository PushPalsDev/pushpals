import { describe, expect, test } from "bun:test";
import { CompletionLeaseRenewalCoordinator } from "../apps/source_control_manager/src/completion_lease";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SourceControlManager completion lease renewal", () => {
  test("required publication barrier fails when its shared heartbeat renewal fails", async () => {
    const renewal = deferred<{ ok: boolean; detail: string }>();
    let attempts = 0;
    const coordinator = new CompletionLeaseRenewalCoordinator(async () => {
      attempts += 1;
      return renewal.promise;
    });

    const heartbeat = coordinator.renew(false);
    const publicationBarrier = coordinator.renew(true);
    const observedBarrier = publicationBarrier.then(
      () => null,
      (error: unknown) => error,
    );
    renewal.resolve({ ok: false, detail: "renewal endpoint returned HTTP 503" });

    await expect(heartbeat).resolves.toBe(false);
    expect(await observedBarrier).toBeInstanceOf(Error);
    expect(String(await observedBarrier)).toContain("renewal endpoint returned HTTP 503");
    expect(attempts).toBe(1);
  });

  test("required publication barrier accepts the same confirmed renewal", async () => {
    const renewal = deferred<{ ok: boolean }>();
    let attempts = 0;
    const coordinator = new CompletionLeaseRenewalCoordinator(async () => {
      attempts += 1;
      return renewal.promise;
    });

    const heartbeat = coordinator.renew(false);
    const publicationBarrier = coordinator.renew(true);
    renewal.resolve({ ok: true });

    await expect(heartbeat).resolves.toBe(true);
    await expect(publicationBarrier).resolves.toBe(true);
    expect(attempts).toBe(1);
  });

  test("required publication barrier fails closed on a transport exception", async () => {
    const renewal = deferred<{ ok: boolean }>();
    const coordinator = new CompletionLeaseRenewalCoordinator(() => renewal.promise);

    const heartbeat = coordinator.renew(false);
    const publicationBarrier = coordinator.renew(true);
    const observedBarrier = publicationBarrier.then(
      () => null,
      (error: unknown) => error,
    );
    renewal.reject(new Error("server connection closed"));

    await expect(heartbeat).resolves.toBe(false);
    expect(await observedBarrier).toBeInstanceOf(Error);
    expect(String(await observedBarrier)).toContain("server connection closed");
  });

  test("permanently latches an explicit lease loss", async () => {
    let attempts = 0;
    const coordinator = new CompletionLeaseRenewalCoordinator(async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, leaseLost: true, detail: "claim token is stale" }
        : { ok: true };
    });

    await expect(coordinator.renew(false)).resolves.toBe(false);
    expect(coordinator.hasLostLease()).toBe(true);
    await expect(coordinator.renew(true)).rejects.toThrow("claim token is stale");
    expect(attempts).toBe(1);
  });
});

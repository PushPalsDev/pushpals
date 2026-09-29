import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  NPM_PROPAGATION_LIMITS,
  parseNpmPropagationArgs,
  waitForNpmPackage,
  type NpmPropagationResult,
} from "../scripts/release-wait-for-npm";

const packageName = "@fixture/example";
const version = "1.2.3";
const tarballUrl = "https://registry.npmjs.org/@fixture/example/-/example-1.2.3.tgz";
const tarball = Buffer.from("complete fixture tarball bytes");
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
const metadata = (overrides: Record<string, unknown> = {}) =>
  Response.json({
    name: packageName,
    version,
    dist: { tarball: tarballUrl, integrity },
    ...overrides,
  });

function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
  };
}

describe("bounded npm registry propagation", () => {
  test("waits through seven-minute metadata/tarball propagation without retrying publication", async () => {
    const fake = clock();
    const urls: string[] = [];
    const observations: NpmPropagationResult[] = [];
    const result = await waitForNpmPackage({
      packageName,
      version,
      ...fake,
      onAttempt: (entry) => observations.push(entry),
      fetcher: async (url, init) => {
        urls.push(url);
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("error");
        expect(init.credentials).toBe("omit");
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        expect(new Headers(init.headers).has("cookie")).toBe(false);
        expect(init.signal).toBeInstanceOf(AbortSignal);
        if (url === tarballUrl)
          return fake.now() < 420_000
            ? new Response("private error", { status: 404 })
            : new Response(tarball);
        expect(url).toBe("https://registry.npmjs.org/%40fixture%2Fexample/1.2.3");
        return fake.now() < 390_000 ? new Response("private error", { status: 404 }) : metadata();
      },
    });
    expect(result).toEqual({ available: true, attempts: 29, elapsedMs: 420_000, reason: "ready" });
    expect(observations.some((entry) => entry.reason === "metadata_http_404")).toBe(true);
    expect(observations.some((entry) => entry.reason === "tarball_http_404")).toBe(true);
    expect(urls.filter((url) => url === tarballUrl)).toHaveLength(3);
    expect(JSON.stringify(observations)).not.toContain("private error");
  });

  test("fails closed at the overall deadline and does not sleep past it", async () => {
    const fake = clock();
    let requests = 0;
    const result = await waitForNpmPackage({
      packageName,
      version,
      ...fake,
      timeoutMs: 35,
      pollIntervalMs: 20,
      fetcher: async () => {
        requests++;
        return new Response(null, { status: 404 });
      },
    });
    expect(result).toEqual({
      available: false,
      attempts: 2,
      elapsedMs: 35,
      reason: "metadata_http_404",
    });
    expect(fake.sleeps).toEqual([20, 15]);
    expect(requests).toBe(2);
  });

  test("has a fixed attempt cap even with a broken injected clock", async () => {
    const result = await waitForNpmPackage({
      packageName,
      version,
      now: () => 0,
      sleep: async () => {},
      fetcher: async () => new Response(null, { status: 503 }),
    });
    expect(result.available).toBe(false);
    expect(result.attempts).toBe(NPM_PROPAGATION_LIMITS.attempts);
  });

  test.each([
    { name: "other" },
    { version: "1.2.4" },
    { dist: { tarball: "https://other.invalid/private.tgz", integrity } },
    { dist: { tarball: "http://registry.npmjs.org/example.tgz", integrity } },
    { dist: { tarball: "https://secret@registry.npmjs.org/example.tgz", integrity } },
    { dist: { tarball: `${tarballUrl}?token=secret`, integrity } },
    { dist: { tarball: `${tarballUrl}#secret`, integrity } },
    { dist: { tarball: tarballUrl, integrity: "sha512-invalid" } },
    { dist: { tarball: tarballUrl } },
  ])("rejects mismatched/unsafe metadata without fetching its tarball: %j", async (overrides) => {
    let calls = 0;
    const result = await waitForNpmPackage({
      packageName,
      version,
      ...clock(),
      timeoutMs: 1000,
      fetcher: async () => {
        calls++;
        return metadata(overrides);
      },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("metadata_invalid");
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("a successful HEAD/status or partial tarball is not enough: complete hash must match", async () => {
    const fake = clock();
    const observations: NpmPropagationResult[] = [];
    const result = await waitForNpmPackage({
      packageName,
      version,
      ...fake,
      timeoutMs: 20,
      pollIntervalMs: 10,
      onAttempt: (entry) => observations.push(entry),
      fetcher: async (url) =>
        url !== tarballUrl
          ? metadata()
          : new Response(fake.now() === 0 ? tarball.subarray(0, 4) : tarball),
    });
    expect(observations[0]?.reason).toBe("tarball_integrity_mismatch");
    expect(result.available).toBe(true);
    expect(result.attempts).toBe(2);
  });

  test("supports the registry shasum fallback when SRI is absent", async () => {
    const result = await waitForNpmPackage({
      packageName,
      version,
      ...clock(),
      fetcher: async (url) =>
        url === tarballUrl
          ? new Response(tarball)
          : metadata({
              dist: {
                tarball: tarballUrl,
                shasum: createHash("sha1").update(tarball).digest("hex"),
              },
            }),
    });
    expect(result.available).toBe(true);
  });

  test.each(["metadata", "tarball"])(
    "bounds stalled %s bodies without awaiting cancellation",
    async (phase) => {
      let cancelled = false;
      let signal: AbortSignal | undefined;
      const started = performance.now();
      const result = await waitForNpmPackage({
        packageName,
        version,
        ...clock(),
        timeoutMs: 1000,
        requestTimeoutMs: 25,
        fetcher: async (url, init) => {
          if (phase === "tarball" && url !== tarballUrl) return metadata();
          signal = init.signal as AbortSignal;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull: () => new Promise(() => {}),
              cancel: () => {
                cancelled = true;
                return new Promise(() => {});
              },
            }),
          );
        },
      });
      expect(result.available).toBe(false);
      expect(result.reason).toBe(`${phase}_timeout`);
      expect(signal?.aborted).toBe(true);
      expect(cancelled).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
    },
  );

  test("continuously ready empty chunks cannot starve the request deadline", async () => {
    let cancelled = false;
    const result = await waitForNpmPackage({
      packageName,
      version,
      ...clock(),
      timeoutMs: 1000,
      requestTimeoutMs: 10,
      fetcher: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (controller) => controller.enqueue(new Uint8Array(0)),
            cancel: () => {
              cancelled = true;
            },
          }),
        ),
    });
    expect(result.reason).toBe("metadata_timeout");
    expect(cancelled).toBe(true);
  });

  test("bounds a fetch that ignores abort and disposes its late response", async () => {
    let deliver: ((response: Response) => void) | undefined;
    let signal: AbortSignal | undefined;
    let cancelled = false;
    const result = await waitForNpmPackage({
      packageName,
      version,
      ...clock(),
      timeoutMs: 1000,
      requestTimeoutMs: 10,
      fetcher: (_url, init) => {
        signal = init.signal as AbortSignal;
        return new Promise((resolve) => {
          deliver = resolve;
        });
      },
    });
    expect(result.reason).toBe("metadata_timeout");
    expect(signal?.aborted).toBe(true);
    deliver!(
      new Response(
        new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  test.each(["metadata", "tarball"])(
    "rejects oversized %s and cancels its stream",
    async (phase) => {
      let cancelled = false;
      const result = await waitForNpmPackage({
        packageName,
        version,
        ...clock(),
        timeoutMs: 1000,
        fetcher: async (url) => {
          if (phase === "tarball" && url !== tarballUrl) return metadata();
          return new Response(
            new ReadableStream({
              cancel: () => {
                cancelled = true;
              },
            }),
            {
              headers: { "content-length": String(NPM_PROPAGATION_LIMITS.tarballBytes + 1) },
            },
          );
        },
      });
      expect(result.reason).toBe(`${phase}_body_too_large`);
      expect(cancelled).toBe(true);
    },
  );

  test("counts actual metadata bytes even without Content-Length", async () => {
    const result = await waitForNpmPackage({
      packageName,
      version,
      ...clock(),
      timeoutMs: 1000,
      fetcher: async () => new Response(new Uint8Array(NPM_PROPAGATION_LIMITS.metadataBytes + 1)),
    });
    expect(result.reason).toBe("metadata_body_too_large");
  });

  test("observer mutation/errors and raw transport error text cannot claim readiness or leak secrets", async () => {
    const result = await waitForNpmPackage({
      packageName,
      version,
      ...clock(),
      timeoutMs: 1000,
      fetcher: async () => {
        throw new Error("token=secret");
      },
      onAttempt: (entry) => {
        entry.available = true;
        entry.reason = "secret";
        throw new Error("secret");
      },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("metadata_transport_error");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("rejects tags, ranges, URLs, unbounded timings and malformed CLI flags before fetch", async () => {
    const fetcher = async () => {
      throw new Error("must not fetch");
    };
    for (const badVersion of [
      "latest",
      "^1.2.3",
      "https://example.invalid/",
      "1.2.3\nsecret",
      "1.2.3\n",
    ])
      await expect(
        waitForNpmPackage({ packageName, version: badVersion, fetcher }),
      ).rejects.toThrow("exact");
    await expect(
      waitForNpmPackage({ packageName: "https://secret.invalid/", version, fetcher }),
    ).rejects.toThrow("exact");
    for (const timeoutMs of [0, -1, Infinity, NaN, NPM_PROPAGATION_LIMITS.timeoutMs + 1])
      await expect(waitForNpmPackage({ packageName, version, timeoutMs, fetcher })).rejects.toThrow(
        "limit",
      );
    expect(parseNpmPropagationArgs(["--package-name", packageName, "--version", version])).toEqual({
      packageName,
      version,
    });
    for (const argv of [
      [],
      ["--version"],
      ["--token", "secret"],
      ["--version", version, "--version", version],
    ])
      expect(() => parseNpmPropagationArgs(argv)).toThrow("Usage:");
  });
});

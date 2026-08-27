import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import {
  SCM_REPAIR_AUTHORITY_SECRET_ENV,
  copyEnvWithoutScmRepairAuthoritySecret,
  createScmRepairAuthorityProof,
  resolveScmRepairAuthoritySecret,
  scrubScmRepairAuthoritySecretFromEnv,
  takeScmRepairAuthoritySecretFromEnv,
  verifyScmRepairAuthorityProof,
} from "../packages/shared/src/scm_repair_authority";

const SECRET = "test-scm-repair-authority-secret-0123456789abcdef";

describe("SCM repair authority", () => {
  test("binds a short-lived proof to the exact repair payload", () => {
    const nowMs = Date.parse("2026-08-26T12:00:00.000Z");
    const body = {
      taskId: "repair-pr-42",
      params: {
        reviewAgent: {
          prNumber: 42,
          prHeadSha: "a".repeat(40),
          prBaseSha: "b".repeat(40),
          resolutionType: "review_fix",
        },
      },
    };
    const proof = createScmRepairAuthorityProof(body, SECRET, {
      nowMs,
      nonce: "authority_nonce_0123456789",
    });

    expect(verifyScmRepairAuthorityProof({ body, proof, secret: SECRET, nowMs })).toMatchObject({
      ok: true,
      nonce: "authority_nonce_0123456789",
    });
    expect(
      verifyScmRepairAuthorityProof({
        body: {
          ...body,
          params: {
            reviewAgent: {
              ...body.params.reviewAgent,
              prHeadSha: "c".repeat(40),
            },
          },
        },
        proof,
        secret: SECRET,
        nowMs,
      }),
    ).toMatchObject({ ok: false, reason: "SCM repair authority signature is invalid" });
    expect(
      verifyScmRepairAuthorityProof({
        body,
        proof,
        secret: SECRET,
        nowMs: nowMs + 2 * 60_000 + 1,
      }),
    ).toMatchObject({ ok: false, reason: "SCM repair authority proof expired" });
  });

  test("persists one private authority secret for independently started local services", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-scm-authority-"));
    try {
      const first = resolveScmRepairAuthoritySecret({ dataDir: root, env: {} });
      const second = resolveScmRepairAuthoritySecret({ dataDir: root, env: {} });
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(second).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("publishes one complete key when two service processes start together", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-scm-authority-race-"));
    const gatePath = join(root, "start.gate");
    const moduleUrl = pathToFileURL(
      resolve(import.meta.dir, "../packages/shared/src/scm_repair_authority.ts"),
    ).href;
    const spawnResolver = (label: string) => {
      const readyPath = join(root, `${label}.ready`);
      const script = [
        `import { existsSync, writeFileSync } from "fs";`,
        `import { resolveScmRepairAuthoritySecret } from ${JSON.stringify(moduleUrl)};`,
        `writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
        `while (!existsSync(${JSON.stringify(gatePath)})) await Bun.sleep(5);`,
        `console.log(resolveScmRepairAuthoritySecret({ dataDir: ${JSON.stringify(root)}, env: {} }));`,
      ].join("\n");
      return Bun.spawn([process.execPath, "-e", script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: copyEnvWithoutScmRepairAuthoritySecret(process.env),
      });
    };

    try {
      const first = spawnResolver("first");
      const second = spawnResolver("second");
      const readyDeadline = Date.now() + 5_000;
      while (
        (!existsSync(join(root, "first.ready")) || !existsSync(join(root, "second.ready"))) &&
        Date.now() < readyDeadline
      ) {
        await Bun.sleep(5);
      }
      expect(existsSync(join(root, "first.ready"))).toBe(true);
      expect(existsSync(join(root, "second.ready"))).toBe(true);
      writeFileSync(gatePath, "go");

      const [firstOut, secondOut, firstCode, secondCode, firstErr, secondErr] = await Promise.all([
        new Response(first.stdout).text(),
        new Response(second.stdout).text(),
        first.exited,
        second.exited,
        new Response(first.stderr).text(),
        new Response(second.stderr).text(),
      ]);
      expect({ firstCode, secondCode, firstErr, secondErr }).toMatchObject({
        firstCode: 0,
        secondCode: 0,
        firstErr: "",
        secondErr: "",
      });
      expect(firstOut.trim().length).toBeGreaterThanOrEqual(32);
      expect(secondOut.trim()).toBe(firstOut.trim());
      expect(resolveScmRepairAuthoritySecret({ dataDir: root, env: {} })).toBe(firstOut.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("recovers an abandoned incomplete canonical key", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-scm-authority-partial-"));
    try {
      const authorityDir = join(root, "control-plane");
      mkdirSync(authorityDir, { recursive: true });
      writeFileSync(join(authorityDir, "scm-repair-authority.key"), "partial");
      const recovered = resolveScmRepairAuthoritySecret({ dataDir: root, env: {} });
      expect(recovered.length).toBeGreaterThanOrEqual(32);
      expect(recovered).not.toBe("partial");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("removes the authority secret case-insensitively from child environments", () => {
    const source: Record<string, string | undefined> = {
      PATH: "safe-path",
      [SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase()]: SECRET,
    };
    const copy = copyEnvWithoutScmRepairAuthoritySecret(source);
    expect(copy).toEqual({ PATH: "safe-path" });
    expect(source[SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase()]).toBe(SECRET);

    scrubScmRepairAuthoritySecretFromEnv(source);
    expect(source).toEqual({ PATH: "safe-path" });
  });

  test("atomically takes an operator override out of a parent environment", () => {
    const source: Record<string, string | undefined> = {
      PATH: "safe-path",
      [SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase()]: `  ${SECRET}  `,
    };

    expect(takeScmRepairAuthoritySecretFromEnv(source)).toBe(SECRET);
    expect(source).toEqual({ PATH: "safe-path" });
  });
});

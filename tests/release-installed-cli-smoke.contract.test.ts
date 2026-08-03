import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("published Windows CLI runtime soak contract", () => {
  test("keeps the installed package alive beyond RemoteBuddy's 120 second autonomy grace", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "release-cli.yml"),
      "utf8",
    );
    const smoke = readFileSync(
      join(process.cwd(), "scripts", "release-installed-cli-smoke.ts"),
      "utf8",
    );

    expect(workflow).toContain("--soak-ms 150000");
    expect(smoke).toContain('[options.pushpalsPath, "--runtime-only"');
    expect(smoke).toContain('"embeddedRuntimeCrash="');
    expect(smoke).toContain('"embeddedRuntime=degraded"');
    expect(smoke).toContain("Runtime remained healthy");
  });
});

import { describe, expect, test } from "bun:test";
import { extractRequiredValidationStepsFromVisionMarkdown } from "../apps/remotebuddy/src/remotebuddy_main";

describe("RemoteBuddy vision.md testing criteria", () => {
  test("extracts runnable commands from testing criteria bullets", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** Keep every WorkerPal PR validated.",
      "",
      "## 12) Testing criteria",
      "- `bun run test:root`",
      "- Run `bun run smoke:web` before PR submission",
      "- Keep manual browser review notes in the PR when UI changes",
      "- npm test",
    ].join("\n");

    expect(extractRequiredValidationStepsFromVisionMarkdown(markdown)).toEqual([
      "bun run test:root",
      "bun run smoke:web",
      "npm test",
    ]);
  });

  test("ignores non-command prose in the template testing criteria section", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** Keep validation explicit.",
      "",
      "## 12) Testing criteria",
      "- This is the user-owned validation contract for autonomous work.",
      "- Add repo-required test commands as separate bullet items after they exist.",
      "- Keep conditional or manual checks in section 9 unless they are mandatory for every WorkerPal PR or revision.",
    ].join("\n");

    expect(extractRequiredValidationStepsFromVisionMarkdown(markdown)).toEqual([]);
  });
});

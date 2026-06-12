import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface PythonPayloadTransport {
  args: string[];
  filePath: string;
  cleanup: () => void;
}

export function createPythonPayloadTransport(payloadBase64: string): PythonPayloadTransport {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-python-payload-"));
  const filePath = join(dir, "payload.b64");
  writeFileSync(filePath, payloadBase64, { encoding: "utf8", mode: 0o600 });

  let cleaned = false;
  return {
    args: ["--payload-file", filePath],
    filePath,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

import { createHash } from "crypto";

export interface ReviewPatchFile {
  path: string;
  previousPath: string;
  lines: string[];
}

function gitPath(value: string): string {
  let path = value.trim();
  if (path.startsWith('"')) {
    try {
      const octalEncoded = /\\[0-7]{3}/.test(path);
      // Git's core.quotepath uses octal UTF-8 bytes, not JSON escapes.
      path = path.replace(/\\([0-7]{3})/g, (_, octal: string) =>
        String.fromCharCode(parseInt(octal, 8)),
      );
      path = JSON.parse(path);
      if (octalEncoded) path = Buffer.from(path, "latin1").toString("utf8");
    } catch {
      return "";
    }
  }
  return path.replace(/^[ab]\//, "");
}

/** Parse file boundaries only. This is evidence accounting, not a language parser. */
export function splitReviewPatch(diff: string): ReviewPatchFile[] {
  const files: ReviewPatchFile[] = [];
  let current: ReviewPatchFile | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git ("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/);
      current = {
        previousPath: match ? gitPath(match[1]!) : "",
        path: match ? gitPath(match[2]!) : "",
        lines: [],
      };
      files.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return files;
}

export interface CompleteReviewEvidence {
  complete: boolean;
  /** Empty on incomplete capture: callers cannot accidentally review a prefix. */
  diff: string;
  reasons: string[];
  manifest: {
    version: 1;
    candidateSha: string | null;
    baseSha: string | null;
    sha256: string;
    byteLength: number;
    maxBytes: number;
    paths: string[];
    expectedPaths: string[] | null;
    captureComplete: boolean;
    complete: boolean;
  };
}

function patchHunksComplete(files: ReviewPatchFile[]): boolean {
  for (const file of files) {
    let hunk: { old: number; next: number } | null = null;
    let sawHunk = false;
    const finished = () => hunk === null || (hunk.old === 0 && hunk.next === 0);
    for (const line of file.lines) {
      if (line.startsWith("@@")) {
        if (!finished()) return false;
        const match = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)$/);
        if (!match) return false;
        const old = match[1] === undefined ? 1 : Number(match[1]);
        const next = match[2] === undefined ? 1 : Number(match[2]);
        if (!Number.isSafeInteger(old) || !Number.isSafeInteger(next)) return false;
        hunk = { old, next };
        sawHunk = true;
      } else if (hunk) {
        if (line === "\\ No newline at end of file") continue;
        if (line.startsWith("-")) hunk.old--;
        else if (line.startsWith("+")) hunk.next--;
        else if (line.startsWith(" ")) {
          hunk.old--;
          hunk.next--;
        } else if (line !== "" || !finished()) return false;
        if (hunk.old < 0 || hunk.next < 0) return false;
      }
    }
    if (!finished()) return false;
    // Renames/mode-only changes need no hunks. A textual patch with file
    // markers but no body, however, is not complete evidence.
    if (!sawHunk && file.lines.some((line) => /^(?:---|\+\+\+) /.test(line))) return false;
  }
  return true;
}

export function buildCompleteReviewEvidence(options: {
  diff: string;
  maxBytes: number;
  expectedPaths?: string[];
  expectedFileCount?: number;
  captureComplete?: boolean;
  candidateSha?: string;
  baseSha?: string;
}): CompleteReviewEvidence {
  const bytes = Buffer.byteLength(options.diff, "utf8");
  const files = splitReviewPatch(options.diff);
  const paths = [...new Set(files.map((file) => file.path))];
  const reasons: string[] = [];
  if (!options.diff.trim())
    reasons.push("The patch is empty; no implementation review is possible.");
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || bytes > options.maxBytes)
    reasons.push(
      `The complete patch is ${bytes} UTF-8 bytes, exceeding the ${options.maxBytes}-byte review budget. Split the change or provide a complete bounded review mechanism.`,
    );
  if (options.captureComplete === false)
    reasons.push(
      "Patch capture was incomplete. Recapture the complete immutable candidate before review.",
    );
  if (!files.length || files.some((file) => !file.path))
    reasons.push("The patch does not provide an unambiguous complete file manifest.");
  if (!patchHunksComplete(files))
    reasons.push(
      "Unified patch hunk lengths are incomplete or malformed. Recapture the full patch without trimming its context lines.",
    );
  if (
    files.some((file) =>
      file.lines.some((line) => /^(?:Binary files |GIT binary patch)/.test(line)),
    )
  )
    reasons.push("The patch contains binary changes without reviewable binary evidence.");
  if (
    /^(?:\.\.\.\(diff truncated\)|\.\.\. diff truncated .*|\[diff truncated\])$/m.test(options.diff)
  )
    reasons.push("Patch text explicitly reports truncation.");
  if (options.expectedPaths) {
    const observed = new Set(files.flatMap((file) => [file.path, file.previousPath]));
    const missing = options.expectedPaths.filter((path) => !observed.has(path));
    if (missing.length)
      reasons.push(
        `Patch evidence is missing ${missing.length} expected changed file(s): ${missing.slice(0, 8).join(", ")}.`,
      );
  }
  if (options.expectedFileCount !== undefined && options.expectedFileCount !== files.length)
    reasons.push(
      `Provider reports ${options.expectedFileCount} changed files, but the patch contains ${files.length}. Recapture matching head/base evidence.`,
    );
  const complete = reasons.length === 0;
  return {
    complete,
    diff: complete ? options.diff : "",
    reasons,
    manifest: {
      version: 1,
      candidateSha: options.candidateSha ?? null,
      baseSha: options.baseSha ?? null,
      sha256: createHash("sha256").update(options.diff).digest("hex"),
      byteLength: bytes,
      maxBytes: options.maxBytes,
      paths,
      expectedPaths: options.expectedPaths ?? null,
      captureComplete: options.captureComplete !== false,
      complete,
    },
  };
}

export function assertCompleteReviewEvidence(evidence: CompleteReviewEvidence): void {
  if (!evidence.complete || !evidence.manifest.complete)
    throw new Error(`Review evidence incomplete: ${evidence.reasons.join(" ")}`);
}

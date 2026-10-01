import { splitReviewPatch } from "./review_evidence.js";

export interface TestDeclarationEvidence {
  cases: number;
  suites: number;
  parameterized: number;
  disabled: number;
  focused: number;
  unknown: number;
}

export interface TestFileHygieneEvidence {
  path: string;
  previousPath: string;
  added: TestDeclarationEvidence;
  removed: TestDeclarationEvidence;
  context: TestDeclarationEvidence;
  disposition: "no_structural_change" | "semantic_review" | "blocking";
}

/** Explicit task intent permits removal analysis, never skipped/only execution. */
export function testRemovalExplicitlyRequested(taskIntent: string): boolean {
  const text = String(taskIntent ?? "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  // A prohibition is not authority. Mixed preservation/removal instructions
  // require semantic resolution; this lexical helper cannot resolve scope.
  if (
    /\b(?:not|never|without|avoid|forbid|forbidden|prohibit|prohibited|prevent|don't|doesn't|mustn't|shouldn't|cannot|can't)\b.{0,100}\b(?:weaken|delet|reduc|remov|drop|retir|replac|consolidat|migrat|refactor)\w*\b.{0,100}\b(?:test|coverage|suite)s?\b/i.test(
      text,
    ) ||
    /\b(?:test|coverage|suite)s?\b.{0,80}\b(?:not|never|mustn't|shouldn't|cannot|can't)\b.{0,40}\b(?:weaken|delet|reduc|remov|drop|retir|replac|consolidat|migrat|refactor)\w*\b/i.test(
      text,
    ) ||
    /\b(?:preserve|retain|maintain|keep)\b.{0,100}\b(?:test|coverage|suite)s?\b/i.test(text) ||
    (/\b(?:test|coverage|suite)s?\b/i.test(text) &&
      /\b(?:not|never|without|avoid|don't|mustn't|shouldn't|cannot|can't)\b.{0,80}\b(?:weaken|delet|reduc|remov|drop|retir|replac|consolidat|migrat|refactor)\w*\b/i.test(
        text,
      ))
  )
    return false;
  // Accept a direct task clause, not an incidental discussion of deleting
  // tests or a question about whether deletion might be possible.
  return (
    /(?:^|[.;:]\s*|\bplease\s+)(?:delete|remove|retire|replace|consolidate|migrate|refactor)\b[^.;:!?]{0,80}\b(?:test|coverage|suite)s?\b/i.test(
      text,
    ) ||
    /\b(?:test|coverage|suite)s?\b.{0,40}\b(?:must|should|need to)\s+be\s+(?:deleted|removed|retired|replaced|consolidated|migrated|refactored)\b/i.test(
      text,
    )
  );
}

function empty(): TestDeclarationEvidence {
  return { cases: 0, suites: 0, parameterized: 0, disabled: 0, focused: 0, unknown: 0 };
}

function testSourcePath(path: string): boolean {
  if (!/\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|kts|cs|fs|php|swift)$/i.test(path)) return false;
  return (
    /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.|(?:^|\/)test_[^/]+\.py$|_test\.go$|_spec\.rb$|(?:Test|Tests|Spec)\.(?:java|kt|kts|cs|fs|php|swift)$/i.test(
      path,
    ) || /\.rs$/.test(path)
  );
}

interface LexicalState {
  block: boolean;
  triple: string | null;
  template: boolean;
}

/** Suppress comment/docstring examples; uncertain syntaxes remain semantic evidence. */
function codeLine(source: string, state: LexicalState, path: string): string {
  let line = source.trim();
  if (state.triple) {
    if (line.includes(state.triple)) state.triple = null;
    return "";
  }
  if (/\.py$/.test(path) && /^(?:[rubf]*)?(?:'''|""")/i.test(line)) {
    const marker = line.includes('"""') ? '"""' : "'''";
    if (line.indexOf(marker) === line.lastIndexOf(marker)) state.triple = marker;
    return "";
  }
  if (state.template) {
    if (/(?<!\\)`/.test(line)) state.template = false;
    return "";
  }
  if (/\.rb$/.test(path) && /^=begin\b/.test(line)) {
    state.triple = "=end";
    return "";
  }
  if (state.block) {
    const end = line.indexOf("*/");
    if (end < 0) return "";
    state.block = false;
    line = line.slice(end + 2).trim();
  }
  while (line.startsWith("/*")) {
    const end = line.indexOf("*/", 2);
    if (end < 0) {
      state.block = true;
      return "";
    }
    line = line.slice(end + 2).trim();
  }
  if (/^(?:\/\/|\*|#(?!\[))/.test(line)) return "";
  // Scan delimiters outside ordinary quoted strings. A block comment or
  // multiline example can start after an assignment, not only at column one.
  let code = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (line.startsWith("//", index) || (/\.(?:py|rb)$/.test(path) && char === "#")) break;
    if (line.startsWith("/*", index)) {
      const end = line.indexOf("*/", index + 2);
      if (end < 0) {
        state.block = true;
        break;
      }
      index = end + 1;
      continue;
    }
    const triple = line.slice(index, index + 3);
    if (/\.(?:py|java|kt|kts)$/.test(path) && (triple === '"""' || triple === "'''")) {
      const end = line.indexOf(triple, index + 3);
      if (end < 0) {
        state.triple = triple;
        break;
      }
      index = end + 2;
      code += "'text'";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      code += char;
      let end = index + 1;
      for (; end < line.length; end++) {
        if (line[end] === "\\") {
          end++;
          continue;
        }
        if (line[end] === char) break;
      }
      if (end >= line.length && char === "`") state.template = true;
      code += char;
      index = end;
      continue;
    }
    code += char;
  }
  return code.trim();
}

function observe(line: string, counts: TestDeclarationEvidence): void {
  if (!line) return;
  // Multiline declarations/chained parameterization are not evidence of lost
  // cases. Leave their actual equivalence to semantic review.
  if (
    /^(?:(?:test|it|describe|context|suite)(?:\.[A-Za-z_$][\w$]*)*\s*$|\.(?:each|for|only|skip|todo|skipIf|runIf)\b)/.test(
      line,
    )
  ) {
    counts.unknown += 1;
    if (/\.(?:each|for)\b/.test(line)) counts.parameterized += 1;
    return;
  }
  const js = line.match(
    /^(?:await\s+)?(test|it|describe|context|suite|xdescribe|xcontext|xtest|xit|fdescribe|fit)(\s*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\(|`)/,
  );
  if (js) {
    const name = js[1]!;
    const modifiers = js[2] ?? "";
    const suite = /describe|context|suite/.test(name);
    if (suite) counts.suites += 1;
    else counts.cases += 1;
    if (/\.(?:each|for)\b/.test(modifiers)) counts.parameterized += 1;
    if (/^x/.test(name) || /\.(?:skip|todo|fixme)\b/.test(modifiers)) counts.disabled += 1;
    if (/^f/.test(name) || /\.only\b/.test(modifiers)) counts.focused += 1;
    if (/\.(?:skipIf|runIf)\b/.test(modifiers)) counts.unknown += 1;
    return;
  }
  if (/^(?:RSpec\.)?(?:describe|context)\b/.test(line)) counts.suites += 1;
  else if (/^(?:it|specify|scenario)\s+["']/.test(line)) counts.cases += 1;
  else if (
    /^(?:(?:async\s+)?def\s+test_\w*\s*\(|func\s+[Tt]est\w*\s*\(|#\[test\]|@Test\b|\[(?:Fact|Theory|Test|TestCase)\b|(?:public\s+|protected\s+)?function\s+test\w*\s*\()/i.test(
      line,
    )
  )
    counts.cases += 1;
  if (
    /^(?:@(?:pytest\.mark\.)?(?:parametrize|ParameterizedTest)|\[(?:Theory|TestCase)|#\[(?:rstest|case))\b/.test(
      line,
    )
  )
    counts.parameterized += 1;
  if (
    /^(?:@(?:pytest\.mark\.|unittest\.)?(?:skip|skipIf|skipUnless|xfail|Disabled|Ignore)\b|#\[ignore\b|\[(?:Ignore|Explicit)\b|\[(?:Fact|Theory|TestCase)[^\]]*\bSkip\s*=)/i.test(
      line,
    )
  )
    counts.disabled += 1;
  if (/^(?:pytest\.skip|pytest\.xfail|t\.Skip(?:f|Now)?|GTEST_SKIP)\s*\(/.test(line))
    counts.disabled += 1;
}

/** Conservative structural evidence, never a semantic coverage proof or approval. */
export function analyzeTestHygieneDiff(
  diff: string,
  options: { allowTestRemoval?: boolean } = {},
): {
  files: TestFileHygieneEvidence[];
  blockingIssues: string[];
  semanticReviewNotes: string[];
} {
  const files: TestFileHygieneEvidence[] = [];
  const blockingIssues: string[] = [];
  const semanticReviewNotes: string[] = [];
  for (const patch of splitReviewPatch(diff)) {
    if (!testSourcePath(patch.path) && !testSourcePath(patch.previousPath)) continue;
    const file: TestFileHygieneEvidence = {
      path: patch.path,
      previousPath: patch.previousPath,
      added: empty(),
      removed: empty(),
      context: empty(),
      disposition: "no_structural_change",
    };
    const before: LexicalState = { block: false, triple: null, template: false };
    const after: LexicalState = { block: false, triple: null, template: false };
    for (const raw of patch.lines) {
      if (/^(?:---|\+\+\+|@@|\\ No newline)/.test(raw)) continue;
      if (raw.startsWith("-"))
        observe(codeLine(raw.slice(1), before, patch.previousPath), file.removed);
      else if (raw.startsWith("+")) observe(codeLine(raw.slice(1), after, patch.path), file.added);
      else if (raw.startsWith(" ")) {
        const line = codeLine(raw.slice(1), before, patch.previousPath);
        codeLine(raw.slice(1), after, patch.path);
        observe(line, file.context);
      }
    }
    const newlyDisabled = file.added.disabled > file.removed.disabled;
    const addedWeakening =
      file.added.focused > file.removed.focused ||
      (newlyDisabled &&
        (file.removed.cases > 0 ||
          file.removed.suites > 0 ||
          file.context.cases > 0 ||
          file.context.suites > 0));
    const ambiguous =
      file.added.cases > 0 ||
      file.added.parameterized > 0 ||
      file.removed.parameterized > 0 ||
      file.context.parameterized > 0 ||
      file.added.unknown > 0 ||
      file.removed.unknown > 0;
    // Additions in a different file cannot hide an entire file's lost cases.
    // Within-file renames/parameterization require semantic comparison instead
    // of assuming declaration counts equal executed coverage.
    if (addedWeakening) {
      file.disposition = "blocking";
      blockingIssues.push(
        `${file.path}: adds skipped/disabled or focused-only test execution. Restore normal coverage or explicitly resolve the test policy before publication.`,
      );
    } else if (file.removed.cases >= 3 && !ambiguous && !options.allowTestRemoval) {
      file.disposition = "blocking";
      blockingIssues.push(
        `${file.path}: removes ${file.removed.cases} existing test declarations without replacement cases in that file. Preserve equivalent coverage or justify the explicit test-removal task.`,
      );
    } else if (
      file.added.cases ||
      file.removed.cases ||
      file.added.suites ||
      file.removed.suites ||
      file.added.parameterized ||
      file.removed.parameterized ||
      file.added.unknown ||
      file.removed.unknown ||
      newlyDisabled ||
      patch.path !== patch.previousPath
    ) {
      file.disposition = "semantic_review";
      semanticReviewNotes.push(
        `${file.path}: compare actual assertions and exercised cases across the refactor (cases -${file.removed.cases}/+${file.added.cases}, suites -${file.removed.suites}/+${file.added.suites}, parameterized/unknown=${ambiguous}). Counts do not prove equivalent coverage; do not approve solely from this structural check.`,
      );
    }
    files.push(file);
  }
  return { files, blockingIssues, semanticReviewNotes };
}

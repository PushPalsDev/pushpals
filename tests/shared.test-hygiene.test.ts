import { describe, expect, test } from "bun:test";
import {
  analyzeTestHygieneDiff,
  testRemovalExplicitlyRequested,
} from "../packages/shared/src/test_hygiene";

const patch = (lines: string[], path = "tests/example.test.ts") =>
  [`diff --git a/${path} b/${path}`, ...lines].join("\n");

describe("structured test hygiene", () => {
  test("removal authority never comes from negated or preservation instructions", () => {
    for (const instruction of [
      "Do not remove tests",
      "Never delete tests",
      "Don't drop existing coverage",
      "Refactor implementation without reducing test coverage",
      "Avoid weakening tests",
      "Tests must not be removed",
      "Coverage should never be reduced",
      "Preserve all existing tests; refactor the test suite",
      "Keep current tests; remove tests",
      "Refactor tests without deleting them",
      "Don’t remove tests",
      "Preserve tests; remove tests",
      "Should we remove tests?",
      "Investigate whether the helper can remove tests",
    ]) {
      expect(testRemovalExplicitlyRequested(instruction)).toBe(false);
      expect(
        analyzeTestHygieneDiff(patch(Array(3).fill("-test('existing', () => {})")), {
          allowTestRemoval: testRemovalExplicitlyRequested(instruction),
        }).blockingIssues,
      ).toHaveLength(1);
    }
    for (const instruction of [
      "Remove obsolete tests",
      "Refactor and replace obsolete test coverage",
      "Tests must be removed",
    ])
      expect(testRemovalExplicitlyRequested(instruction)).toBe(true);
  });

  test("suite parameterization and renamed cases require semantic review, not mechanical rejection", () => {
    const result = analyzeTestHygieneDiff(
      patch([
        "-describe('layout', () => {",
        "-  test('top viewport', () => {})",
        "-  test('bottom viewport', () => {})",
        "+describe.each(['top', 'bottom'])('%s layout', (position) => {",
        "+  test('fits viewport', () => {})",
        "+  test('preserves controls', () => {})",
      ]),
    );
    expect(result.blockingIssues).toEqual([]);
    expect(result.files[0]).toMatchObject({
      removed: { cases: 2, suites: 1 },
      added: { cases: 2, suites: 1, parameterized: 1 },
      disposition: "semantic_review",
    });
    expect(result.semanticReviewNotes[0]).toContain("do not approve solely");
  });

  test("same-file renames and parameterization are not an equivalence assertion", () => {
    for (const replacement of [
      "test.each(values)('new %s', () => {})",
      "test('replacement', () => {})",
    ]) {
      const result = analyzeTestHygieneDiff(
        patch([
          "-test('one', () => {})",
          "-test('two', () => {})",
          "-test('three', () => {})",
          `+${replacement}`,
        ]),
      );
      expect(result.blockingIssues).toEqual([]);
      expect(result.files[0]?.disposition).toBe("semantic_review");
    }
  });

  test("unrelated additions cannot mask bulk removal in another test file", () => {
    const result = analyzeTestHygieneDiff(
      [
        patch(["-test('a', () => {})", "-test('b', () => {})", "-test('c', () => {})"]),
        patch(
          ["+test('x', () => {})", "+test('y', () => {})", "+test('z', () => {})"],
          "tests/other.test.ts",
        ),
      ].join("\n"),
    );
    expect(result.blockingIssues).toHaveLength(1);
    expect(result.blockingIssues[0]).toContain("tests/example.test.ts");
  });

  test("comments, docstrings, template examples and documentation do not become cases", () => {
    for (const source of [
      patch(["-/*", "-test('a', () => {})", "-test('b', () => {})", "-test('c', () => {})", "-*/"]),
      patch([
        "-const explanation = /*",
        "-test('a', () => {})",
        "-test('b', () => {})",
        "-test('c', () => {})",
        "-*/ 42;",
      ]),
      patch(["-// test('a', () => {})", "-// test('b', () => {})", "-// test('c', () => {})"]),
      patch([
        "-const example = `",
        "-test('a', () => {})",
        "-test('b', () => {})",
        "-test('c', () => {})",
        "-`;",
      ]),
      patch(
        ["-test('a', () => {})", "-test('b', () => {})", "-test('c', () => {})"],
        "tests/README.md",
      ),
      patch(
        ['-"""', "-def test_a(): pass", "-def test_b(): pass", "-def test_c(): pass", '-"""'],
        "tests/test_examples.py",
      ),
      patch(
        [
          '-EXAMPLE = """',
          "-def test_a(): pass",
          "-def test_b(): pass",
          "-def test_c(): pass",
          '-"""',
        ],
        "tests/test_examples.py",
      ),
      patch(["-=begin", "-it 'a' do", "-it 'b' do", "-it 'c' do", "-=end"], "spec/example_spec.rb"),
    ]) {
      const result = analyzeTestHygieneDiff(source);
      expect(result.blockingIssues).toEqual([]);
      expect(result.files.every((file) => file.removed.cases === 0)).toBe(true);
    }
  });

  test("focused and disabled existing coverage remain blocking even with a refactor description", () => {
    for (const replacement of [
      "test.skip('a', () => {})",
      "test.only('a', () => {})",
      "test.todo('a')",
      "xit('a', () => {})",
    ]) {
      const result = analyzeTestHygieneDiff(patch(["-test('a', () => {})", `+${replacement}`]), {
        allowTestRemoval: true,
      });
      expect(result.blockingIssues).toHaveLength(1);
    }
    expect(
      analyzeTestHygieneDiff(patch(["+test.todo('new future case')"])).files[0]?.disposition,
    ).toBe("semantic_review");
  });

  test("conditional parameterization remains unknown and comments mentioning skip are harmless", () => {
    const result = analyzeTestHygieneDiff(
      patch([
        "+test.skipIf(condition)('conditional', () => {})",
        "+// test.only('example')",
        "+const text = 'pytest.skip()';",
      ]),
    );
    expect(result.blockingIssues).toEqual([]);
    expect(result.files[0]?.added.unknown).toBe(1);
    expect(result.files[0]?.added.focused).toBe(0);
    const multiline = analyzeTestHygieneDiff(
      patch([
        "-test('a', () => {})",
        "-test('b', () => {})",
        "-test('c', () => {})",
        "+test",
        "+  .each(values)",
        "+  ('%s case', () => {})",
      ]),
    );
    expect(multiline.blockingIssues).toEqual([]);
    expect(multiline.files[0]?.disposition).toBe("semantic_review");
  });

  test("cross-language case removal is recognized without counting suite wrappers", () => {
    for (const [path, declaration] of [
      ["tests/test_example.py", "def test_example(): pass"],
      ["lib/example_test.go", "func TestExample(t *testing.T) {}"],
      ["tests/example.rs", "#[test]"],
      ["src/test/ExampleTest.java", "@Test"],
      ["tests/ExampleTests.cs", "[Fact]"],
      ["spec/example_spec.rb", "it 'works' do"],
      ["tests/ExampleTest.php", "public function testWorks() {}"],
      ["tests/ExampleTests.swift", "func testWorks() throws {}"],
    ]) {
      const result = analyzeTestHygieneDiff(patch(Array(3).fill(`-${declaration}`), path));
      expect(result.blockingIssues).toHaveLength(1);
      expect(result.files[0]?.removed.cases).toBe(3);
    }
    expect(
      analyzeTestHygieneDiff(patch(Array(3).fill("-describe('suite', () => {})"))).blockingIssues,
    ).toEqual([]);
  });

  test("Python decorators and Go skip calls preserve disabled evidence", () => {
    for (const [path, lines] of [
      [
        "tests/test_example.py",
        ["+@pytest.mark.skip(reason='later')", " def test_example(): pass"],
      ],
      ["lib/example_test.go", [" func TestExample(t *testing.T) {", "+  t.Skip('later')", " }"]],
    ] as const) {
      expect(analyzeTestHygieneDiff(patch([...lines], path)).blockingIssues).toHaveLength(1);
    }
  });
});

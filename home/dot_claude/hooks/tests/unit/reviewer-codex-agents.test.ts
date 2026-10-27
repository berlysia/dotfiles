import { readFileSync } from "node:fs";
import { strictEqual, ok, throws } from "node:assert";
import { describe, it } from "node:test";
import { REVIEWER_SLUGS } from "../../lib/workflow-review-core.ts";
import { SAFE_PATH_PATTERN } from "../../../scripts/reviewer-codex-run.ts";

const instruction = (SLUG: string) =>
  "依頼の先頭行が `executor: codex` なら、2 行目 `brief:` と 3 行目 `root:` の値がどちらも `^/[A-Za-z0-9._/-]+$` に一致するかを先に確かめる。一致すれば `bun ~/.claude/scripts/reviewer-codex-run.ts <slug> '<brief の値>' '<root の値>'` を、値を単引用符で囲み、Bash ツールの `run_in_background` で 1 回だけ実行する。終わりの通知を待ってから、その標準出力だけをそのまま返す。待っている間はほかのことをしない。一致しなければ実行せず、`reviewed-by: codex failed` と `reason: bad-arguments` の 2 行だけを返す。どちらの場合も自分ではレビューせず、ほかのことはしない。".replace(
    "<slug>",
    SLUG,
  );
export function checkDefinition(slug: string, text: string): void {
  const parts = text.split("---");
  const line = instruction(slug);
  ok(
    parts.slice(2).join("---").trimStart().startsWith(line),
    `${slug}.md: missing instruction`,
  );
  const tools = /^tools:.*$/m.exec(parts[1] ?? "")?.[0];
  ok(!tools || /\bBash\b/.test(tools), `${slug}.md: missing Bash`);
  strictEqual(
    line.match(/`(\^\/[^`]+)`/)?.[1],
    SAFE_PATH_PATTERN.source.replaceAll("\\/", "/"),
  );
}
describe("Codex reviewer definitions", () => {
  for (const slug of REVIEWER_SLUGS)
    it(slug, () =>
      checkDefinition(
        slug,
        readFileSync(
          new URL(`../../../agents/${slug}.md`, import.meta.url),
          "utf8",
        ),
      ),
    );
  it("rejects missing instruction with filename", () =>
    throws(
      () => checkDefinition("logic-validator", "---\n---\n"),
      /logic-validator.md/,
    ));
  it("rejects another reviewer's slug", () =>
    throws(() =>
      checkDefinition(
        "logic-validator",
        `---\n---\n${instruction("scope-justification-reviewer")}`,
      ),
    ));
  it("rejects tools without Bash", () =>
    throws(() =>
      checkDefinition(
        "logic-validator",
        `---\ntools: Read, Glob\n---\n${instruction("logic-validator")}`,
      ),
    ));
});

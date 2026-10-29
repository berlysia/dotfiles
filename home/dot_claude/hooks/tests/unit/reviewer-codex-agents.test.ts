import { readFileSync } from "node:fs";
import { strictEqual, ok, throws } from "node:assert";
import { describe, it } from "node:test";
import { REVIEWER_SLUGS } from "../../lib/workflow-review-core.ts";
import {
  EFFORT_VALUES,
  MODEL_PATTERN,
  SAFE_PATH_PATTERN,
} from "../../../scripts/reviewer-codex-run.ts";

const instruction = (SLUG: string) =>
  "依頼の先頭行が `executor: codex` なら、2 行目 `brief:`、3 行目 `root:`、4 行目 `model:`、5 行目 `effort:` の値を先に確かめる。brief と root は `^/[A-Za-z0-9._/-]+$`、model は `^gpt-[0-9a-z.-]{1,32}$`、effort は `^(low|medium|high|xhigh|max)$` にすべて一致しなければならない。すべて一致すれば `bun ~/.claude/scripts/reviewer-codex-run.ts -m <model の値> -c model_reasoning_effort=<effort の値> <slug> '<brief の値>' '<root の値>'` を、brief と root の値は単引用符で囲み、model と effort の値は引用符で囲まずに、Bash ツールの `run_in_background` で 1 回だけ実行する。終わりの通知を待ってから、その標準出力だけをそのまま返す。待っている間はほかのことをしない。一致しなければ実行せず、`reviewed-by: codex failed` と `reason: bad-arguments` の 2 行だけを返す。どちらの場合も自分ではレビューせず、ほかのことはしない。".replace(
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
  // The line carries its own copies of the validators; keep them equal to the
  // script's so the haiku-side check and the script-side check cannot drift.
  const spans = [...line.matchAll(/`(\^[^`]+)`/g)].map((m) => m[1]);
  strictEqual(spans[1], MODEL_PATTERN.source);
  strictEqual(spans[2], `^(${EFFORT_VALUES.join("|")})$`);
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

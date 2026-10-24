// 配布先の tanteki の lintFiles を子プロセスの中で呼び、許すキーだけを JSON で標準出力に返す。
//
// measure.mjs が 1 文書ずつ node の子プロセスとして起こす。tanteki を import で呼ぶと、親の
// プロセスの規則の探索や設定の読み込みが測定に効くので、子プロセスで隔離する。
// 返すのは `messages` の ruleId・line・column だけ（本文・メッセージ・抜粋は捨てる）。
// 失敗は終了コード 1 にし、例外の文は出さない。
//
// 使い方:
//   node tanteki-runner.mjs lint <lint.mjs の絶対パス> <type> <入力ファイル> <.textlintrc.json>
//   node tanteki-runner.mjs describe <lint.mjs の絶対パス> <type> <.textlintrc.json>
// describe はその種別で有効な規則の id の並びを返す。

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

async function main(argv) {
  const [mode] = argv;
  if (mode === "lint") {
    const [, lintPath, type, file, configPath] = argv;
    const lib = await import(pathToFileURL(lintPath).href);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const results = await lib.lintFiles(type, [file], config);
    const messages = results.flatMap((result) =>
      result.messages.map((m) => ({
        ruleId: m.ruleId,
        line: m.line,
        column: m.column,
      })),
    );
    process.stdout.write(JSON.stringify({ messages }));
    return;
  }
  if (mode === "describe") {
    const [, lintPath, type, configPath] = argv;
    const lib = await import(pathToFileURL(lintPath).href);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const descriptor = await lib.createDescriptor(type, config);
    const rules = descriptor.rule.ruleDescriptorList.map(
      (item) => item.textlintKernelRule.ruleId,
    );
    process.stdout.write(JSON.stringify({ rules }));
    return;
  }
  throw new Error("bad-mode");
}

main(process.argv.slice(2)).catch(() => {
  process.exitCode = 1;
});

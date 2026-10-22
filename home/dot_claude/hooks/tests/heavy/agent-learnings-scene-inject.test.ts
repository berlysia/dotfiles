import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  learning,
  makeWorld,
  removeWorld,
  type World,
} from "../support/agent-learnings-trigger-fixture.ts";

// 実物の createRunGit を子プロセスで動かし、global 設定と repo の設定の分離の効き目を毎回確かめる。
// HOME は子の env にだけ渡す。env は明示のオブジェクトで、CLAUDECODE・CLAUDE_CODE_*・AI_AGENT・CODEX_* は入れない

const CHILD = join(
  dirname(fileURLToPath(import.meta.url)),
  "../support/scene-inject-child.ts",
);
const roots: string[] = [];
const worlds: World[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  for (const w of worlds) removeWorld(w);
});

const childEnv = (home: string): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
});

function runChild(home: string, args: string[]) {
  const r = spawnSync("bun", [CHILD, ...args], {
    encoding: "utf8",
    env: childEnv(home),
    timeout: 60_000,
  });
  strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim()) as Record<string, unknown>;
}

// fsmonitor として呼ばれたら marker を作る script
function markerScript(dir: string): { script: string; marker: string } {
  const marker = join(dir, "fsmonitor-ran");
  const script = join(dir, "fsmonitor.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(script, 0o755);
  return { script, marker };
}

describe("createRunGit isolateGlobalConfig", () => {
  it("hides ~/.gitconfig user.name only when isolated", () => {
    const home = mkdtempSync(join(tmpdir(), "scene-inject-home-"));
    roots.push(home);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = marker\n");
    const args = JSON.stringify(["config", "--get", "user.name"]);
    const plain = runChild(home, ["git", "false", home, args]);
    deepStrictEqual(plain, { ok: true, stdout: "marker" });
    const isolated = runChild(home, ["git", "true", home, args]);
    strictEqual(isolated["ok"], false);
  });
});

describe("repo-controlled core.fsmonitor never runs", () => {
  for (const via of ["direct", "include.path"] as const) {
    it(`via ${via}: a plain git runs it, createRunGit and injectScene do not`, () => {
      const w = makeWorld([learning(1, "cmd:git commit")]);
      worlds.push(w);
      const { script, marker } = markerScript(w.root);
      if (via === "direct") {
        appendFileSync(
          join(w.repo, ".git/config"),
          `[core]\n\tfsmonitor = ${script}\n`,
        );
      } else {
        const extra = join(w.root, "extra.cfg");
        writeFileSync(extra, `[core]\n\tfsmonitor = ${script}\n`);
        appendFileSync(
          join(w.repo, ".git/config"),
          `[include]\n\tpath = ${extra}\n`,
        );
      }

      // 対照: -c を付けない素の git status は副作用を起こす（この設定で副作用が出る前提の確認）
      execFileSync("git", ["status"], {
        cwd: w.repo,
        env: childEnv(w.home),
        stdio: "ignore",
      });
      ok(existsSync(marker), "control: plain git status should run fsmonitor");
      rmSync(marker);

      const status = runChild(w.home, [
        "git",
        "true",
        w.repo,
        JSON.stringify(["status"]),
      ]);
      strictEqual(status["ok"], true);
      ok(!existsSync(marker), "createRunGit(status) ran fsmonitor");

      const injected = runChild(w.home, [
        "inject",
        w.home,
        w.repo,
        "git commit -m x",
      ]);
      ok(String(injected["text"]).includes("title 1"));
      ok(!existsSync(marker), "injectScene ran fsmonitor");
    });
  }
});

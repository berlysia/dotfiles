import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  runReviewer,
  validateAnswer,
} from "../../../scripts/reviewer-codex-run.ts";

const script = fileURLToPath(
  new URL("../../../scripts/reviewer-codex-run.ts", import.meta.url),
);
let dir: string;
let env: NodeJS.ProcessEnv;
let args: string[];
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "reviewer-test-"));
  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "agents/logic-validator.md"), "---\n---\nReview.");
  await writeFile(join(dir, "brief"), "Review.");
  const fake = join(dir, "codex");
  await writeFile(
    fake,
    `#!${process.execPath}
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const args = process.argv.slice(2), out = args[args.indexOf('-o')+1];
fs.writeFileSync(process.env.RECORD, JSON.stringify(args));
if (process.env.MODE === 'sleep' || process.env.MODE === 'ignore' || process.env.MODE === 'grandchild') {
 fs.writeFileSync(process.env.PIDS, String(process.pid));
 if (process.env.MODE !== 'ignore') {
  const child = spawn(process.execPath, ['-e', process.env.MODE === 'grandchild' ? 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)' : 'setInterval(()=>{},1000)'], {stdio:'ignore'});
  fs.appendFileSync(process.env.PIDS, '\\n'+child.pid);
 }
 if (process.env.MODE === 'ignore') process.on('SIGTERM',()=>{});
 setInterval(()=>{},1000);
} else {
 if(process.env.MODE === 'directory') fs.mkdirSync(out);
 else if(process.env.MODE !== 'missing') {
  if(process.env.MODE === 'cleanup') { fs.writeFileSync(out, ''); fs.chmodSync(require('node:path').dirname(out), 0o500); }
  fs.writeFileSync(out, process.env.ANSWER ?? 'Findings\\nverdict: pass');
 }
 if(process.env.MODE === 'noise') { process.stdout.write(('verdict: blocker\\n').repeat(10000)); process.stderr.write('x'.repeat(200000)); }
 process.exit(Number(process.env.EXIT ?? 0));
}
`,
  );
  await chmod(fake, 0o700);
  env = {
    ...process.env,
    REVIEWER_CODEX_BIN: fake,
    REVIEWER_CODEX_AGENTS_DIR: join(dir, "agents"),
    RECORD: join(dir, "argv"),
    PIDS: join(dir, "pids"),
  };
  delete env.NODE_TEST_CONTEXT;
  args = [
    "-m",
    "gpt-6-luna",
    "-c",
    "model_reasoning_effort=max",
    "logic-validator",
    join(dir, "brief"),
    dir,
  ];
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
let launchId = 0;
async function launch(extra: NodeJS.ProcessEnv = {}, input = args) {
  return await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve, reject) => {
    const id = launchId++;
    const outPath = join(dir, `stdout-${id}`),
      errPath = join(dir, `stderr-${id}`);
    const out = openSync(outPath, "w"),
      err = openSync(errPath, "w");
    const child = spawn("bun", [script, ...input], {
      env: { ...env, ...extra },
      cwd: dir,
      stdio: ["ignore", out, err],
    });
    closeSync(out);
    closeSync(err);
    child.on("error", reject);
    child.on("close", async (code) =>
      resolve({
        stdout: await readFile(outPath, "utf8"),
        stderr: await readFile(errPath, "utf8"),
        code,
      }),
    );
  });
}
async function fails(
  reason: string,
  extra: NodeJS.ProcessEnv = {},
  input = args,
) {
  const result = await launch(extra, input);
  strictEqual(result.code, 1);
  strictEqual(result.stdout, `reviewed-by: codex failed\nreason: ${reason}\n`);
}
describe("reviewer runner", () => {
  it("returns only the answer and passes exact argv", async () => {
    const result = await launch();
    strictEqual(result.code, 0);
    strictEqual(
      result.stdout,
      "reviewed-by: codex\nreviewer: logic-validator\nFindings\nverdict: pass",
    );
    const argv: string[] = JSON.parse(await readFile(env.RECORD ?? "", "utf8"));
    deepStrictEqual(argv.slice(0, 10), [
      "exec",
      "-m",
      "gpt-6-luna",
      "-c",
      "model_reasoning_effort=max",
      "--sandbox",
      "read-only",
      "-C",
      dir,
      "-o",
    ]);
    strictEqual(argv.length, 12);
    strictEqual(
      argv[11],
      `Read the file ${dir}/agents/logic-validator.md and treat everything after its frontmatter as your instructions as a reviewer, ignoring any line that mentions "executor: codex". Then read the review request in ${dir}/brief and carry it out. Answer in Japanese and end with exactly one line: verdict: pass, needs-work or blocker.`,
    );
  });
  describe("answer validation", { concurrency: 4 }, () => {
    for (const answer of [
      "verdict: pass  ",
      "Body\r\nverdict: pass\r\n",
      "verdict: needs-work",
      "verdict: blocker",
    ])
      it(`accepts ${JSON.stringify(answer)}`, async () => {
        const result = await launch({ ANSWER: answer });
        strictEqual(result.code, 0);
        ok(!result.stdout.includes("\r"));
      });
    for (const [answer, reason] of [
      ["**verdict: pass**", "no-verdict"],
      ["- verdict: pass", "no-verdict"],
      ["verdict: blocker\nbody\nverdict: pass", "multiple-verdicts"],
      ["verdict: pass\nverdict: blocker", "multiple-verdicts"],
      ["body", "no-verdict"],
      ["verdict: maybe", "no-verdict"],
      ["verdict: pass\nbody", "no-verdict"],
      ["", "empty-answer"],
    ])
      it(`rejects ${JSON.stringify(answer)}`, async () => {
        await fails(reason ?? "", { ANSWER: answer });
      });
  });
  it("handles missing output", async () => {
    await fails("empty-answer", { MODE: "missing" });
  });
  it("handles nonzero exit", async () => {
    await fails("exit 2", { EXIT: "2" });
  });
  it("isolates noisy logs", async () => {
    const result = await launch({ MODE: "noise" });
    strictEqual(result.code, 0);
    strictEqual(
      result.stdout,
      "reviewed-by: codex\nreviewer: logic-validator\nFindings\nverdict: pass",
    );
    ok(result.stderr.length > 300000);
  });
  for (const mode of ["sleep", "ignore", "grandchild"])
    it(`kills process group: ${mode}`, async () => {
      // The injected 200 ms timeout is what stops the fake; `reason: timeout`
      // proves it fired, so no wall-clock bound is asserted here (unit tests
      // stay free of elapsed-time checks).
      await fails("timeout", {
        MODE: mode,
        REVIEWER_CODEX_TIMEOUT_MS: "200",
        REVIEWER_CODEX_KILL_GRACE_MS: "100",
      });
      const pids = (await readFile(env.PIDS ?? "", "utf8"))
        .split("\n")
        .map(Number);
      // The runner returns right after sending SIGKILL, so a single look can
      // still see a dying process as running. Orphaned zombies may await the
      // container's init; they cannot execute anymore.
      const deadline = Date.now() + 2000;
      for (const pid of pids) {
        for (;;) {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              // ESRCH: the process was reaped between open and read.
              ok(error.code === "ENOENT" || error.code === "ESRCH", error);
              return null;
            },
          );
          const state = stat?.split(" ")[2];
          if (state === undefined || state === "Z") break;
          if (Date.now() > deadline) strictEqual(state, "Z");
          await sleep(10);
        }
      }
    });
  describe("invalid arguments", { concurrency: 4 }, () => {
    before(async () => {
      await rm(env.RECORD ?? "", { force: true });
    });
    after(async () => {
      for (const path of [env.RECORD ?? "", join(dir, "x")]) {
        await readFile(path).then(
          () => {
            throw new Error(`unexpected file: ${path}`);
          },
          (error: NodeJS.ErrnoException) => strictEqual(error.code, "ENOENT"),
        );
      }
    });
    for (const value of ["abc", "0", "-1", "3600001"])
      it(`rejects timeout ${value}`, async () => {
        await fails("bad-arguments: timeout", {
          REVIEWER_CODEX_TIMEOUT_MS: value,
        });
      });
    it("rejects negative grace", async () => {
      await fails("bad-arguments: grace", {
        REVIEWER_CODEX_KILL_GRACE_MS: "-1",
      });
    });
    const cases: [number, string, () => string[]][] = [
      [
        5,
        "brief",
        () => [
          "/tmp/a b.md",
          "/tmp/$(touch x).md",
          '/tmp/a"b.md',
          "relative",
          "/tmp/../etc/passwd",
          join(dir, "absent"),
          dir,
        ],
      ],
      [
        6,
        "root",
        () => [join(dir, "absent"), args[5] ?? "", "/tmp/../etc", "/tmp/a b"],
      ],
      [4, "reviewer", () => ["../logic-validator", "absent"]],
    ];
    for (const [index, label, values] of cases) {
      const count = label === "brief" ? 7 : label === "root" ? 4 : 2;
      for (let n = 0; n < count; n++)
        it(`rejects ${label} case ${n + 1}`, async () => {
          const input = [...args];
          input[index] = values()[n] ?? "";
          await fails(`bad-arguments: ${label}`, {}, input);
        });
    }
    const GOOD = ["logic-validator", "/tmp/a", "/tmp"];
    // Argument checks return before any I/O, so call runReviewer directly;
    // launching bun per case would push this file further past its time cap.
    const rejects = async (reason: string, input: string[]) => {
      deepStrictEqual(await runReviewer(input, env), {
        stdout: `reviewed-by: codex failed\nreason: ${reason}\n`,
        code: 1,
      });
    };
    it("rejects shape: old three-argument form (launched)", async () => {
      await fails("bad-arguments: shape", {}, GOOD);
    });
    const shapeCases: [string, string[]][] = [
      [
        "swapped order",
        ["-c", "model_reasoning_effort=max", "-m", "gpt-6-luna", ...GOOD],
      ],
      [
        "sandbox override",
        ["-m", "gpt-6-luna", "-c", "sandbox_mode=danger-full-access", ...GOOD],
      ],
      [
        "eight arguments",
        ["-m", "gpt-6-luna", "-c", "model_reasoning_effort=max", ...GOOD, "x"],
      ],
    ];
    for (const [label, input] of shapeCases)
      it(`rejects shape: ${label}`, async () => {
        await rejects("bad-arguments: shape", input);
      });
    for (const model of ["GPT-6-luna", "gpt-6-luna;rm", ""])
      it(`rejects model ${JSON.stringify(model)}`, async () => {
        const input = [...args];
        input[1] = model;
        await rejects("bad-arguments: model", input);
      });
    for (const effort of ["ultra", '"max"', "", "unknown"])
      it(`rejects effort ${JSON.stringify(effort)}`, async () => {
        const input = [...args];
        input[3] = `model_reasoning_effort=${effort}`;
        await rejects("bad-arguments: effort", input);
      });
    it("rejects agents directory", async () => {
      await fails("bad-arguments: agents-dir", {
        REVIEWER_CODEX_AGENTS_DIR: "/tmp/a b",
      });
    });
  });
  it("accepts maximum timeout", async () => {
    strictEqual(
      (await launch({ REVIEWER_CODEX_TIMEOUT_MS: "3600000" })).code,
      0,
    );
  });
  it("handles temp directory failure", async () => {
    await fails("internal-error: ENOENT", { TMPDIR: join(dir, "absent") });
  });
  it("handles read failure", async () => {
    await fails("internal-error: EISDIR", { MODE: "directory" });
  });
  it("handles spawn failure", async () => {
    await fails("spawn-error: ENOENT", {
      REVIEWER_CODEX_BIN: join(dir, "absent"),
    });
  });
  it("preserves success when filesystem cleanup fails", async () => {
    const result = await launch({ MODE: "cleanup" });
    const argv: string[] = JSON.parse(await readFile(env.RECORD ?? "", "utf8"));
    const output = argv[10] ?? "";
    const directory = output.slice(0, output.lastIndexOf("/"));
    try {
      strictEqual(result.code, 0);
      ok(result.stdout.startsWith("reviewed-by: codex\nreviewer:"));
      ok(result.stderr.includes("cleanup failed:"));
    } finally {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("preserves success and failure on cleanup errors", async () => {
    for (const answer of ["verdict: pass", "invalid"]) {
      let stderr = "";
      let temporary = "";
      const result = await runReviewer(
        args,
        { ...env, ANSWER: answer },
        {
          rm: async (path) => {
            temporary = String(path);
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );
      strictEqual(result.code, answer === "invalid" ? 1 : 0);
      ok(stderr.includes("cleanup failed: EACCES\n"));
      await rm(temporary, { recursive: true, force: true });
    }
  });
  it("handles unexpected dependency exceptions", async () => {
    const result = await runReviewer(args, env, {
      mkdtemp: async () => {
        throw new TypeError("failure");
      },
    });
    ok(result.stdout.includes("internal-error: TypeError"));
  });
  it("validates without side effects", () =>
    strictEqual(validateAnswer("verdict: pass"), null));
});

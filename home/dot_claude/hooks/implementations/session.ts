#!/usr/bin/env -S bun run --silent

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, opendirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getHomeDir, normalizeAbsolute } from "../lib/path-utils.ts";
import { defineHook } from "cc-hooks-ts";
import { logEvent } from "../lib/centralized-logging.ts";
import {
  matcherCoversGuardedTools,
  matcherCoversTools,
} from "../lib/guarded-tools.ts";
import {
  experimentNotices,
  readExperimentState,
} from "../lib/auto-mode-experiment.ts";
import {
  gcSceneState,
  SCENE_STATE_READERS,
  sceneStateDir,
} from "../lib/agent-learnings/core/scene-state.ts";
import { getLearningsHealthNotice } from "../lib/agent-learnings/claude/health.ts";
import {
  buildSessionLearningsContext,
  kickWorkerIfQueued,
  spawnWorker,
} from "../lib/agent-learnings/claude/session-context.ts";
import { isWorkerSession } from "../lib/agent-learnings/claude/worker-guard.ts";
import { readInbox, readLastFlush } from "../lib/dotfiles-feedback/cache.ts";
import { DOTFILES_REPO_KEY } from "../lib/dotfiles-feedback/constants.ts";
import { buildDependencyNotice } from "../lib/dependency-notice.ts";
import {
  resolvePasswdHome,
  type HomeResult,
} from "../lib/dotfiles-feedback/home.ts";
import { buildFeedbackNotice } from "../lib/dotfiles-feedback/notice.ts";
import { refreshArgv, spawnDetached } from "../lib/dotfiles-feedback/spawn.ts";
import { resolveRepoKey } from "../lib/repo-key.ts";
import { runGit } from "../lib/run-git.ts";
import { defaultStoreDir } from "../lib/agent-learnings/core/store.ts";
import { encodeSessionDirName, getProjectRoot } from "../lib/project-root.ts";
import { shellSingleQuote } from "../lib/shell-quote.ts";
import { resolveWorkflowPaths } from "../lib/workflow-paths.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

// Resolved per call so a HOME swap (tests) is honored.
function getGlobalSettingsPath(): string {
  return resolve(getHomeDir(), ".claude", "settings.json");
}

function checkSharedTaskList(): string | null {
  const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
  if (taskListId) {
    return `⚠️ CLAUDE_CODE_TASK_LIST_ID is set: ${taskListId}\n   This session shares a task list from another session. Tasks may be overwritten unintentionally.\n   To detach: unset CLAUDE_CODE_TASK_LIST_ID`;
  }
  return null;
}

/**
 * Whether the workflow looks armed, as the startup summary reports it.
 *
 * Deliberately a local copy of `isWorkflowActive` in lib/workflow-gate.ts
 * rather than an import: importing it would make the observer depend on the
 * module it exists to observe (spec K5). The copy is kept honest by a drift
 * test (session.test.ts) that runs both against one fixture table.
 *
 * One deliberate degradation: the guard also returns true when
 * `workflow-state.json` says `mode === "document-workflow"`, and this does not
 * read that file. Measured: no such file exists in this repository or in any
 * project under ~/workspace. The degradation is conservative -- it can report
 * inactive while the guard enforces, never the reverse.
 */
export function isWorkflowArmedForTesting(
  wfPaths: ReturnType<typeof resolveWorkflowPaths>,
): boolean {
  return existsSync(wfPaths.plan) || existsSync(wfPaths.research);
}

/**
 * Pull the matcher of the settings entry whose command references `fileName`
 * under the given hook event.
 */
export function extractHookMatcher(
  settings: unknown,
  event: string,
  fileName: string,
): string | null {
  const entries = (settings as { hooks?: Record<string, unknown> })?.hooks?.[
    event
  ];
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const e = entry as { matcher?: unknown; hooks?: { command?: unknown }[] };
    const references =
      Array.isArray(e.hooks) &&
      e.hooks.some(
        (h) => typeof h?.command === "string" && h.command.includes(fileName),
      );
    // An entry without a matcher key matches every tool, same as "".
    if (references) {
      if (typeof e.matcher === "string") return e.matcher;
      if (e.matcher === undefined) return "";
    }
  }
  return null;
}

/** Pull the guard's PreToolUse matcher out of a parsed settings object. */
export function extractGuardMatcher(settings: unknown): string | null {
  return extractHookMatcher(
    settings,
    "PreToolUse",
    "document-workflow-guard.ts",
  );
}

/**
 * Point 1 of the startup summary (decision 5): report what the guard's
 * PreToolUse matcher covers.
 *
 * Audit scope is deliberately narrow (decision 4): only
 * `~/.claude/settings.json` is read. Claude Code also merges project-level
 * `.claude/settings.json` and `settings.local.json`, but reimplementing that
 * full merge here would assert a guarantee ("the matcher is armed") that this
 * single-file read cannot back up. The file that was audited is named in the
 * message so the guarantee's boundary is visible, not implied.
 *
 * Wrapped in its own try/catch so a malformed or unreadable settings file
 * cannot blank out the other four startup-summary points.
 */
export function auditGuardWiring(): string {
  try {
    if (!existsSync(getGlobalSettingsPath())) {
      return `wiring (${getGlobalSettingsPath()}): file not found; could not audit the guard's PreToolUse matcher.`;
    }
    const parsed = JSON.parse(readFileSync(getGlobalSettingsPath(), "utf-8"));
    const matcher = extractGuardMatcher(parsed);
    if (matcher === null) {
      return `wiring (${getGlobalSettingsPath()}): no PreToolUse entry references document-workflow-guard.ts.`;
    }
    const coverage = matcherCoversGuardedTools(matcher);
    return coverage.covered
      ? `wiring (${getGlobalSettingsPath()}): matcher "${matcher}" covers all guarded tools.`
      : `wiring (${getGlobalSettingsPath()}): matcher "${matcher}" is missing ${coverage.missing.join(", ")}.`;
  } catch (error) {
    // Deliberately not String(error): settings.json can carry tokens in an
    // `env` block, and unlike Bun, Node sometimes embeds a slice of the
    // offending input in a JSON.parse SyntaxError message.
    return `wiring (${getGlobalSettingsPath()}): could not audit it (${
      error instanceof Error ? error.name : "unknown"
    }).`;
  }
}

/**
 * Startup-summary line for the PostToolUse entry that records AskUserQuestion
 * approval answers. Separate from auditGuardWiring with its own try/catch so
 * one failing audit cannot take the other down. Coverage is judged by the
 * shared matcherCoversTools rather than a copy of that logic.
 */
export function auditAnswerRecorderWiring(): string {
  try {
    if (!existsSync(getGlobalSettingsPath())) {
      return `wiring (${getGlobalSettingsPath()}): file not found; could not audit the approval-answer-recorder PostToolUse matcher.`;
    }
    const parsed = JSON.parse(readFileSync(getGlobalSettingsPath(), "utf-8"));
    const matcher = extractHookMatcher(
      parsed,
      "PostToolUse",
      "approval-answer-recorder.ts",
    );
    if (matcher === null) {
      return `wiring (${getGlobalSettingsPath()}): no PostToolUse entry references approval-answer-recorder.ts; AskUserQuestion approvals will not be recorded.`;
    }
    const coverage = matcherCoversTools(matcher, ["AskUserQuestion"]);
    return coverage.covered
      ? `wiring (${getGlobalSettingsPath()}): approval-answer-recorder matcher "${matcher}" covers AskUserQuestion.`
      : `wiring (${getGlobalSettingsPath()}): approval-answer-recorder matcher "${matcher}" is missing ${coverage.missing.join(", ")}.`;
  } catch (error) {
    return `wiring (${getGlobalSettingsPath()}): could not audit approval-answer-recorder (${
      error instanceof Error ? error.name : "unknown"
    }).`;
  }
}

/**
 * Hooks find the session's primary working directory by comparing candidate
 * paths against the name of the transcript directory (createSettingsRoots).
 * That naming rule is not documented. Right after startup the primary working
 * directory is the hook input cwd, so the two names can be compared here; a
 * mismatch means the comparison finds nothing for this session. Unlike the
 * wiring audits above this returns null when there is nothing to report. It
 * only sees the characters in the startup path, so a change to how some other
 * character is encoded goes unnoticed.
 */
function auditTranscriptDirName(input: {
  source: string;
  cwd: string;
  transcript_path: string;
}): string | null {
  if (input.source !== "startup") return null;
  if (!isAbsolute(input.cwd) || !isAbsolute(input.transcript_path)) return null;
  const actual = basename(dirname(input.transcript_path));
  if (actual === encodeSessionDirName(normalizeAbsolute(input.cwd)))
    return null;
  return `[session] the transcript directory name ${JSON.stringify(actual)} does not match the name derived from the startup directory ${JSON.stringify(input.cwd)}. Hooks read project-settings /path permission rules against the startup directory after this session enters a worktree. See "本体と合わせていない点" in docs/decisions/0027-permission-path-pattern-semantics.md.`;
}

/**
 * dotfiles のセッションの開始時に、dotfiles-feedback の件数を 1 行で知らせる。
 *
 * ここから lib/dotfiles-feedback/ へ辿ってよいのは cache・constants・notice・spawn・home だけ
 * （境界のテストが閉包を見る）。gh・spool・flush などを足すと、hook の中でネットワークを待つ。
 * 件数を新しくするのは detached の `refresh` で、hook はキャッシュを読んで起動するだけにする。
 */
export type FeedbackSectionDeps = {
  cwd: string;
  resolveRepoKey(cwd: string): string | null;
  resolveHome(): HomeResult;
  // 指定があれば home の解決を飛ばす（テストが一時ディレクトリを渡す）。
  root?: string | undefined;
  spawnDetached(argv: readonly string[]): Promise<boolean>;
  cliPath: string;
  now(): Date;
  isVm: boolean;
  isWorker: boolean;
  log(line: string): void;
};

const FEEDBACK_PENDING_SCAN_LIMIT = 200;

// 1 件見つけた時点で打ち切る。大きな pending/ を hook の中で全部読まない。
function hasPendingJson(dir: string): boolean {
  let handle: ReturnType<typeof opendirSync>;
  try {
    handle = opendirSync(dir);
  } catch {
    return false;
  }
  try {
    for (let seen = 0; seen < FEEDBACK_PENDING_SCAN_LIMIT; seen++) {
      const entry = handle.readSync();
      if (entry === null) return false;
      if (entry.name.endsWith(".json")) return true;
    }
    return false;
  } finally {
    handle.closeSync();
  }
}

export async function runFeedbackSection(
  deps: FeedbackSectionDeps,
): Promise<{ line: string | null }> {
  try {
    if (deps.isWorker || deps.isVm) return { line: null };
    if (deps.resolveRepoKey(deps.cwd) !== DOTFILES_REPO_KEY)
      return { line: null };
    let root = deps.root;
    if (root === undefined) {
      const home = deps.resolveHome();
      if (!home.ok) throw new Error(home.reason);
      root = join(home.home, ".local", "share", "dotfiles-feedback");
    }
    const now = deps.now();
    const inbox = readInbox(join(root, "state", "inbox.json"), now);
    const lastFlush = readLastFlush(
      join(root, "state", "last-flush.json"),
      now,
      hasPendingJson(join(root, "pending")),
    );
    const line = buildFeedbackNotice({ inbox, lastFlush }, now);
    // 件数を新しくするのは refresh だけなので、通知の有無にかかわらず毎回起動する。
    await deps.spawnDetached(refreshArgv(deps.cliPath));
    return { line };
  } catch (error) {
    deps.log(
      `dotfiles-feedback notice failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return { line: null };
  }
}

export function createFeedbackSectionDeps(input: {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  resolvePasswdHome?: () => HomeResult;
  spawnDetached?: FeedbackSectionDeps["spawnDetached"];
  resolveRepoKey?: FeedbackSectionDeps["resolveRepoKey"];
  now?: () => Date;
}): FeedbackSectionDeps {
  return {
    cwd: input.cwd,
    resolveRepoKey:
      input.resolveRepoKey ?? ((cwd) => resolveRepoKey(cwd, runGit)),
    // spool の場所は HOME で動かさない。CLI の入口と同じく passwd から求める。
    resolveHome:
      input.resolvePasswdHome ??
      (() =>
        typeof process.getuid === "function"
          ? resolvePasswdHome(
              (file, args, env) => {
                const r = spawnSync(file, [...args], {
                  env,
                  encoding: "utf8",
                  timeout: 5_000,
                  shell: false,
                });
                return { code: r.status, stdout: r.stdout ?? "" };
              },
              process.platform,
              process.getuid(),
            )
          : { ok: false, reason: "uid を取得できない" }),
    spawnDetached: input.spawnDetached ?? spawnDetached,
    cliPath: fileURLToPath(
      new URL("../cli/dotfiles-feedback.ts", import.meta.url),
    ),
    now: input.now ?? (() => new Date()),
    isVm: existsSync("/etc/agent-vm"),
    isWorker: isWorkerSession(input.env),
    log: (line) => console.error(line),
  };
}

// テストが実機の spool と refresh に触れないようにする。preload が立てるので、
// 本番ではこの変数を設定しない。
export const FEEDBACK_NOTICE_DISABLE_ENV =
  "CLAUDE_HOOKS_DISABLE_FEEDBACK_NOTICE";
let feedbackSectionOverride: FeedbackSectionDeps | null = null;
export function setFeedbackSectionDepsForTesting(
  deps: FeedbackSectionDeps | null,
): void {
  feedbackSectionOverride = deps;
}

export function mergeAdditionalContext(
  learnings: string | null,
  feedbackLine: string | null,
  extraLine: string | null = null,
): string | null {
  const parts = [learnings, feedbackLine, extraLine].filter(
    (part): part is string => part !== null && part !== "",
  );
  return parts.length > 0 ? parts.join("\n") : null;
}

async function feedbackNoticeLine(cwd: string): Promise<string | null> {
  if (feedbackSectionOverride)
    return (await runFeedbackSection(feedbackSectionOverride)).line;
  if (process.env[FEEDBACK_NOTICE_DISABLE_ENV] === "1") return null;
  return (
    await runFeedbackSection(
      createFeedbackSectionDeps({ cwd, env: process.env }),
    )
  ).line;
}

/**
 * Session management hooks
 * Handles SessionStart events using centralized logging
 */
const hook = defineHook({
  trigger: { SessionStart: true },
  run: async (context) => {
    try {
      // Log session start using centralized logger
      logEvent("SessionStart", context.input.session_id);

      // Resolve the workflow dir the same way the guard does (K1/K3),
      // rather than trusting a pre-set value unconditionally: a pin that
      // escapes .tmp/sessions is rejected here exactly as it is by the guard,
      // so the two cannot silently disagree about which directory is armed.
      // The root is getProjectRoot(). In production that is the
      // CLAUDE_PROJECT_DIR Claude Code passes (the dir the session started
      // in), which a Bash `cd` or a move into a worktree does not change.
      // input.cwd is not used.
      const cwd = getProjectRoot();
      const sessionId = context.input.session_id;
      const resolution = resolveWorkflowDir({ cwd, sessionId });
      const userPin = process.env.DOCUMENT_WORKFLOW_DIR;

      // Export session info to CLAUDE_ENV_FILE for skills to consume
      //
      // The workflow dir and the session id are deliberately not exported
      // (spec K4). An exported value outlives /clear in the Bash env and
      // pointed `workflow-cli` and model-written paths at the previous
      // session's dir (#197). Bash gets them from `workflow-cli dir` and from
      // CLAUDE_CODE_SESSION_ID, which Claude Code itself keeps current.
      const envFile = process.env.CLAUDE_ENV_FILE;
      if (envFile) {
        const transcriptPath = context.input.transcript_path;
        // Not the transcript directory name: this replaces "/" only.
        // encodeSessionDirName is the rule Claude Code uses for that name.
        const projectHash = context.input.cwd
          .replace(/\//g, "-")
          .replace(/^-/, "");
        appendFileSync(
          envFile,
          `export CLAUDE_PROJECT_DIR=${shellSingleQuote(cwd)}\n`,
        );
        appendFileSync(
          envFile,
          `export CLAUDE_TRANSCRIPT_PATH=${shellSingleQuote(transcriptPath)}\n`,
        );
        appendFileSync(
          envFile,
          `export CLAUDE_PROJECT_HASH=${shellSingleQuote(projectHash)}\n`,
        );

        const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
        if (taskListId) {
          appendFileSync(
            envFile,
            `export CLAUDE_TASK_LIST_ID=${shellSingleQuote(taskListId)}\n`,
          );
        }

        // This block is deliberately NOT wrapped in its own try/catch, unlike
        // the settings read in auditGuardWiring(). A write failure here
        // (e.g. CLAUDE_ENV_FILE naming a directory that does not exist) must
        // reach the outer catch below so the startup summary reports the
        // failure (K5a) instead of the hook silently no-op'ing through
        // context.success({}). session.test.ts's "reports the failure
        // through systemMessage when the run actually throws" depends on
        // this propagation; isolating this block the way the settings read
        // is isolated would make that regression guard vacuous.
      }

      const taskListWarning = checkSharedTaskList();
      const messages = [
        "🚀 Claude Code session started. Ready for development!",
        auditGuardWiring(),
        auditAnswerRecorderWiring(),
      ];

      if (resolution.source === "unresolvable") {
        // K2b: unresolvable has more than one cause, and the message must
        // name the check that failed, not guess at one of them.
        messages.push(
          resolution.reason === "invalid-session-id"
            ? "[session] the session id is malformed, so no workflow directory could be derived; the workflow gate is not enforcing."
            : `[session] could not verify that the derived workflow directory is a strict descendant of ${cwd}/.tmp/sessions; the workflow gate is not enforcing.`,
        );
      } else {
        const sourceLabel =
          resolution.source === "env" ? " (user-specified)" : "";
        messages.push(
          `Document Workflow directory: ${resolution.relative}/${sourceLabel}`,
        );
        messages.push(
          `resolved: ${resolution.dir} (source: ${resolution.source})`,
        );
        const wfPaths = resolveWorkflowPaths(resolution.dir);
        messages.push(
          `workflow gate: ${isWorkflowArmedForTesting(wfPaths) ? "armed" : "inactive"}`,
        );
        if (resolution.source === "env-rejected") {
          messages.push(
            `[session] DOCUMENT_WORKFLOW_DIR="${userPin}" was rejected (not a verified descendant of ${cwd}/.tmp/sessions) and the derived directory ${resolution.relative} is used instead.`,
          );
        }
      }

      messages.push(
        `warn-only mode: ${process.env.DOCUMENT_WORKFLOW_WARN_ONLY === "1" ? "on" : "off"}`,
      );

      if (context.input.cwd !== cwd) {
        messages.push(
          `cwd mismatch: context.input.cwd=${context.input.cwd} but the project root is ${cwd}.`,
        );
      }

      const transcriptDirNotice = auditTranscriptDirName(context.input);
      if (transcriptDirNotice) {
        messages.push(transcriptDirNotice);
      }

      if (taskListWarning) {
        messages.push(taskListWarning);
      }

      // The reader touches the filesystem; a failure there must not drop the
      // notices gathered above.
      try {
        messages.push(...experimentNotices(Date.now(), readExperimentState()));
      } catch (error) {
        console.error(`auto-mode experiment notice failed: ${error}`);
      }

      // SessionStart では cc-hooks-ts の success() が messageForUser を破棄する
      // (additionalClaudeContext しか読まない)。加えて素の stdout は hook_success
      // attachment として Claude のモデル入力に注入されるため、ユーザー向け通知には
      // 使えない。systemMessage は UI に表示され、モデル入力には入らない唯一のチャネル
      // なので、digest のプレビューのような他プロジェクト由来の内容もここで返す。
      // 入力に入らない保証は Claude Code の binary 実測に依るため、Claude Code を
      // 更新したら hook_system_message が変換テーブルで注入されない扱いのままか確かめる。
      // なお context.json の event は trigger 宣言に対して型検査され、ランタイムの
      // hook_event_name とは結び付かない。複数イベント trigger に変える場合は注意。
      // 学びはモデルに渡す必要があるので、UI だけの systemMessage ではなく
      // hookSpecificOutput.additionalContext で返す。
      let learningsContext: string | null = null;
      try {
        learningsContext = await buildSessionLearningsContext({
          cwd,
          home: getHomeDir(),
          runGit,
          now: new Date(),
        });
      } catch (error) {
        console.error(`agent-learnings context failed: ${error}`);
      }
      // 取りこぼしたジョブの worker を起こし、異常があれば 1 行知らせる。
      // どれも失敗は stderr に 1 行出して続ける。worker のセッションでは何もしない
      if (!isWorkerSession(process.env)) {
        try {
          kickWorkerIfQueued(getHomeDir(), { spawn: spawnWorker });
        } catch (error) {
          console.error(`agent-learnings worker start failed: ${error}`);
        }
        // reader ごとに state の置き場が違う。片方の失敗でもう片方を止めない
        for (const reader of SCENE_STATE_READERS) {
          try {
            gcSceneState(sceneStateDir(getHomeDir(), reader), new Date());
          } catch (error) {
            console.error(
              `agent-learnings scene state gc failed (${reader}): ${error}`,
            );
          }
        }
        try {
          const learningsHealth = getLearningsHealthNotice({
            store: defaultStoreDir(getHomeDir()),
            now: new Date(),
            runGit,
          });
          if (learningsHealth) messages.push(learningsHealth);
        } catch (error) {
          console.error(`agent-learnings health notice failed: ${error}`);
        }
      }
      // 通知は UI の systemMessage にも、同じ 1 行をモデルの文脈にも渡す（spec K6）。
      const feedbackLine = await feedbackNoticeLine(cwd);
      if (feedbackLine) messages.push(feedbackLine);
      let dependencyNotice: string | null = null;
      try {
        dependencyNotice = buildDependencyNotice(context.input.cwd);
      } catch (error) {
        console.error("dependency notice failed:", error);
      }
      if (dependencyNotice) messages.push(dependencyNotice);
      const additionalContext = mergeAdditionalContext(
        learningsContext,
        feedbackLine,
        dependencyNotice,
      );
      return context.json({
        event: "SessionStart",
        output: {
          systemMessage: messages.join("\n"),
          ...(additionalContext
            ? {
                hookSpecificOutput: {
                  hookEventName: "SessionStart" as const,
                  additionalContext,
                },
              }
            : {}),
        },
      });
    } catch (error) {
      // K5a: an escaping exception must be reported through systemMessage,
      // not silently swallowed into context.success({}) -- that would arm
      // nothing while looking identical to a healthy startup.
      console.error(`Session start error: ${error}`);
      return context.json({
        event: "SessionStart",
        output: {
          systemMessage: `⚠️ Session start hook failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}

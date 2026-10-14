import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRedactList } from "../../insight-digest.ts";
import { drainInbox } from "../core/inbox.ts";
import type { RunGit } from "../core/git.ts";
import { COMMON_KEY } from "../core/learnings-file.ts";
import { renderLearnings } from "../core/render.ts";
import { resolveRepoKey } from "../core/repo-key.ts";
import {
  appendReadLog,
  commonFilePath,
  defaultStoreDir,
  readLearnings,
  repoFilePath,
  storePaths,
} from "../core/store.ts";

// SessionStart で Claude の文脈へ渡す学び。store が無い・repo の外なら null。
// Codex が inbox に置いた依頼はここで取り込む（lock が取れなければ飛ばす）。
export async function buildSessionLearningsContext(input: {
  cwd: string;
  home: string;
  runGit: RunGit;
  now: Date;
}): Promise<string | null> {
  const store = defaultStoreDir(input.home);
  if (!existsSync(join(store, ".git"))) return null;
  const repoKey = resolveRepoKey(input.cwd, input.runGit);
  if (repoKey === null) return null;

  await drainInbox(store, {
    waitMs: 0,
    today: input.now.toISOString().slice(0, 10),
    runGit: input.runGit,
    extraRedact: loadRedactList(
      join(input.home, ".claude/insight-distill-redact.txt"),
    ),
  });

  const repo = readLearnings(store, repoKey);
  const common = readLearnings(store, COMMON_KEY);
  const rendered = renderLearnings({
    repo: repo.ok ? repo.value : null,
    common: common.ok ? common.value : null,
    repoPath: repoFilePath(store, repoKey),
    commonPath: commonFilePath(store),
  });
  if (rendered !== null) {
    appendReadLog(storePaths(store).readsLog, {
      at: input.now,
      reader: "claude",
      repoKey,
    });
  }
  return rendered;
}

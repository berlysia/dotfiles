// 測定の母集団の一覧と寸法を、記録した SHA の版から作る（本文は取り出さない）。
//
// 読むのは git ls-tree の一覧、オブジェクトの大きさ、ブログの frontmatter（題・日付・draft）、
// 履歴の差分の追加行と削除行の語（改稿の組の条件の判定だけに使い、保存しない）だけ。
// 結果のデータはリポジトリに書かず、標準出力に出す。
// git と gh はシェルを通さず、引数の配列で呼ぶ（パスの前に `--`）。
//
// 使い方: node tests/lib/ja-baseline/extract.mjs [--dotfiles DIR] [--blog DIR] [--cpk DIR] [--full]
// c108 は件数とバイト数の合計だけを出す（ファイル名は出さない）。

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_DOCUMENT_BYTES,
  classifyBlogEntry,
  docTypeForPath,
  isC108Chapter,
  parseBlogFrontmatter,
} from "../ja-baseline.mjs";

const GIT_MAX_BUFFER = 512 * 1024 * 1024;

export function git(dir, args, { input } = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

export function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// 既定ブランチの先頭の commit。測定の SHA はここから到達できるものに限る。
// branchHint が無いときは origin/HEAD、origin/main、origin/master の順に試す。
export function defaultBranchHead(dir, branchHint) {
  const refs = [];
  if (branchHint) refs.push(branchHint);
  else {
    try {
      refs.push(
        git(dir, [
          "symbolic-ref",
          "--short",
          "refs/remotes/origin/HEAD",
        ]).trim(),
      );
    } catch {
      // origin/HEAD が無いときは下の既定の名前を試す
    }
    refs.push("origin/main", "origin/master");
  }
  for (const ref of refs) {
    try {
      const sha = git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    } catch {
      // 次の候補を試す
    }
  }
  throw new Error("no-default-branch");
}

// `git ls-tree -r -z <sha> -- <paths>` の全部（モードと blob つき）。
export function listTree(dir, sha, paths) {
  const out = git(dir, ["ls-tree", "-r", "-z", sha, "--", ...paths]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [meta, path] = entry.split("\t");
      const [mode, type, blob] = meta.split(" ");
      return { mode, type, blob, path };
    });
}

// blob の大きさ（`git cat-file --batch-check`）。
export function blobSizes(dir, blobs) {
  if (blobs.length === 0) return new Map();
  const out = git(
    dir,
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    {
      input: `${blobs.join("\n")}\n`,
    },
  );
  return new Map(
    out
      .trim()
      .split("\n")
      .map((line) => {
        const [blob, size] = line.split(" ");
        return [blob, Number(size)];
      }),
  );
}

function commitType(subject) {
  return /^([a-z]+)(?:\([^)]*\))?!?:/.exec(subject)?.[1] ?? null;
}

// 追加行にあって削除行に無い、数字・バッククォートの語・英数の語・URL の数。
const TOKEN_PATTERNS = [
  /https?:\/\/[^\s)>\]]+/g,
  /`[^`]+`/g,
  /\d+(?:\.\d+)?/g,
  /[A-Za-z][A-Za-z0-9_-]*/g,
];
function tokensOf(lines) {
  const found = new Set();
  for (const line of lines) {
    for (const pattern of TOKEN_PATTERNS) {
      for (const m of line.matchAll(pattern)) found.add(m[0]);
    }
  }
  return found;
}
function newTokenCount(diffText) {
  const added = [];
  const removed = [];
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  const before = tokensOf(removed);
  return [...tokensOf(added)].filter((t) => !before.has(t)).length;
}

// 改稿の組の候補を作る。(a) のパスに触れた非マージの commit のうち、同じパスの前後で追加と
// 削除の両方があり、追加と削除の合計が 40 行以下の組の全部。research の 64 件の条件のうち、
// type の制限（docs・style・refactor・fix）と「追加行に新しい語が無い」を外した件数も数える。
export function listRevisionPairs(dir, sha, docPaths) {
  const pathSet = new Set(docPaths);
  const log = git(dir, [
    "log",
    "--no-merges",
    "--no-renames",
    "--format=\x01%H %P%x09%s",
    "--numstat",
    sha,
    "--",
    "docs/decisions",
    "docs/plans",
  ]);
  const candidates = [];
  let current = null;
  for (const line of log.split("\n")) {
    if (line.startsWith("\x01")) {
      const [head, subject] = line.slice(1).split("\t");
      const [commit, parent] = head.split(" ");
      current = { commit, parent: parent ?? null, subject };
    } else if (current && line.trim()) {
      const [add, del, path] = line.split("\t");
      if (!pathSet.has(path) || add === "-" || !current.parent) continue;
      const added = Number(add);
      const removed = Number(del);
      if (added > 0 && removed > 0 && added + removed <= 40)
        candidates.push({ ...current, path });
    }
  }
  return candidates.map((c) => {
    const diff = git(dir, [
      "diff",
      "-U0",
      "--no-renames",
      c.parent,
      c.commit,
      "--",
      c.path,
    ]);
    return {
      commit: c.commit,
      parent: c.parent,
      path: c.path,
      type: commitType(c.subject),
      newTokens: newTokenCount(diff),
    };
  });
}

const RESEARCH_TYPES = new Set(["docs", "style", "refactor", "fix"]);

// 既定ブランチから到達できるマージ commit の題から、直近 n 件の PR の番号を取る。
export function listRecentPrNumbers(dir, sha, n) {
  const log = git(dir, ["log", "--first-parent", "--format=%s", sha]);
  const numbers = [];
  for (const subject of log.split("\n")) {
    const num =
      /^Merge pull request #(\d+) from /.exec(subject)?.[1] ??
      /\(#(\d+)\)$/.exec(subject)?.[1];
    if (num && /^\d+$/.test(num)) numbers.push(Number(num));
    if (numbers.length === n) break;
  }
  return numbers;
}

function repoVisibility(slug) {
  const out = JSON.parse(gh(["repo", "view", slug, "--json", "visibility"]));
  return out.visibility;
}

export function buildInventory({ dotfiles, blog, cpk, full = false }) {
  const result = {};

  // 公開の確認
  result.visibility = {
    dotfiles: repoVisibility("berlysia/dotfiles"),
    blog: repoVisibility("berlysia/blog.berlysia.net"),
  };

  // (a) docs と (b)
  const sha = defaultBranchHead(dotfiles, "origin/master");
  result.dotfilesSha = sha;
  const tree = listTree(dotfiles, sha, ["docs/decisions", "docs/plans"]);
  const regular = tree.filter((e) => e.mode === "100644");
  const aDocs = regular.filter((e) => docTypeForPath(e.path) !== null);
  const sizes = blobSizes(
    dotfiles,
    aDocs.map((e) => e.blob),
  );
  const sum = (entries, sizeOf) => entries.reduce((n, e) => n + sizeOf(e), 0);
  result.aDoc = {
    count: aDocs.length,
    bytes: sum(aDocs, (e) => sizes.get(e.blob)),
    tooLarge: aDocs.filter((e) => sizes.get(e.blob) > MAX_DOCUMENT_BYTES)
      .length,
    byType: {
      design: aDocs.filter((e) => docTypeForPath(e.path) === "design").length,
      report: aDocs.filter((e) => docTypeForPath(e.path) === "report").length,
      procedure: aDocs.filter((e) => docTypeForPath(e.path) === "procedure")
        .length,
    },
    nonRegularMode: tree.filter((e) => e.mode !== "100644").length,
    nonMarkdownOrOutside: regular.length - aDocs.length,
  };

  const firstVersions = [];
  for (const entry of aDocs) {
    const commits = git(dotfiles, [
      "log",
      "--no-merges",
      "--reverse",
      "--format=%H",
      sha,
      "--",
      entry.path,
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    if (commits.length < 2) continue;
    const blob = git(dotfiles, [
      "rev-parse",
      `${commits[0]}:${entry.path}`,
    ]).trim();
    firstVersions.push({ path: entry.path, commit: commits[0], blob });
  }
  const firstSizes = blobSizes(
    dotfiles,
    firstVersions.map((v) => v.blob),
  );
  result.b = {
    count: firstVersions.length,
    bytes: sum(firstVersions, (v) => firstSizes.get(v.blob)),
    tooLarge: firstVersions.filter(
      (v) => firstSizes.get(v.blob) > MAX_DOCUMENT_BYTES,
    ).length,
  };

  // 改稿の組
  const pairs = listRevisionPairs(
    dotfiles,
    sha,
    aDocs.map((e) => e.path),
  );
  const research = (p) => RESEARCH_TYPES.has(p.type) && p.newTokens === 0;
  result.pairs = {
    total: pairs.length,
    files: new Set(pairs.map((p) => p.path)).size,
    researchConditions: pairs.filter(research).length,
    researchFiles: new Set(pairs.filter(research).map((p) => p.path)).size,
    breakdown: {
      withoutTypeRestriction: pairs.filter((p) => p.newTokens === 0).length,
      withoutNewTokenCondition: pairs.filter((p) => RESEARCH_TYPES.has(p.type))
        .length,
      withoutBoth: pairs.length,
    },
  };

  // (a) PR 本文
  const prNumbers = listRecentPrNumbers(dotfiles, sha, 20);
  let prFetched = 0;
  let prEmptyBodies = 0;
  for (const number of prNumbers) {
    const out = JSON.parse(
      gh([
        "pr",
        "view",
        String(number),
        "-R",
        "berlysia/dotfiles",
        "--json",
        "body,number",
      ]),
    );
    if (out.number === number) prFetched += 1;
    if (!out.body || !out.body.trim()) prEmptyBodies += 1;
  }
  result.aPr = {
    count: prNumbers.length,
    fetched: prFetched,
    emptyBodies: prEmptyBodies,
  };

  // ADR-0036（時間の測定の入力）
  result.adr0036AtSha = tree.some((e) =>
    /^docs\/decisions\/0036-[^/]+\.md$/.test(e.path),
  );

  // c108（件数とバイト数の合計だけ。名前は出さない）
  if (cpk) {
    const cpkSha = defaultBranchHead(cpk);
    const chapters = listTree(cpk, cpkSha, ["books/C108/manuscript/"]).filter(
      (e) =>
        e.mode === "100644" &&
        /^books\/C108\/manuscript\/[^/]+$/.test(e.path) &&
        isC108Chapter(e.path.split("/").pop()),
    );
    const cpkSizes = blobSizes(
      cpk,
      chapters.map((e) => e.blob),
    );
    result.c108 = {
      count: chapters.length,
      bytes: sum(chapters, (e) => cpkSizes.get(e.blob)),
      tooLarge: chapters.filter(
        (e) => cpkSizes.get(e.blob) > MAX_DOCUMENT_BYTES,
      ).length,
    };
  }

  // blog（公開。frontmatter の題・日付・draft だけ読む）
  if (blog) {
    const blogSha = defaultBranchHead(blog);
    result.blogSha = blogSha;
    const entries = listTree(blog, blogSha, ["articles/"]).filter(
      (e) => e.mode === "100644",
    );
    const articles = [];
    for (const e of entries) {
      const rel = e.path.slice("articles/".length);
      const parts = rel.split("/");
      const isFile = parts.length === 1 && rel.endsWith(".mdx");
      const isIndex = parts.length === 2 && parts[1] === "index.mdx";
      if (!isFile && !isIndex) continue;
      const entryName = isFile ? rel.replace(/\.mdx$/, "") : parts[0];
      const head = git(blog, ["cat-file", "blob", e.blob]).slice(0, 4096);
      articles.push({
        path: e.path,
        entryName,
        blob: e.blob,
        fm: parseBlogFrontmatter(head),
      });
    }
    const blogSizes = blobSizes(
      blog,
      articles.map((a) => a.blob),
    );
    result.blog = { candidates: [], excluded: [] };
    for (const a of articles) {
      const verdict = classifyBlogEntry(a.entryName, a.fm);
      const bytes = blogSizes.get(a.blob);
      if (verdict.candidate) {
        result.blog.candidates.push({
          path: a.path,
          date: verdict.date,
          title: a.fm.title,
          bytes,
          tooLarge: bytes > MAX_DOCUMENT_BYTES,
        });
      } else {
        result.blog.excluded.push({ path: a.path, reason: verdict.reason });
      }
    }
    result.blog.candidates.sort((x, y) => x.date.localeCompare(y.date));
  }

  if (full) {
    result.list = {
      aDoc: aDocs.map((e) => e.path),
      b: firstVersions.map((v) => v.path),
      pairs: pairs.map((p) => ({ commit: p.commit, path: p.path })),
      aPr: prNumbers,
    };
  }
  return result;
}

function main(argv) {
  const opts = { full: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--full") opts.full = true;
    else if (arg === "--dotfiles" || arg === "--blog" || arg === "--cpk")
      opts[arg.slice(2)] = resolve(argv[++i]);
    else throw new Error("unknown-option");
  }
  opts.dotfiles ??= process.cwd();
  process.stdout.write(`${JSON.stringify(buildInventory(opts), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));

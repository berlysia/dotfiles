import type {
  FeedbackDeps,
  GhRunResult,
} from "../../lib/dotfiles-feedback/deps.ts";
import {
  FEEDBACK_LABEL,
  FEEDBACK_REPO,
  PUBLIC_REPO,
} from "../../lib/dotfiles-feedback/constants.ts";
export type GhCall = {
  argv: readonly string[];
  options: Parameters<FeedbackDeps["runGh"]>[1];
};
export type FakeIssue = {
  number: number;
  state: string;
  body: string;
  user: string;
  pull_request: boolean;
  title?: string;
  updatedAt?: string;
  labels?: string[];
};
export type FakeComment = {
  id: number;
  user: string;
  body: string;
  createdAt: string;
};
export type FailureKind = "network" | "auth" | "timeout" | "malformed";
const FAILURES: Record<FailureKind, GhRunResult> = {
  network: { code: 1, stdout: "", stderr: "could not resolve host" },
  auth: { code: 4, stdout: "", stderr: "gh auth login" },
  timeout: { code: null, stdout: "", stderr: "", timedOut: true },
  malformed: { code: 0, stdout: "{broken", stderr: "" },
};
export function fakeGh() {
  const calls: GhCall[] = [];
  const issues: FakeIssue[] = [];
  const publicIssues: FakeIssue[] = [];
  const comments = new Map<number, FakeComment[]>();
  const failures: {
    match: (argv: readonly string[]) => boolean;
    kind: FailureKind;
  }[] = [];
  const full = (issue: FakeIssue) => ({
    title: "",
    updatedAt: "2026-10-29T00:00:00Z",
    labels: [FEEDBACK_LABEL],
    ...issue,
  });
  const arg = (argv: readonly string[], name: string) =>
    argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
  const fake = {
    calls,
    issues,
    publicIssues,
    comments,
    login: "berlysia",
    owner: "berlysia",
    isPrivate: true,
    intercept: null as ((call: GhCall) => Promise<GhRunResult | null>) | null,
    // 指定した呼び出しを失敗・timeout・壊れた応答にする。
    failWhen(match: (argv: readonly string[]) => boolean, kind: FailureKind) {
      failures.push({ match, kind });
    },
    addComment(
      number: number,
      comment: Partial<FakeComment> & { body: string },
    ) {
      const list = comments.get(number) ?? [];
      list.push({
        id: list.length + 1,
        user: "berlysia",
        createdAt: "2026-10-29T00:00:00Z",
        ...comment,
      });
      comments.set(number, list);
    },
    run: (async (argv, options) => {
      const call = { argv: [...argv], options };
      calls.push(call);
      const failure = failures.find((entry) => entry.match(call.argv));
      if (failure) return FAILURES[failure.kind];
      const intercepted = await fake.intercept?.(call);
      if (intercepted) return intercepted;
      let stdout = "";
      if (argv[0] === "api" && argv.includes("user"))
        stdout = JSON.stringify({ login: fake.login });
      else if (argv[0] === "repo")
        stdout = JSON.stringify({
          isPrivate: fake.isPrivate,
          owner: { login: fake.owner },
        });
      else if (argv[0] === "api") {
        const endpoint = argv.find((value) => value.startsWith("repos/")) ?? "";
        const comment = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(
          endpoint,
        );
        const single = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(endpoint);
        if (comment)
          stdout = (comments.get(Number(comment[1])) ?? [])
            .map((value) => JSON.stringify(value))
            .join("\n");
        else if (single) {
          const found = issues.find(
            (issue) => issue.number === Number(single[1]),
          );
          if (!found)
            return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
          stdout = JSON.stringify(full(found));
        } else {
          const state = argv
            .find((value) => value.startsWith("state="))
            ?.slice(6);
          const source = endpoint.startsWith(`repos/${PUBLIC_REPO}/`)
            ? publicIssues
            : issues;
          stdout = source
            .filter(
              (issue) => !state || state === "all" || issue.state === state,
            )
            .map((issue) => JSON.stringify(full(issue)))
            .join("\n");
        }
      } else if (argv[0] === "issue" && argv[1] === "create") {
        const target = arg(argv, "--repo") ?? argv[argv.indexOf("--repo") + 1];
        const list = target === PUBLIC_REPO ? publicIssues : issues;
        const number = list.length + 1;
        list.push({
          number,
          state: "open",
          title: arg(argv, "--title") ?? "",
          body: options.stdin ?? "",
          user: "berlysia",
          pull_request: false,
        });
        stdout = `https://github.com/${target ?? FEEDBACK_REPO}/issues/${number}\n`;
      } else if (argv[0] === "issue" && argv[1] === "comment") {
        fake.addComment(Number(argv[2]), { body: options.stdin ?? "" });
      } else if (argv[0] === "issue" && argv[1] === "edit") {
        const found = issues.find((issue) => issue.number === Number(argv[2]));
        const label = arg(argv, "--add-label");
        if (found && label)
          found.labels = [...(found.labels ?? [FEEDBACK_LABEL]), label];
      } else if (argv[0] === "issue" && argv[1] === "close") {
        const found = issues.find((issue) => issue.number === Number(argv[2]));
        if (found) found.state = "closed";
      }
      return { code: 0, stdout, stderr: "" };
    }) satisfies FeedbackDeps["runGh"],
  };
  return fake;
}

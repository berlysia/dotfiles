import type {
  FeedbackDeps,
  GhRunResult,
} from "../../lib/dotfiles-feedback/deps.ts";
import { FEEDBACK_REPO } from "../../lib/dotfiles-feedback/constants.ts";
export type GhCall = {
  argv: readonly string[];
  options: Parameters<FeedbackDeps["runGh"]>[1];
};
export function fakeGh() {
  const calls: GhCall[] = [];
  const issues: {
    number: number;
    state: string;
    body: string;
    user: string;
    pull_request: boolean;
  }[] = [];
  const fake = {
    calls,
    issues,
    login: "berlysia",
    owner: "berlysia",
    isPrivate: true,
    intercept: null as ((call: GhCall) => Promise<GhRunResult | null>) | null,
    run: (async (argv, options) => {
      const call = { argv: [...argv], options };
      calls.push(call);
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
      else if (argv[0] === "api")
        stdout = issues.map((issue) => JSON.stringify(issue)).join("\n");
      else if (argv[0] === "issue") {
        const number = issues.length + 1;
        issues.push({
          number,
          state: "open",
          body: options.stdin ?? "",
          user: "berlysia",
          pull_request: false,
        });
        stdout = `https://github.com/${FEEDBACK_REPO}/issues/${number}\n`;
      }
      return { code: 0, stdout, stderr: "" };
    }) satisfies FeedbackDeps["runGh"],
  };
  return fake;
}

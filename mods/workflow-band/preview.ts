// Prints the band outside a Claude Code session: the states it can be in, or
// with --live the state of the workflow dir `workflow-cli` resolves from here.
// It prints the rows `hooks/layout.ts` builds for the session, so colours and
// text match; the host's own wrapping and spacing around the band do not show.
import { spawnSync } from "node:child_process";

import { renderBand, renderSamples } from "./preview-render";
import type { CliRun, RenderOptions } from "./preview-render";

function runWorkflowCli(args: string[]): CliRun {
  const result = spawnSync("workflow-cli", args, { encoding: "utf-8" });
  if (result.error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `could not run: ${result.error.message}`,
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const USAGE = `Usage: workflow-band-preview [--live [workflow-cli options]] [--columns <n>] [--no-color]

Prints the workflow-band Mod's band without a Claude Code session.
  (no option)   every state the band can be in, from sample workflow-cli output
  --live        the workflow dir workflow-cli resolves from the current directory;
                the remaining arguments go to \`workflow-cli status\` and \`dir\`
                (outside a session, run it from the project root with --wf-dir <dir>)
`;

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const rest = [...argv];
  const take = (flag: string): boolean => {
    const index = rest.indexOf(flag);
    if (index === -1) return false;
    rest.splice(index, 1);
    return true;
  };
  const live = take("--live");
  const noColor = take("--no-color");
  let columns = process.stdout.columns ?? 120;
  const columnsIndex = rest.indexOf("--columns");
  if (columnsIndex !== -1) {
    columns = Number(rest[columnsIndex + 1]);
    rest.splice(columnsIndex, 2);
    if (!Number.isInteger(columns) || columns < 3) {
      process.stderr.write("--columns needs an integer of 3 or more\n");
      return 2;
    }
  }
  const options: RenderOptions = {
    columns,
    useColor: !noColor && !process.env["NO_COLOR"],
  };

  if (!live) {
    if (rest.length > 0) {
      process.stderr.write(`unknown argument: ${rest[0]}\n${USAGE}`);
      return 2;
    }
    process.stdout.write(renderSamples(options));
    return 0;
  }
  const status = runWorkflowCli(["status", ...rest]);
  const dir = runWorkflowCli(["dir", ...rest]);
  process.stdout.write(
    `${renderBand(status, dir.stdout, options).join("\n")}\n`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));

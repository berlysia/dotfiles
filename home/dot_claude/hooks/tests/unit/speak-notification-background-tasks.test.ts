#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { hasRunningBackgroundTasks } from "../../implementations/speak-notification.ts";

describe("hasRunningBackgroundTasks", () => {
  it("returns false when background_tasks is absent", () => {
    strictEqual(hasRunningBackgroundTasks({}), false);
  });

  it("returns false when background_tasks is empty", () => {
    strictEqual(hasRunningBackgroundTasks({ background_tasks: [] }), false);
  });

  it("returns true when a subagent is still running", () => {
    strictEqual(
      hasRunningBackgroundTasks({
        background_tasks: [
          {
            id: "afb313b18a164a6ee",
            type: "subagent",
            status: "running",
            description: "logic-validator spec round 6",
            agent_type: "logic-validator",
          },
        ],
      }),
      true,
    );
  });

  it("returns false when every background task has finished", () => {
    strictEqual(
      hasRunningBackgroundTasks({
        background_tasks: [
          { id: "a1", type: "subagent", status: "completed" },
          { id: "a2", type: "subagent", status: "failed" },
        ],
      }),
      false,
    );
  });

  it("returns false when background_tasks is not an array", () => {
    strictEqual(
      hasRunningBackgroundTasks({ background_tasks: "running" }),
      false,
    );
  });
});

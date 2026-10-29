import { createRunGit } from "../../lib/run-git.ts";

/**
 * runGit with a 60 s limit instead of the production 5 s, for tests that are
 * not about time. Under the parallel unit run a git call that goes past 5 s
 * is killed and reported as a failure, which would fail the test's setup.
 */
export const patientRunGit = createRunGit(60_000);

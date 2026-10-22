// Child-process fixture for system-notification-launch.test.ts.
// Calls sendSystemNotification and exits immediately, like cc-hooks-ts runHook
// does right after run() returns. Inputs come from env so the test controls them.
import { join } from "node:path";
import { sendSystemNotification } from "../../../lib/unified-audio-engine.ts";
import { createUnifiedVoiceConfig } from "../../../lib/unified-audio-config.ts";

const config = createUnifiedVoiceConfig();
config.system.platform =
  process.env.FIXTURE_PLATFORM === "wsl" ? "wsl" : "linux";
config.behavior.systemNotifications =
  process.env.FIXTURE_SYSTEM_NOTIFICATIONS !== "false";
config.paths.logFile = join(process.env.FIXTURE_DIR ?? ".", "voice.log");

await sendSystemNotification("hello", config);
// Not process.exitCode: letting the event loop drain would also wait for the
// launcher, hiding the bug this fixture reproduces. This file is not a hook;
// it mirrors runHook's own process.exit(0).
// oxlint-disable-next-line custom-lint/no-process-exit
process.exit(0);

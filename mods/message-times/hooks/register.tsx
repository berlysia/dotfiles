import { atom, memberOf, read, update } from "claude-code";
import type {
  EngineInterface,
  Register,
  RenderElement,
  RenderInput,
} from "claude-code";

// A family keyed by the stored row's uuid, so a write redraws that row alone.
const storedAt = atom(
  { plugin: "message-times", key: "storedAt" } as const,
  null,
);

export function formatDateTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  // An offset, not a zone name like JST: a name needs Intl's time zone data,
  // which the mod's runtime is not promised to carry.
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${day} ${time} ${offset}`;
}

async function drawWithTime(
  $: EngineInterface,
  e: RenderInput<"UserMessage" | "AssistantMessage">,
  beneath: RenderElement,
): Promise<RenderElement> {
  const at = await read($, memberOf(storedAt, e));
  // A row stored before the mod loaded (a resumed session's history) has no
  // time here; the transcript file has one, which this mod does not read.
  if (at === null) return beneath;
  const { Box, Text } = $.ui.resolve(e);
  return (
    <Box flexDirection="column">
      {beneath}
      <Text dimColor>{`  ${formatDateTime(at)}`}</Text>
    </Box>
  );
}

export const register: Register = (on) => {
  on("session.append", async ($, e, next) => {
    const result = await next(e);
    if (result.deny !== undefined) return result;
    const { type } = result.message;
    if (type === "user" || type === "assistant") {
      const at = await $.clock.now();
      // A message row's requestId is the uuid its row was stored under.
      await update($, memberOf(storedAt, { requestId: result.uuid }), () => at);
    }
    return result;
  });

  on("ui.render", { component: "UserMessage" }, async ($, e, next) =>
    drawWithTime($, e, await next(e)),
  );
  // Every block of a reply: the blocks either side of a tool call were
  // written at different times.
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) =>
    drawWithTime($, e, await next(e)),
  );
};

import { describe, expect, test } from "claude-code/testing";

// Built from local fields so the expected text holds in any time zone.
const PROMPT_AT = new Date(2026, 9, 21, 9, 5, 7).getTime();
const REPLY_AT = new Date(2026, 9, 22, 14, 30, 45).getTime();

const PROMPT_UUID = "11111111-1111-4111-8111-111111111111";
const REPLY_UUID = "22222222-2222-4222-8222-222222222222";
const NOTICE_UUID = "33333333-3333-4333-8333-333333333333";
const OLD_UUID = "44444444-4444-4444-8444-444444444444";

describe("message-times", () => {
  for (const surface of ["terminal", "desktop"] as const) {
    test(`${surface}: draws each stored row's time under it, and nothing under a row stored before the mod loaded`, async ($, on) => {
      let now = PROMPT_AT;
      on("clock.now", () => ({ value: now }));
      // The engine's own rows: a Text carrying the row's text.
      on("ui.render", ($, e) => {
        const { Text } = $.ui.resolve(e);
        const text =
          e.component === "UserMessage" || e.component === "AssistantMessage"
            ? e.props.text
            : "";
        return Text({ children: text });
      });

      await $.session.append({
        message: {
          type: "user",
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
        door: "prompt",
        origin: { kind: "composer" },
        uuid: PROMPT_UUID,
      });
      now = REPLY_AT;
      await $.session.append({
        message: {
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
        door: "response",
        origin: { kind: "model", model: "claude-opus-5-5" },
        uuid: REPLY_UUID,
      });
      // A notice row is not a message: nothing is kept for it.
      await $.session.append({
        message: {
          type: "system",
          content: [{ type: "text", text: "compacted" }],
        },
        door: "notice",
        origin: { kind: "model", model: "claude-opus-5-5" },
        uuid: NOTICE_UUID,
      });

      const prompt = await $.ui.mount({
        plugin: "message-times",
        surface,
        component: "UserMessage",
        requestId: PROMPT_UUID,
        props: {
          text: "hi",
          origin: { kind: "composer" },
          isExpanded: false,
        },
      });
      expect(await prompt.find({ text: "hi" })).toBeDefined();
      expect(
        await prompt.find({
          type: "Text",
          text: /^  2026-10-21 09:05:07 [+-]\d{2}:\d{2}$/,
        }),
      ).toBeDefined();

      const reply = await $.ui.mount({
        plugin: "message-times",
        surface,
        component: "AssistantMessage",
        requestId: REPLY_UUID,
        props: { text: "hello", isFirstOfReply: true },
      });
      expect(
        await reply.find({
          type: "Text",
          text: /^  2026-10-22 14:30:45 [+-]\d{2}:\d{2}$/,
        }),
      ).toBeDefined();

      // Stored before the mod loaded: the engine's row as it was.
      const old = await $.ui.mount({
        plugin: "message-times",
        surface,
        component: "UserMessage",
        requestId: OLD_UUID,
        props: {
          text: "earlier",
          origin: { kind: "composer" },
          isExpanded: false,
        },
      });
      expect(await old.drawn()).toMatchObject({ type: "Text" });

      await prompt.unmount();
      await reply.unmount();
      await old.unmount();
    });
  }
});

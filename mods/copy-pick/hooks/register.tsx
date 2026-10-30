import { atom, read, update } from "claude-code";
import type {
  EngineInterface,
  Register,
  RenderInput,
  UiPressArgument,
} from "claude-code";
import type { PickItem } from "./extract-items";
import { commandReply, copySelection, readPaneText } from "./pane-text";

type PaneState = {
  items: PickItem[];
  lines: string[];
  copyMessage: string | null;
  copiedText: string | null;
};

const PANE_ID = "copy-pick";
const INITIAL_STATE: PaneState = {
  items: [],
  lines: [],
  copyMessage: null,
  copiedText: null,
};
const pane = atom({ plugin: "copy-pick", key: "pane" } as const, INITIAL_STATE);

async function refresh($: EngineInterface, query: string): Promise<void> {
  const view = await readPaneText(() => $.session.messages(), query);
  await update($, pane, () => ({
    ...INITIAL_STATE,
    items: view.items,
    lines: view.lines,
  }));
  if (view.logClass !== undefined) {
    $.ui.log(view.logClass, { to: "debug" });
  }
}

async function copyItem(
  $: EngineInterface,
  item: PickItem,
  press: UiPressArgument,
): Promise<void> {
  const result = await copySelection(item, press.surface, (args) =>
    $.ui.copy(args),
  );
  await update($, pane, (state) => ({
    ...state,
    copyMessage: result.message,
    copiedText: result.copiedText,
  }));
  if (result.logClass !== undefined) {
    $.ui.log(result.logClass, { to: "debug" });
  }
}

function drawPane(
  $: EngineInterface,
  e: RenderInput<"Pane">,
  state: PaneState,
) {
  const { Box, Button, Text } = $.ui.resolve(e);
  const kindLabel: Record<PickItem["kind"], string> = {
    code: "［コード］",
    inline: "［行内］",
    full: "［全文］",
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      {state.lines.map((line, index) => (
        <Text key={`line-${index}`} dimColor>
          {line}
        </Text>
      ))}
      {state.items.map((item, index) => (
        <Button
          key={`item-${index}`}
          plain
          label={`${kindLabel[item.kind]} ${item.label}`}
          onPress={(press) => copyItem($, item, press)}
        />
      ))}
      {state.copyMessage !== null && <Text>{state.copyMessage}</Text>}
      {state.copiedText !== null && <Text>{state.copiedText}</Text>}
    </Box>
  );
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    // A refused name leaves the command out; the session itself must still start.
    await $.command
      .register({
        name: "copy-pick",
        description:
          "Choose and copy a code block, command, or full response from this session. Reads at most the latest 4096 messages; responses summarized by /compact may not appear.",
      })
      .catch(() =>
        $.ui.log("copy-pick: /copy-pick not registered", { to: "debug" }),
      );
    return started;
  });

  on("command.run", { command: "copy-pick" }, async ($, e) => {
    await $.ui.open({
      id: PANE_ID,
      title: "copy-pick",
      focus: true,
      closeOnEscape: true,
    });
    await refresh($, e.args ?? "");
    return commandReply();
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) =>
    drawPane($, e, await read($, pane)),
  );
};

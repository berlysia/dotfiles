import { atom, read, update } from "claude-code";
import type {
  EngineInterface,
  Register,
  RenderInput,
  UiPressArgument,
} from "claude-code";
import type { PickItem } from "./extract-items";
import {
  clipToCells,
  commandReply,
  copySelection,
  buildPages,
  previewText,
  readPaneText,
} from "./pane-text";

type PaneState = {
  items: PickItem[];
  lines: string[];
  copyMessage: string | null;
  copiedText: string | null;
  copiedIndex: number | null;
  page: number;
};

const PANE_ID = "copy-pick";
const WIDE_MIN_COLUMNS = 100;
const NARROW_PREVIEW_ROWS = 6;
const MIN_PAGE_ROWS = 3;
const INITIAL_STATE: PaneState = {
  items: [],
  lines: [],
  copyMessage: null,
  copiedText: null,
  copiedIndex: null,
  page: 0,
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
  index: number,
  press: UiPressArgument,
): Promise<void> {
  const result = await copySelection(item, press.surface, (args) =>
    $.ui.copy(args),
  );
  await update($, pane, (state) => ({
    ...state,
    copyMessage: result.message,
    copiedText: result.copiedText,
    copiedIndex: result.copiedText === null ? null : index,
  }));
  if (result.logClass !== undefined) {
    $.ui.log(result.logClass, { to: "debug" });
  }
}

async function movePage($: EngineInterface, page: number): Promise<void> {
  await update($, pane, (state) => ({ ...state, page }));
}

function drawPane(
  $: EngineInterface,
  e: RenderInput<"Pane">,
  state: PaneState,
) {
  const { Box, Button, Text } = $.ui.resolve(e);
  const { bodyColumns, scroll } = e.props;
  const isWide = bodyColumns >= WIDE_MIN_COLUMNS;
  // Pages instead of the body's scroll: scrolling would carry the preview away with the rows.
  const reservedRows =
    (isWide ? 0 : NARROW_PREVIEW_ROWS + 1) + state.lines.length + 2;
  const pageSize = Math.max(scroll.bodyRows - reservedRows, MIN_PAGE_ROWS);
  const pages = buildPages(
    state.items.map((item) => item.group),
    pageSize,
  );
  const page = Math.min(state.page, pages.length - 1);
  const range = pages[page] ?? { start: 0, end: 0 };
  const contentCells = bodyColumns - 2;
  const listCells = isWide ? Math.floor(contentCells * 0.6) - 1 : contentCells;
  const kindLabel: Record<PickItem["kind"], string> = {
    code: "［コード］",
    inline: "［行内］",
    full: "［全文］",
  };

  const list = (
    <Box flexDirection="column" width={isWide ? "60%" : "100%"}>
      {/* Above the items: below them, a long list hides the result of the press. */}
      {state.copyMessage !== null && <Text>{state.copyMessage}</Text>}
      {state.lines.map((line, index) => (
        <Text key={`line-${index}`} dimColor>
          {line}
        </Text>
      ))}
      {state.items.slice(range.start, range.end).flatMap((item, offset) => {
        const index = range.start + offset;
        const label = `${state.copiedIndex === index ? "✓" : " "} ${kindLabel[item.kind]} ${item.label}`;
        const button = (
          <Button
            key={`item-${index}`}
            plain
            autoFocus={offset === 0 ? true : undefined}
            label={clipToCells(label, listCells)}
            onPress={(press) => copyItem($, item, index, press)}
          />
        );
        return offset > 0 && state.items[index - 1]?.group !== item.group
          ? [
              <Text key={`separator-${index}`} dimColor>
                {"─".repeat(Math.max(listCells, 1))}
              </Text>,
              button,
            ]
          : [button];
      })}
      {state.items.length > 0 && (
        // Both stay at the ends of the range: a key with no Button goes to the prompt and takes the focus with it.
        <Box flexDirection="row" gap={2}>
          <Text dimColor>{`${page + 1}/${pages.length}`}</Text>
          <Button
            key="page-previous"
            plain
            hotkey="p"
            label="前"
            dimColor={page === 0}
            onPress={() => movePage($, Math.max(page - 1, 0))}
          />
          <Button
            key="page-next"
            plain
            hotkey="n"
            label="次"
            dimColor={page === pages.length - 1}
            onPress={() => movePage($, Math.min(page + 1, pages.length - 1))}
          />
        </Box>
      )}
    </Box>
  );
  const previewRows = isWide
    ? Math.max(pageSize, NARROW_PREVIEW_ROWS)
    : NARROW_PREVIEW_ROWS;
  const preview = (
    // The height is reserved even when empty, so the first press does not move the rows.
    <Box
      flexDirection="column"
      width={isWide ? "40%" : "100%"}
      height={previewRows}
      overflow="hidden"
      paddingLeft={isWide ? 2 : 0}
    >
      {state.copiedText !== null && (
        <Text>{previewText(state.copiedText, previewRows)}</Text>
      )}
    </Box>
  );

  return isWide ? (
    <Box flexDirection="row" paddingX={1}>
      {list}
      {preview}
    </Box>
  ) : (
    <Box flexDirection="column" paddingX={1}>
      {preview}
      <Text dimColor>{"─".repeat(Math.max(bodyColumns - 2, 1))}</Text>
      {list}
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
      rows: 18,
    });
    await refresh($, e.args ?? "");
    return commandReply();
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) =>
    drawPane($, e, await read($, pane)),
  );
};

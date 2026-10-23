#!/usr/bin/env bash
# staged なファイルだけを整形する (pre-commit の 2a から呼ばれる)。
#
# - 全体 stage (index と作業ツリーの中身が同じ): 作業ツリーを整形して git add し直す。
#   両者が一致しているので、stage し直しても他の変更は commit に混ざらない
# - 部分 stage (作業ツリーに未 stage の変更がある): 書き込まず、index の中身を検査するだけ。
#   丸ごと整形して stage し直すと未 stage の hunk まで commit に入り、作業ツリーだけを
#   整形すると index との 3 方向マージが要る。どちらも避け、利用者に直してもらう
#
# oxfmt のフラグはここで再定義せず、package.json の format:files だけを呼ぶ
# (フラグの二重管理で CI の format:check と対象がずれた過去がある)。
# リポジトリ全体のずれは、必須チェックの ci-format.yml が検知する。
#
# Exit codes: 0 成功 / 1 部分 stage の違反・oxfmt の異常終了・git の異常

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cd "$(git rev-parse --show-toplevel)"

TMP_DIR=$(mktemp -d -t format-staged-XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

# rename は移動後のパスが出る。-z は空白や非 ASCII を含むパスを壊さないため
STAGED=()
while IFS= read -r -d '' path; do
    STAGED+=("$path")
done < <(git diff --cached --name-only -z --diff-filter=ACMR)

if [ ${#STAGED[@]} -eq 0 ]; then
    exit 0
fi

# 分類は整形の前に 1 回だけ行う。整形後に再分類すると、整形で生じた差分を
# 「未 stage の変更」と取り違える
FULL=()
PARTIAL=()
for path in "${STAGED[@]}"; do
    rc=0
    git diff --quiet -- "$path" || rc=$?
    case "$rc" in
        0) FULL+=("$path") ;;
        1) PARTIAL+=("$path") ;;
        *)
            echo -e "${RED}❌ git diff failed for: $path${NC}" >&2
            exit 1
            ;;
    esac
done

EXIT_CODE=0

# 全体 stage を先に処理する。部分 stage に違反があっても、ここでの整形と
# stage し直しは残す
if [ ${#FULL[@]} -gt 0 ]; then
    BEFORE=()
    for path in "${FULL[@]}"; do
        BEFORE+=("$(git hash-object -- "$path")")
    done

    # 非対応の形式と .oxfmtignore の除外は、format:files の
    # --no-error-on-unmatched-pattern により rc=0 のまま飛ばされる
    if ! FORMAT_OUTPUT=$(bun run --silent format:files "${FULL[@]}" 2>&1); then
        echo -e "${RED}❌ format failed${NC}"
        echo "$FORMAT_OUTPUT" | tail -20
        EXIT_CODE=1
    else
        RESTAGED=()
        for i in "${!FULL[@]}"; do
            path=${FULL[$i]}
            if [ -f "$path" ] && [ "$(git hash-object -- "$path")" != "${BEFORE[$i]}" ]; then
                git add -- "$path"
                RESTAGED+=("$path")
            fi
        done
        if [ ${#RESTAGED[@]} -gt 0 ]; then
            echo -e "${YELLOW}整形して stage し直したファイル:${NC}"
            printf '    %s\n' "${RESTAGED[@]}"
        fi
    fi
fi

# commit に入るのは index の中身なので、作業ツリーではなく index を検査する
VIOLATIONS=()
for path in "${PARTIAL[@]+"${PARTIAL[@]}"}"; do
    git show ":$path" >"$TMP_DIR/in"
    rc=0
    bun run --silent format:files --stdin-filepath "$path" <"$TMP_DIR/in" >"$TMP_DIR/out" 2>"$TMP_DIR/err" || rc=$?
    if [ "$rc" -eq 0 ]; then
        if ! cmp -s "$TMP_DIR/in" "$TMP_DIR/out"; then
            VIOLATIONS+=("$path")
        fi
    elif [ "$rc" -eq 1 ] && grep -qF 'Unsupported file type' "$TMP_DIR/err"; then
        continue
    else
        # 構文エラー (rc=2) などは整形の要否を判定できない。通さずに止める
        echo -e "${RED}❌ format check failed for staged content: $path${NC}"
        tail -20 "$TMP_DIR/err"
        VIOLATIONS+=("$path")
    fi
done

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
    echo -e "${RED}❌ stage 済みの中身が整形されていません (一部だけ stage したファイル):${NC}"
    printf '    %s\n' "${VIOLATIONS[@]}"
    echo -e "${YELLOW}   作業ツリーで整形し (bun run format:files <path>)、stage し直してから commit してください${NC}"
    EXIT_CODE=1
fi

if [ "$EXIT_CODE" -eq 0 ]; then
    echo -e "${GREEN}✓ Staged files formatted${NC}"
fi

exit "$EXIT_CODE"

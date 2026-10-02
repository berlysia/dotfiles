#!/usr/bin/env bash
# Skill inventory for the Skill(...) auto-approve checklist.
#
# Single owner of: md grammar, source classification, and the allow-name
# computation. Used by the settings generator (`allow`) and by the run_after
# step (`sync-md`). bash + jq only, so it works before bun is installed.
#
#   skill-inventory.sh allow   <common args>   -> JSON array of names on stdout
#   skill-inventory.sh sync-md <common args>   -> append unlisted skills to md
#
# Deliberately avoids grep in extraction paths: grep exits 1 on zero matches,
# which would abort under `set -euo pipefail` on an empty md or lock file.
# Bytewise matching (LC_ALL=C) keeps the name grammar locale-independent.

set -euo pipefail
export LC_ALL=C

shopt -s dotglob nullglob

NAME_RE='^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$'
# 1: checkbox, 2: name, 4: optional "— reason" tail
ENTRY_RE='^- \[([ xX])\] ([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?)(([[:space:]]+—([[:space:]].*)?)?)[[:space:]]*$'
MALFORMED_RE='^[[:space:]]*[-*+]?[[:space:]]*\[[ xX]?\]'
FENCE_OPEN_RE='^ {0,3}(`{3,}|~{3,})'
FENCE_CLOSE_RE='^ {0,3}(`{3,}|~{3,})[[:space:]]*$'
HEADING_RE='^#{1,2}[[:space:]]+(.*)$'
APM_RE='^  - \.claude/skills/(.*)$'
EXTERNAL_RE='^\[".claude/skills/([^/"]*)/'
KEY_RE=$'^["\']?allowed[-_]tools["\']?[[:space:]]*:(.*)$'
LIST_ITEM_RE='^[[:space:]]*-[[:space:]]+(.*)$'
ANNOT_MARK=' — allowed-tools: '

# shellcheck disable=SC2016 # backticks are literal md
MD_HEADER='# Skill auto-approve checklist

`[x]` の行は `Skill(<name>)` として settings.json の permissions.allow に入る（次回の chezmoi apply で反映）。
未チェックにする理由は `— ` の後に書く。自作スキルは md に載る前から許可される。
private-skills 由来はここに載せず、常に許可される。
apply は未掲載のスキルを追記するだけで、行を消さない。'

usage() {
  cat >&2 <<'EOF'
Usage: skill-inventory.sh <allow|sync-md> \
  --md FILE --self-skills-dir DIR --commands-dir DIR --private-dir DIR \
  --apm-lock FILE --chezmoi-external FILE [--installed-skills-dir DIR]
(--installed-skills-dir is required for sync-md)
EOF
}

die() {
  printf 'skill-inventory: error: %s\n' "$1" >&2
  exit 1
}

warn() {
  printf 'skill-inventory: warning: %s\n' "$1" >&2
}

# --- newline-delimited string sets (bash 3.2 compatible: no associative arrays) ---

set_add() {
  local cur="${!1}"
  case $'\n'"$cur" in
    *$'\n'"$2"$'\n'*) return 0 ;;
  esac
  printf -v "$1" '%s%s\n' "$cur" "$2"
}

set_has() {
  case $'\n'"${!1}" in
    *$'\n'"$2"$'\n'*) return 0 ;;
  esac
  return 1
}

sorted_set() {
  local cur="${!1}"
  [[ -n $cur ]] || return 0
  printf '%s' "$cur" | sort
}

valid_name() {
  [[ $1 =~ $NAME_RE ]]
}

# --- argument parsing ---

SUBCMD=""
MD=""
SELF_DIR=""
CMD_DIR=""
PRIVATE_DIR=""
APM_LOCK=""
EXTERNAL_FILE=""
INSTALLED_DIR=""

parse_args() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 2
  fi
  SUBCMD=$1
  shift
  case $SUBCMD in
    allow | sync-md) ;;
    *)
      usage
      exit 2
      ;;
  esac
  while [[ $# -gt 0 ]]; do
    if [[ $# -lt 2 ]]; then
      usage
      exit 2
    fi
    case $1 in
      --md) MD=$2 ;;
      --self-skills-dir) SELF_DIR=$2 ;;
      --commands-dir) CMD_DIR=$2 ;;
      --private-dir) PRIVATE_DIR=$2 ;;
      --apm-lock) APM_LOCK=$2 ;;
      --chezmoi-external) EXTERNAL_FILE=$2 ;;
      --installed-skills-dir) INSTALLED_DIR=$2 ;;
      *)
        usage
        exit 2
        ;;
    esac
    shift 2
  done
  if [[ -z $MD || -z $SELF_DIR || -z $CMD_DIR || -z $PRIVATE_DIR || -z $APM_LOCK || -z $EXTERNAL_FILE ]]; then
    usage
    exit 2
  fi
  if [[ $SUBCMD == sync-md && -z $INSTALLED_DIR ]]; then
    usage
    exit 2
  fi
}

# --- source collection ---

PRIVATE=""
APM=""
CHEZMOI_EXT=""
SELF_RAW=""
SELF=""
EXTERNAL=""

# Absent -> fine (empty). Present but not a readable regular file -> hard error.
require_readable_file_if_present() {
  local path=$1 label=$2
  if [[ -e $path || -L $path ]]; then
    if [[ ! -f $path || ! -r $path ]]; then
      die "$label exists but is not a readable regular file"
    fi
  fi
}

collect_dir_names() { # <dir> <label> <set-var>
  local dir=$1 label=$2 var=$3 p name invalid=0
  [[ -d $dir ]] || return 0
  for p in "$dir"/*; do
    [[ -d $p ]] || continue
    name=${p##*/}
    [[ $name == . || $name == .. || $name == .git ]] && continue
    if valid_name "$name"; then
      set_add "$var" "$name"
    else
      invalid=$((invalid + 1))
    fi
  done
  if ((invalid > 0)); then
    warn "$invalid entries with invalid names ignored in $label"
  fi
}

collect_self_dirs() { # SKILL.md must exist for self-made skills
  local dir=$SELF_DIR p name invalid=0
  [[ -d $dir ]] || return 0
  for p in "$dir"/*; do
    [[ -d $p ]] || continue
    name=${p##*/}
    [[ $name == . || $name == .. || $name == .git ]] && continue
    if valid_name "$name"; then
      [[ -f $p/SKILL.md ]] && set_add SELF_RAW "$name"
    else
      invalid=$((invalid + 1))
    fi
  done
  if ((invalid > 0)); then
    warn "$invalid entries with invalid names ignored in --self-skills-dir"
  fi
}

collect_commands() {
  local dir=$CMD_DIR p name invalid=0
  [[ -d $dir ]] || return 0
  for p in "$dir"/*.md; do
    [[ -f $p ]] || continue
    name=${p##*/}
    name=${name%.md}
    if valid_name "$name"; then
      set_add SELF_RAW "$name"
    else
      invalid=$((invalid + 1))
    fi
  done
  if ((invalid > 0)); then
    warn "$invalid entries with invalid names ignored in --commands-dir"
  fi
}

collect_apm() {
  require_readable_file_if_present "$APM_LOCK" "--apm-lock"
  [[ -f $APM_LOCK ]] || return 0
  local line name invalid=0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ $line =~ $APM_RE ]]; then
      name=${BASH_REMATCH[1]}
      # Deployed sub-paths (e.g. <name>/SKILL.md) are files, not skill names.
      [[ $name == */* ]] && continue
      if valid_name "$name"; then
        set_add APM "$name"
      else
        invalid=$((invalid + 1))
      fi
    fi
  done <"$APM_LOCK"
  if ((invalid > 0)); then
    warn "$invalid entries with invalid names ignored in --apm-lock"
  fi
}

collect_chezmoi_external() {
  require_readable_file_if_present "$EXTERNAL_FILE" "--chezmoi-external"
  [[ -f $EXTERNAL_FILE ]] || return 0
  local line name invalid=0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ $line =~ $EXTERNAL_RE ]]; then
      name=${BASH_REMATCH[1]}
      if valid_name "$name"; then
        set_add CHEZMOI_EXT "$name"
      else
        invalid=$((invalid + 1))
      fi
    fi
  done <"$EXTERNAL_FILE"
  if ((invalid > 0)); then
    warn "$invalid entries with invalid names ignored in --chezmoi-external"
  fi
}

collect_sources() {
  local n
  collect_dir_names "$PRIVATE_DIR" "--private-dir" PRIVATE
  collect_apm
  collect_chezmoi_external
  collect_self_dirs
  collect_commands
  # self-made = skills dir + commands, minus apm and private (those suppliers win).
  while IFS= read -r n; do
    [[ -n $n ]] || continue
    if ! set_has APM "$n" && ! set_has PRIVATE "$n"; then
      set_add SELF "$n"
    fi
  done <<<"$SELF_RAW"
  # external = apm + chezmoi external, minus private.
  while IFS= read -r n; do
    [[ -n $n ]] || continue
    set_has PRIVATE "$n" || set_add EXTERNAL "$n"
  done <<<"$APM"$'\n'"$CHEZMOI_EXT"
}

# --- md parsing ---

LISTED=""
CHECKED=""
CHECKED_TAILS="" # "name<TAB>tail" lines for checked entries
MALFORMED_LINES=""
MD_LINE_COUNT=0
MD_LINES=()
HEADINGS="" # "index<TAB>title" for level 1-2 headings outside fences

parse_md() {
  [[ -e $MD || -L $MD ]] || return 0
  if [[ ! -f $MD || ! -r $MD ]]; then
    die "--md exists but is not a readable regular file"
  fi
  local line lineno=0 in_fence=0 fence_char="" fence_len=0 fence_line=0
  local marker tail title
  while IFS= read -r line || [[ -n $line ]]; do
    MD_LINES[MD_LINE_COUNT]=$line
    MD_LINE_COUNT=$((MD_LINE_COUNT + 1))
    lineno=$((lineno + 1))
    line=${line%$'\r'}
    if ((in_fence)); then
      if [[ $line =~ $FENCE_CLOSE_RE ]]; then
        marker=${BASH_REMATCH[1]}
        if [[ ${marker:0:1} == "$fence_char" ]] && ((${#marker} >= fence_len)); then
          in_fence=0
        fi
      fi
      continue
    fi
    if [[ $line =~ $FENCE_OPEN_RE ]]; then
      marker=${BASH_REMATCH[1]}
      in_fence=1
      fence_char=${marker:0:1}
      fence_len=${#marker}
      fence_line=$lineno
      continue
    fi
    if [[ $line =~ $ENTRY_RE ]]; then
      set_add LISTED "${BASH_REMATCH[2]}"
      if [[ ${BASH_REMATCH[1]} != " " ]]; then
        set_add CHECKED "${BASH_REMATCH[2]}"
        tail=${BASH_REMATCH[4]}
        CHECKED_TAILS+="${BASH_REMATCH[2]}"$'\t'"$tail"$'\n'
      fi
      continue
    fi
    if [[ $line =~ $MALFORMED_RE ]]; then
      MALFORMED_LINES+="$lineno"$'\n'
      continue
    fi
    if [[ $line =~ $HEADING_RE ]]; then
      title=${BASH_REMATCH[1]}
      title=${title%"${title##*[![:space:]]}"}
      HEADINGS+="$((lineno - 1))"$'\t'"$title"$'\n'
    fi
  done <"$MD"
  if ((in_fence)); then
    MALFORMED_LINES+="$fence_line"$'\n'
  fi
}

has_malformed() {
  [[ -n $MALFORMED_LINES ]]
}

report_malformed() {
  local n
  while IFS= read -r n; do
    [[ -n $n ]] || continue
    warn "$MD line $n: malformed checkbox-like line (fix it or remove the checkbox)"
  done < <(printf '%s' "$MALFORMED_LINES" | sort -n | uniq)
}

# --- frontmatter allowed-tools ---

# Strip control characters (including U+2028/U+2029/U+0085), flatten to one
# line, cap at 80 characters. jq handles UTF-8 codepoints correctly.
sanitize_value() {
  printf '%s' "$1" | jq -R -s -r '
    gsub("\\t"; " ")
    | gsub("[\u0001-\u001f\u007f-\u009f  ]"; "")
    | gsub("^ +| +$"; "")
    | .[0:80]
    | gsub(" +$"; "")'
}

trim() {
  local v=$1
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  printf '%s' "$v"
}

# Sets FM_RESULT: "" (no annotation), "unknown", or a sanitized value.
FM_RESULT=""
read_allowed_tools() {
  FM_RESULT=""
  local file=$1 line first=1 closed=0 found=0 list_mode=0 raw="" val item
  [[ -f $file && -r $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if ((first)); then
      first=0
      line=${line#$'\xEF\xBB\xBF'}
      [[ $line == '---' ]] || return 0
      continue
    fi
    if [[ $line == '---' ]]; then
      closed=1
      break
    fi
    if ((found)); then
      if ((list_mode)); then
        if [[ $line =~ $LIST_ITEM_RE ]]; then
          item=$(trim "${BASH_REMATCH[1]}")
          if [[ -n $item ]]; then
            if [[ -n $raw ]]; then raw+=", "; fi
            raw+=$item
          fi
        else
          list_mode=0
        fi
      fi
      continue
    fi
    shopt -s nocasematch
    if [[ $line =~ $KEY_RE ]]; then
      shopt -u nocasematch
      found=1
      val=$(trim "${BASH_REMATCH[1]}")
      if [[ -z $val ]]; then
        list_mode=1
      else
        raw=$val
        case $val in
          '|' | '>' | '|-' | '>-' | '|+' | '>+') raw="" ;;
        esac
      fi
    else
      shopt -u nocasematch
    fi
  done <"$file"
  if ((first)); then
    return 0 # empty file: no frontmatter
  fi
  if ((!closed)); then
    FM_RESULT="unknown"
    return 0
  fi
  if ((!found)); then
    return 0
  fi
  val=$(sanitize_value "$raw")
  if [[ -z $val ]]; then
    FM_RESULT="unknown"
  else
    FM_RESULT=$val
  fi
}

# --- allow ---

cmd_allow() {
  local out="" n
  # 1) checked
  out+=$CHECKED
  # 2) self-made not listed (suspended while any malformed line exists)
  if has_malformed; then
    warn "malformed lines present: auto-allow of unlisted self-made skills is suspended"
  else
    while IFS= read -r n; do
      [[ -n $n ]] || continue
      set_has LISTED "$n" || out+="$n"$'\n'
    done <<<"$SELF"
  fi
  # 3) private
  out+=$PRIVATE
  # Final re-validation: sorted unique JSON array.
  printf '%s' "$out" | jq -R -s -c --arg re "$NAME_RE" '
    split("\n")
    | map(select(length > 0 and test($re)))
    | unique'
}

# --- sync-md ---

annotation_for() { # <name> <kind: self|external> -> sets FM_RESULT
  local name=$1 kind=$2
  FM_RESULT=""
  if [[ $kind == self ]]; then
    if [[ -f $SELF_DIR/$name/SKILL.md ]]; then
      read_allowed_tools "$SELF_DIR/$name/SKILL.md"
    elif [[ -f $CMD_DIR/$name.md ]]; then
      read_allowed_tools "$CMD_DIR/$name.md"
    fi
  else
    read_allowed_tools "$INSTALLED_DIR/$name/SKILL.md"
  fi
}

entry_line() { # <check-char> <name> <kind>
  local line="- [$1] $2"
  annotation_for "$2" "$3"
  if [[ -n $FM_RESULT ]]; then
    line+="$ANNOT_MARK$FM_RESULT"
  fi
  printf '%s' "$line"
}

warn_changed_external_tools() {
  local n tail old
  while IFS= read -r n; do
    [[ -n $n ]] || continue
    set_has CHECKED "$n" || continue
    annotation_for "$n" external
    [[ -n $FM_RESULT ]] || continue
    old=""
    # last checked entry line for this name wins
    while IFS=$'\t' read -r cn tail; do
      [[ $cn == "$n" ]] || continue
      old=""
      if [[ $tail == *"$ANNOT_MARK"* ]]; then
        old=${tail#*"$ANNOT_MARK"}
        old=$(trim "$old")
      fi
    done <<<"$CHECKED_TAILS"
    if [[ $old != "$FM_RESULT" ]]; then
      warn "checked external skill $n: allowed-tools is now \"$FM_RESULT\" (md has \"${old:-none}\")"
    fi
  done <<<"$EXTERNAL"
}

section_bounds() { # <title> -> sets SEC_START (index or -1), SEC_END (exclusive)
  local title=$1 idx t found=-1
  SEC_START=-1
  SEC_END=$MD_LINE_COUNT
  while IFS=$'\t' read -r idx t; do
    [[ -n $idx ]] || continue
    if ((found >= 0)); then
      SEC_END=$idx
      break
    fi
    if [[ $t == "$title" ]]; then
      found=$idx
      SEC_START=$idx
    fi
  done <<<"$HEADINGS"
}

insertion_index() { # uses SEC_START/SEC_END; prints index after last non-blank line
  local i last=$SEC_START l
  for ((i = SEC_START + 1; i < SEC_END; i++)); do
    l=${MD_LINES[i]%$'\r'}
    if [[ -n $(trim "$l") ]]; then
      last=$i
    fi
  done
  printf '%s' "$last"
}

cmd_sync_md() {
  warn_changed_external_tools
  if has_malformed; then
    report_malformed
    return 0
  fi

  local n new_self="" new_ext="" appended="" line
  local self_lines=() ext_lines=()
  local created=0
  while IFS= read -r n; do
    [[ -n $n ]] || continue
    set_has LISTED "$n" && continue
    self_lines+=("$(entry_line x "$n" self)")
    appended+="${appended:+, }$n"
  done < <(sorted_set SELF)
  while IFS= read -r n; do
    [[ -n $n ]] || continue
    set_has LISTED "$n" && continue
    ext_lines+=("$(entry_line ' ' "$n" external)")
    appended+="${appended:+, }$n"
  done < <(sorted_set EXTERNAL)
  new_self=${#self_lines[@]}
  new_ext=${#ext_lines[@]}

  if [[ ! -e $MD && ! -L $MD ]]; then
    created=1
  fi
  if ((new_self == 0 && new_ext == 0 && !created)); then
    return 0
  fi

  local md_dir tmp
  md_dir=$(dirname -- "$MD")
  tmp=$(mktemp "$md_dir/.skill-approvals.XXXXXX") || die "cannot create a temporary file in $md_dir"

  local self_at=-1 ext_at=-1 self_head=0 ext_head=0 i
  local self_missing=0 ext_missing=0
  if ((created)); then
    MD_LINES=()
    MD_LINE_COUNT=0
    self_missing=1
    ext_missing=1
  else
    section_bounds "Self-made"
    if ((SEC_START >= 0)); then
      if ((new_self > 0)); then
        self_at=$(insertion_index)
        ((self_at == SEC_START)) && self_head=1
      fi
    elif ((new_self > 0)); then
      self_missing=1
    fi
    section_bounds "External"
    if ((SEC_START >= 0)); then
      if ((new_ext > 0)); then
        ext_at=$(insertion_index)
        ((ext_at == SEC_START)) && ext_head=1
      fi
    elif ((new_ext > 0)); then
      ext_missing=1
    fi
  fi

  {
    local last_blank=1 emitted=0 l
    if ((created)); then
      printf '%s\n' "$MD_HEADER"
      emitted=1
      last_blank=0
    fi
    for ((i = 0; i < MD_LINE_COUNT; i++)); do
      printf '%s\n' "${MD_LINES[i]}"
      emitted=1
      l=${MD_LINES[i]%$'\r'}
      if [[ -n $(trim "$l") ]]; then last_blank=0; else last_blank=1; fi
      if ((i == self_at)); then
        ((self_head)) && printf '\n'
        for l in "${self_lines[@]}"; do printf '%s\n' "$l"; done
        last_blank=0
      fi
      if ((i == ext_at)); then
        ((ext_head)) && printf '\n'
        for l in "${ext_lines[@]}"; do printf '%s\n' "$l"; done
        last_blank=0
      fi
    done
    if ((self_missing)); then
      if ((emitted && !last_blank)); then printf '\n'; fi
      printf '## Self-made\n\n'
      for l in ${self_lines[@]+"${self_lines[@]}"}; do printf '%s\n' "$l"; done
      emitted=1
      last_blank=0
      if ((new_self == 0)); then last_blank=1; fi
    fi
    if ((ext_missing)); then
      if ((emitted && !last_blank)); then printf '\n'; fi
      printf '## External\n\n'
      for l in ${ext_lines[@]+"${ext_lines[@]}"}; do printf '%s\n' "$l"; done
    fi
  } >"$tmp" || {
    rm -f -- "$tmp"
    die "failed to write $tmp"
  }

  chmod "$(printf '%o' $((0666 & ~$(umask))))" "$tmp" || true
  if ! mv -f -- "$tmp" "$MD"; then
    rm -f -- "$tmp"
    die "failed to replace $MD"
  fi

  local count=$((new_self + new_ext))
  if ((count > 0)); then
    printf 'skill-approvals.md に %d 件を追記した: %s。外部スキルのチェックは次回の chezmoi apply で settings.json に反映される\n' "$count" "$appended"
  fi
}

main() {
  parse_args "$@"
  collect_sources
  parse_md
  if [[ $SUBCMD == allow ]]; then
    report_malformed
    cmd_allow
  else
    cmd_sync_md
  fi
}

main "$@"

#!/usr/bin/env python3
"""抜き書き（extracts.json）を、原文どおりか確かめてから読むためのページ（report.html）にする。

原文を40本落としても、英語の PDF や1時間の字幕のままでは読まれずに終わる。
かといってエージェントが要約すると「早すぎる閉じ」に戻る。間を取るのが Ellis の
extracting＝抜き書き。論点ごとに原文をそのまま切り出して並べ、エージェントが書くのは
見出し・「見つからなかった」・英語の訳だけにする。

言い換えが紛れ込まないよう、抜き書きの文が原文の指定の行にそのまま在るかを機械で確かめる。
1つでも見つからなければ HTML は作らず、どれが合わないかを出して止まる。

使い方:
    report.py <topic_dir>         … <topic_dir>/extracts.json → <topic_dir>/report.html
    report.py <topic_dir> --check … 照合だけして HTML は作らない

extracts.json の形（例はリポジトリの examples/demo/extracts.json）:
    {"title", "question", "stopped",
     "claims": [{"claim", "status": "根拠あり|一部のみ|根拠なし", "note"?,
                 "quotes": [{"file", "line", "end"?, "text", "ja"?, "mark"?, "context_note"?}]}],
     "disagreements"?: [{"topic", "quotes": [{..., "who"}]}],
     "unreached"?: ["..."]}
"""

import html
import json
import os
import re
import sys
import tempfile
from pathlib import Path, PureWindowsPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import skin  # noqa: E402  見た目（コルク板と象牙の紙）と色は skin.py・palette.py の1か所に置く

# 2026-10-21 まで使っていた状態の言葉。前に書いた extracts.json も読めるよう、新しい言葉に読み替える
OLD_STATUS = {"付いた": "根拠あり", "一部だけ": "一部のみ", "付かなかった": "根拠なし"}

# 前後に見せる行数。抜き書きがどんな流れの中にあったかを、ページの中で開いて確かめられるように。
CONTEXT_LINES = 6


def norm(s: str) -> str:
    """照合用に空白・改行・箇条書きの印をそろえる。文字そのものは変えない。"""
    s = re.sub(r"(?m)^\s*[-*]\s+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def verify(src_dir: Path, q: dict) -> tuple[bool, list[str], int, int]:
    """抜き書きが原文の指定の行（前後2行の余裕つき）にそのまま在るか。前後の文脈も返す。"""
    relative = Path(q["file"])
    if relative.is_absolute() or PureWindowsPath(q["file"]).is_absolute() or ".." in relative.parts:
        return False, [], 0, 0
    try:
        root = src_dir.resolve()
        topic = src_dir.parent.resolve()
        path = (src_dir / relative).resolve()
    except (OSError, RuntimeError, ValueError):
        return False, [], 0, 0
    if root == topic or not root.is_relative_to(topic):
        return False, [], 0, 0
    if not path.is_relative_to(root) or not path.is_file():
        return False, [], 0, 0
    # splitlines() はページ区切り（\f）も改行に数え、grep・sed と行番号がずれる。改行だけで数える
    lines = path.read_text(encoding="utf-8", errors="replace").split("\n")
    # 0 や負の行・end が line より前の指定は、前後2行の余裕で原文の頭に寄せると通ってしまい、
    # 指していない行を「照合済み」と見せる（2026-10-20 のレビュー）。原文の中の行だけを受け付ける
    # end が無いか null なら1行だけ（null は前から通っていたので受け付け続ける）
    first = q["line"]
    last = first if q.get("end") is None else q["end"]
    if not all(type(n) is int for n in (first, last)) or not 1 <= first <= last <= len(lines):
        return False, [], 0, 0
    start = max(1, first - 2)
    end = min(len(lines), last + 2)
    # ここから先は、検査を通った first・last だけを使う
    region = norm(" ".join(lines[start - 1:end]))
    # 2段組の PDF は左右の段が1行に混ざり、何行かにまたがる文はそのままでは照合できない
    # （Yoshida 2008 で起きた）。抜き書きを「…」で区切れば、区切りごとに順に照らす。
    # 区切りはページにも「…」として残るので、省いたことが読む人に見える。
    pieces = [norm(p) for p in q["text"].split("…") if norm(p)]
    ok, pos = bool(pieces), 0
    for piece in pieces:
        at = region.find(piece, pos)
        if at < 0:
            ok = False
            break
        pos = at + len(piece)
    c0 = max(1, q["line"] - CONTEXT_LINES)
    c1 = min(len(lines), last + CONTEXT_LINES)
    return ok, lines[c0 - 1:c1], c0, c1


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def quote_html(src_dir: Path, q: dict, ctx: list[str], c0: int) -> str:
    loc = f"{q['file']}:{q['line']}" + (f"-{q['end']}" if q.get("end") else "")
    hit = range(q["line"], (q.get("end") or q["line"]) + 1)
    # markdown の空行で間延びするので、空の行は飛ばす（行番号はそのまま残るので位置は追える）
    # span は display:block なので区切りの改行は入れない（入れると行間が二重になった）
    ctx_html = "".join(
        f'<span class="{"hit" if c0 + i in hit else ""}"><b>{c0 + i}</b> {esc(t)}</span>'
        for i, t in enumerate(ctx) if t.strip())
    parts = ['<figure class="quote">']
    if q.get("who"):
        parts.append(f'<div class="who">{esc(q["who"])}</div>')
    parts.append(f'<blockquote{skin.lang_attr(q["text"])}>{esc(q["text"])}</blockquote>')
    if q.get("ja"):
        parts.append(f'<p class="ja"><span class="tag">訳</span>{esc(q["ja"])}</p>')
    meta = [f'<code>{esc(loc)}</code>']
    if q.get("mark"):
        meta.append(f'<span class="mark">{esc(q["mark"])}</span>')
    if q.get("context_note"):
        meta.append(f'<span class="cn">{esc(q["context_note"])}</span>')
    parts.append(f'<figcaption>{" ".join(meta)}</figcaption>')
    parts.append(f'<details><summary>前後を読む（{c0}〜{c0 + len(ctx) - 1}行）</summary><pre{skin.lang_attr(" ".join(ctx))}>{ctx_html}</pre></details>')
    parts.append("</figure>")
    return "\n".join(parts)


# 地と紙と書体は skin.CSS。ここは抜き書きに固有の部品だけ。論点ごとに1枚の紙（.sheet）に載せる
CSS = skin.CSS + """
h1{font-size:1.6rem;margin:0 0 .5rem}
h2{font-size:1.2rem;margin:0 0 .4rem}
.lead{color:var(--sub);margin:.2rem 0}
.status{display:inline-block;font-size:.8rem;padding:.05rem .55rem;border-radius:99px;border:1px solid var(--accent);color:var(--accent);margin-left:.5rem;vertical-align:middle}
.status.none{border-style:dashed;color:var(--sub);border-color:var(--sub)}
.note{color:var(--sub);font-size:.95rem}
.quote{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem 1.1rem;margin:1rem 0}
blockquote{margin:0;padding-left:.9rem;border-left:3px solid var(--accent);white-space:pre-wrap}
.who{font-weight:600;margin-bottom:.4rem}
.ja{margin:.6rem 0 0;color:var(--sub)}
.tag{font-size:.75rem;border:1px solid var(--sub);border-radius:4px;padding:0 .3rem;margin-right:.4rem}
figcaption{margin-top:.6rem;font-size:.8rem;color:var(--sub);display:flex;flex-wrap:wrap;gap:.5rem}
code{font-family:ui-monospace,"Cascadia Code",monospace;font-size:.78rem}
.mark{color:var(--accent)}
details{margin-top:.5rem;font-size:.8rem}
summary{cursor:pointer;color:var(--sub)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.78rem;line-height:1.6;max-height:22rem;overflow:auto;margin:.4rem 0 0}
pre span{display:block}
pre span.hit{background:var(--hit)}
pre b{display:inline-block;min-width:3em;color:var(--sub);font-weight:400}
ul.unreached li{margin:.2rem 0}
footer{margin-top:2rem;font-size:.8rem}
"""


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    topic = Path(sys.argv[1]).expanduser()
    check_only = "--check" in sys.argv
    data = json.loads((topic / "extracts.json").read_text(encoding="utf-8"))
    src = topic / "sources"

    bad, rendered = [], {}
    groups = [("claims", c) for c in data["claims"]] + [("dis", d) for d in data.get("disagreements", [])]
    for _, g in groups:
        for q in g.get("quotes", []):
            ok, ctx, c0, _ = verify(src, q)
            if not ok:
                bad.append(f"{q['file']}:{q['line']}  「{q['text'][:40]}…」")
            rendered[id(q)] = (ctx, c0)
    if bad:
        print("原文に見つからない抜き書きがある（言い換えか、行番号のずれ）:")
        print("\n".join("  " + b for b in bad))
        return 1
    total = sum(len(g.get("quotes", [])) for _, g in groups)
    print(f"照合 OK: 抜き書き {total} 件がすべて原文のとおり")
    if check_only:
        return 0

    # 冒頭と、論点ごとに1枚ずつの紙にする
    body = ['<section class="sheet">', f"<h1>{esc(data['title'])}</h1>",
            f'<p class="lead">調べたこと: {esc(data["question"])}</p>',
            f'<p class="lead">調査を区切った理由: {esc(data["stopped"])}</p>',
            "</section>"]
    for c in data["claims"]:
        status = OLD_STATUS.get(c["status"], c["status"])
        cls = "status none" if status == "根拠なし" else "status"
        body.append(f'<section class="sheet"><h2>{esc(c["claim"])}<span class="{cls}">{esc(status)}</span></h2>')
        if c.get("note"):
            body.append(f'<p class="note">{esc(c["note"])}</p>')
        for q in c.get("quotes", []):
            ctx, c0 = rendered[id(q)]
            body.append(quote_html(src, q, ctx, c0))
        body.append("</section>")
    for d in data.get("disagreements", []):
        body.append(f'<section class="sheet"><h2>食い違い: {esc(d["topic"])}</h2>')
        for q in d.get("quotes", []):
            ctx, c0 = rendered[id(q)]
            body.append(quote_html(src, q, ctx, c0))
        body.append("</section>")
    if data.get("unreached"):
        body.append('<section class="sheet"><h2>届かなかったもの</h2><ul class="unreached">'
                    + "".join(f"<li>{esc(u)}</li>" for u in data["unreached"]) + "</ul></section>")
    # 絶対パスはページを人に渡すと手元のユーザー名を漏らすので、ページからの相対で書く
    body.append(f'<footer>imozuru の抜き書き・原文はこのページと同じ場所の {esc(src.name)}/</footer>')

    page = skin.page(f"{data['title']} 抜き書き", "\n".join(body), extra_head=f"<style>{CSS}</style>")
    out = topic / "report.html"
    # 同じ場所に排他的に作り、仕込まれたリンクを踏まず、途中で止まっても前のページを残す
    fd, tmp = tempfile.mkstemp(prefix=".report.html.", suffix=".tmp", dir=out.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(page)
        os.replace(tmp, out)
    finally:
        Path(tmp).unlink(missing_ok=True)
    print(f"→ {out}")
    return 0


if __name__ == "__main__":
    # 抜き書きの頭を出すので、端末の文字コードに無い字（cp932 の à など）で落ちないようにする
    sys.stdout.reconfigure(errors="replace")
    sys.exit(main())

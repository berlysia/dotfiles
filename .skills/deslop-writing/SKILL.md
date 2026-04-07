---
name: deslop-writing
description: "AI生成テキスト（slop）のパターンを検出・改善するスキル。「AI臭を消して」「AI的な表現を直して」「この文章をスキャンして」等で起動する。detect モードではフラグのみ、rewrite モード（デフォルト）ではリライトまで行う。"
---

# deslop-writing — AI文体検出・改善

AI生成テキストのパターン（AI-isms / slop）を検出し、人間が書いたように読める文章に改善する。

## モード

**rewrite**（デフォルト） — パターンを検出し、リライトして修正する。

**detect** — パターンを検出するのみ。リライトしない。以下の場合に使う:
- 書き手自身が何を直すか判断したい
- フラグされたパターンが意図的かもしれない
- 公開済み・他人の文章を変更したくない

「detect」「フラグだけ」「スキャン」「チェックだけ」等の指示で detect モードに切り替える。

---

## 核心原理

**1. 構造的均一性が最大のAIシグナル。** AI検出ツール（Pangram Labs等）は語彙より構造の均一性を重視する。文長が揃い、段落サイズが均一で、展開が対称的な文章は、個別の語彙を直しても AI 的に読める。

**2. AI的パターンの本質は3つ。**
- **均一性**: 文長・段落長・展開パターンの機械的な揃い
- **回避行動**: "is/has" の回避（copula avoidance）、同一語の反復回避（synonym cycling）、断定の回避（hedging）
- **空虚な修飾**: 具体性のない形容詞・副詞・帰属の積み上げ

**3. 過度な修正はかえってAI的になる。** 全ての不規則性を削ると、AI的な均一性そのものを生む。自然な揺れ・癖・リズムの変化を残す。このスキルは文章をより人間的にするもので、全ルールを最大厳格度で適用するものではない。

---

## 重要度階層

### P0 — 信頼性破壊（即時修正）
- Cutoff disclaimers（「最新情報では」「私の知識の範囲では」）
- Chatbot artifacts（「お役に立てれば幸いです！」「素晴らしい質問ですね！」）
- Vague attributions（「専門家によると」「研究によれば」— 出典なし）
- Significance inflation（日常的な出来事への歴史的重要性の付与）

### P1 — 明白なAI臭（公開前に修正）
- Tier 1 語彙違反（delve, leverage, robust 等）
- Template phrases（スロットフィル構文）
- "Let's" 導入（偽の協調的オープナー）
- Synonym cycling（同一段落内での同義語循環）
- 定型的な書き出し（「急速に変化する〜の世界で」）
- Bold overuse / em dash 過多（1,000語あたり1つまで）

### P2 — スタイル改善（時間があれば）
- Generic conclusions（「未来は明るい」）
- Rule of three の強迫（3つ組の過剰使用）
- 段落長の均一性
- Copula avoidance（serves as, features, boasts）
- Transition filler（Moreover, Furthermore, Additionally）

クイックパスでは P0+P1 のみ。フル監査では全階層。

---

## パターンカテゴリ

### Structure Patterns（構造）

**Formatting** — emダッシュ（— と --）はコンマ・ピリオド・括弧に置換。目標ゼロ、上限1/1,000語。太字は各主要セクション1箇所以下。見出しの絵文字は削除。箇条書きは本当にリスト的な内容のみ。
> なぜAI的か: AIはemダッシュを人間の3-5倍使い、太字で「構造感」を出す。

**Sentence structure** — "It's not X — it's Y" は直接的な肯定文に。hollow intensifier（genuine, truly, quite frankly）は削除。"worth [verb]ing" は理由を具体化。hedging（perhaps, could potentially）は断定に。rule of three は変化させる。
> なぜAI的か: AIは対比構文と修飾語で「洞察感」を演出するが、内容が空虚。

**Structural issues** — 段落長を意図的に変化させる。1-2文の段落と長い段落を混ぜる。書き出しが広い文脈から入る場合はニュース・洞察から入るよう書き換える。意図的な断片文や "And/But" 始まりの文は残す。
> なぜAI的か: 均一な段落は最も強いAIシグナル。

**Transition phrases** — "Moreover/Furthermore/Additionally" → "and/also" か構造で接続を示す。"In today's [X]" → 削除か具体的文脈。"In conclusion/To summarize" → 結論は自明にする。"When it comes to" → 直接話す。"That said" → "but/yet" か削除。
> なぜAI的か: AIは接続詞を安全な繋ぎとして過剰使用する。

**Inline-header lists** — `**Performance:** Performance improved by...` のように太字ヘッダーが内容を重複するリストは、ヘッダーを削って直接書く。
> なぜAI的か: AIのデフォルト構造化パターン。

**Title case headings** — 小見出しは sentence case。Title Case は記事の主タイトルのみ。
> なぜAI的か: AIは全見出しを Title Case にするデフォルト動作を持つ。

**Numbered list inflation** — 「3つの重要なポイント」「知っておくべき7つのこと」— 数に合わせて水増しされたリストは、本当に必要な2-3項目に絞る。
> なぜAI的か: 番号付きリストは構造的に安全なためAIがデフォルトで選ぶ。

**False concession** — "While X is impressive, Y remains a challenge" — 両辺が曖昧。具体的にするか、一方の立場を取って論じる。
> なぜAI的か: AIは「バランスの取れた」見解を生成するが、実際には何も判断していない。

**Rhetorical question openers** — "But what does this mean for developers?" — 答えを知っているなら直接言う。修辞的疑問は強い前振りで獲得するもの。
> なぜAI的か: AIはセクション遷移として修辞的疑問をデフォルトで使う。

### Communication Patterns（コミュニケーション）

**Chatbot artifacts** — "I hope this helps!" / "Certainly!" / "Feel free to reach out" / "Let's dive in!" — チャットインターフェースの癖。全削除。
> なぜAI的か: チャットUIのインタラクションパターンが文章に漏出。

**"Let's" constructions** — "Let's explore" / "Let's take a look" / "Let's break this down" — 偽の協調的導入。直接本題に入る。
> なぜAI的か: AIは話題への導入を和らげるために "let's" を使うが、実際には書き手と読者の協調ではない。

**Cutoff disclaimers** — "While specific details are limited..." / "As of my last update..." — モデル制限の漏出。情報を見つけるか、ヘッジを削除。
> なぜAI的か: 学習データの制限が文章に直接漏出する最も明白なAI痕跡。

**Generic conclusions** — "The future looks bright" / "Only time will tell" / "One thing is certain" — 議論に具体的な結びがないときのフィラー。具体的な結論か削除。
> なぜAI的か: AIは安全で中立的な結論をデフォルトで生成する。

**Emotional flatline** — "What surprised me most" / "I was fascinated to discover" — 感情を宣言するが文章で感じさせない。感情を主張するなら文章で裏付ける。そうでなければ削除。
> なぜAI的か: AIは感情を「構造的接続詞」として使う。tell-don't-show の典型。

**Reasoning chain artifacts** — "Let me think step by step" / "Breaking this down" / "Step 1:" — 思考過程のスキャフォールディングが公開文に漏出。結論→根拠の順に。
> なぜAI的か: chain-of-thought推論の内部過程が出力に漏出。

**Sycophantic tone** — "Great question!" / "Excellent point!" / "That's a really insightful observation" — 読者を検証する会話的報酬。全削除。
> なぜAI的か: RLHFによるhelpfulness最適化の副産物。

**Acknowledgment loops** — "You're asking about..." / "To answer your question..." — プロンプトの復唱。直接回答する。
> なぜAI的か: AIはプロンプトを再述することで「理解」を示そうとする。

**Confidence calibration** — "It's worth noting that" / "Interestingly" / "Surprisingly" / "Notably" — 読者が事実をどう感じるべきか先に指示する。事実に語らせる。密度で判定（2,000語に1つは許容、500語に3つはAI的）。
> なぜAI的か: AIは重要度を読者に代わって判断し、メタ的に予告する。

### Content Patterns（内容）

**Significance inflation** — "marking a pivotal moment in the evolution of..." — 日常的な出来事に歴史的重要性を付与。何が起きたかを述べ、重要性は読者に委ねる。
> なぜAI的か: AIはあらゆる出来事を「重要」と修飾するデフォルト動作を持つ。

**Notability name-dropping** — "cited in NYT, BBC, and Wired" — 威信ある出典の羅列。1つの具体的な参照（「2024年のNYTインタビューで彼女は〜と主張した」）が4つの列挙に勝る。
> なぜAI的か: AIは権威の量で信頼性を構築しようとする。

**Superficial -ing analyses** — "symbolizing... reflecting... showcasing..." — 現在分詞の連鎖による擬似分析。具体的事実に置換するか削除。
> なぜAI的か: -ing 形は具体的主張を避けつつ「分析している」印象を与える安全な構文。

**Promotional language** — "nestled within the breathtaking..." / "a vibrant hub of innovation" — 観光パンフレット風の散文。平易な記述に（「Gonder地方の町である」）。
> なぜAI的か: AIは肯定的・宣伝的な語調をデフォルトで選ぶ。

**Vague attributions** — "Experts believe" / "Studies show" / "Research suggests" — 出典なし。具体的出典を挙げるか、帰属なしで主張を述べる。
> なぜAI的か: AIは架空の権威を裏付けに使う。

**Formulaic challenges** — "Despite challenges, [subject] continues to thrive" — 課題も対応も具体的でない非主張。具体化するか削除。
> なぜAI的か: AIは「困難を乗り越える」ナラティブをテンプレートとして持つ。

**Novelty inflation** — "He introduced a term I hadn't heard before" — 既存の概念を発見・発明として扱う。その人がその概念を「どう使ったか」を述べる。
> なぜAI的か: AIは馴染みのない用語を「新規」と判断するデフォルト動作を持つ。

### Language Patterns（語彙・言語）

**Copula avoidance** — "serves as" / "features" / "boasts" / "presents" / "represents" — "is" / "has" で十分な場面でのプレスリリース風動詞。デフォルトは "is/has"。
> なぜAI的か: AIはbe動詞を「退屈」と判断し、より「洗練された」動詞に置換する。

**Synonym cycling** — 同一段落内で "developers... engineers... practitioners... builders" と同義語を循環。人間は最も明確な語を繰り返す。
> なぜAI的か: AIは同一語の反復を避けるよう最適化されている。

**Template phrases** — "a [adj] step towards [adj] infrastructure" / "Whether you're [X] or [Y]" — スロットフィル構文。具体的な成果・対象を記述する。
> なぜAI的か: テンプレートの穴に任意の語を入れても意味が変わらない文は生成的。

**Filler phrases** — "It is important to note that" / "In terms of" / "The reality is that" — 機械的パディング。削除して直接述べる。
> なぜAI的か: AIは語数を埋めるために意味のないフレーズを挿入する。

**False ranges** — "from the Big Bang to dark matter" — 無関係な極端値の並置。実際のトピックを列挙する。
> なぜAI的か: AIは「幅広さ」を演出するために無関係なペアを生成する。

**Parenthetical hedging** — "(and, increasingly, Z)" / "(or, more precisely, Y)" — 括弧内で「ニュアンスの追加」を装う。重要なら独立文に。不要なら削除。
> なぜAI的か: AIは括弧を使って「洗練された追記」を演出する。

### Meta Patterns（メタ）

**Excessive structure** — 300語未満で見出し3+はAI的。箇条書き8+項目/200語未満は段落にすべき。"Overview" / "Key Points" / "Summary" はAIのデフォルト見出し。
> なぜAI的か: AIは「整理されている」印象のために構造を過剰に挿入する。

**Rhythm and uniformity** — 文長15-25語で揃う場合はロボット的。短い文（3-8語）と長い文（20+）を混ぜる。段落サイズも変化させる。音読テストで均一に聞こえたらAI的。
> なぜAI的か: **構造検出の最重要シグナル。** AI検出ツールが最も重視する。

**Over-polishing** — 全ての不規則性を削り取った均一な散文。自然な癖、特異な語彙選択、不均一なペーシングこそが人間的。
> なぜAI的か: 完全に滑らかな散文は統計的にAIプロファイルに一致する。

**Rewrite-vs-patch threshold** — 語彙フラグ5+（複数カテゴリ）+ パターンカテゴリ3+種 + 文長/段落長の均一性 → パッチではなく全面リライトを推奨。核心を1文で述べ、そこから再構築。

---

## 語彙テーブル（英語）

語は3段階に分類。brandonwise/humanizer の語彙研究に基づく。

### Tier 1 — 常時フラグ（60語）

AI文書で人間の5-20倍出現する。見つけ次第置換。

| Replace | With |
|---|---|
| delve / delve into | explore, dig into, look at |
| landscape (metaphor) | field, space, industry, world |
| tapestry | (describe the actual complexity) |
| realm | area, field, domain |
| paradigm | model, approach, framework |
| embark | start, begin |
| beacon | (rewrite entirely) |
| testament to | shows, proves, demonstrates |
| robust | strong, reliable, solid |
| comprehensive | thorough, complete, full |
| cutting-edge | latest, newest, advanced |
| leverage (verb) | use |
| pivotal | important, key, critical |
| underscores | highlights, shows |
| meticulous / meticulously | careful, detailed, precise |
| seamless / seamlessly | smooth, easy, without friction |
| game-changer / game-changing | (describe what changed and why) |
| hit differently / hits different | (say what specifically changed, or cut) |
| utilize | use |
| watershed moment | turning point, shift (or describe what changed) |
| marking a pivotal moment | (state what happened) |
| the future looks bright | (cut or say something specific) |
| only time will tell | (cut or say something specific) |
| nestled | is located, sits, is in |
| vibrant | (describe what makes it active, or cut) |
| thriving | growing, active (or cite a number) |
| despite challenges... continues to thrive | (name the challenge and the response, or cut) |
| showcasing | showing, demonstrating (or cut) |
| deep dive / dive into | look at, examine, explore |
| unpack / unpacking | explain, break down, walk through |
| bustling | busy, active (or cite what makes it busy) |
| intricate / intricacies | complex, detailed (or name the specific complexity) |
| complexities | (name the actual complexities, or "problems" / "details") |
| ever-evolving | changing, growing (or describe how) |
| enduring | lasting, long-running (or cite how long) |
| daunting | hard, difficult, challenging |
| holistic / holistically | complete, full, whole (or describe what's included) |
| actionable | practical, useful, concrete |
| impactful | effective, significant (or describe the impact) |
| learnings | lessons, findings, takeaways |
| thought leader / thought leadership | expert, authority (or describe their actual contribution) |
| best practices | what works, proven methods, standard approach |
| at its core | (cut and just state the thing) |
| synergy / synergies | (describe the actual combined effect) |
| interplay | relationship, connection, interaction |
| in order to | to |
| due to the fact that | because |
| serves as | is |
| features (verb) | has, includes |
| boasts | has |
| presents (inflated) | is, shows, gives |
| commence | start, begin |
| ascertain | find out, determine, learn |
| endeavor | effort, attempt, try |
| keen (as intensifier) | interested, eager (or cut) |
| symphony (metaphor) | (describe the actual coordination) |
| embrace (metaphor) | adopt, accept, use, switch to |

### Tier 2 — 同一段落に2+で集団フラグ（38語）

単体では正当。同一段落に2つ以上で段落リライトを検討。

| Replace | With |
|---|---|
| harness | use, take advantage of |
| navigate / navigating | work through, handle, deal with |
| foster | encourage, support, build |
| elevate | improve, raise, strengthen |
| unleash | release, enable, unlock |
| streamline | simplify, speed up |
| empower | enable, let, allow |
| bolster | support, strengthen, back up |
| spearhead | lead, drive, run |
| resonate / resonates with | connect with, appeal to, matter to |
| revolutionize | change, transform, reshape (or describe what changed) |
| facilitate / facilitates | enable, help, allow, run |
| underpin | support, form the basis of |
| nuanced | specific, subtle, detailed (or name the nuance) |
| crucial | important, key, necessary |
| multifaceted | (describe the actual facets, or cut) |
| ecosystem (metaphor) | system, community, network, market |
| myriad | many, numerous (or give a number) |
| plethora | many, a lot of (or give a number) |
| encompass | include, cover, span |
| catalyze | start, trigger, accelerate |
| reimagine | rethink, redesign, rebuild |
| galvanize | motivate, rally, push |
| augment | add to, expand, supplement |
| cultivate | build, develop, grow |
| illuminate | clarify, explain, show |
| elucidate | explain, clarify, spell out |
| juxtapose | compare, contrast, set side by side |
| paradigm-shifting | (describe what actually shifted) |
| transformative / transformation | (describe what changed and how) |
| cornerstone | foundation, basis, key part |
| paramount | most important, top priority |
| poised (to) | ready, set, about to |
| burgeoning | growing, emerging (or cite a number) |
| nascent | new, early-stage, emerging |
| quintessential | typical, classic, defining |
| overarching | main, central, broad |
| underpinning / underpinnings | basis, foundation, what supports |

### Tier 3 — 高密度でのみフラグ（11語）

通常の語。テキスト内で総語数の約3%以上を占める場合にフラグ。具体性（数値・比較・事例）への置換を促す。

| Word | Action |
|---|---|
| significant / significantly | 数値・比較・事例で具体化 |
| innovative / innovation | 何が実際に新しいかを記述 |
| effective / effectively | how か metric を示す |
| dynamic / dynamics | 実際の力・変化を名指し |
| scalable / scalability | 何がどこまでスケールするかを記述 |
| compelling | なぜ惹きつけるかを述べる |
| unprecedented | 破られた前例を名指し（または削除） |
| exceptional / exceptionally | 例外たる根拠を引用 |
| remarkable / remarkably | 何が注目に値するかを述べる |
| sophisticated | 洗練の具体内容を記述 |
| instrumental | 果たした役割を述べる |
| world-class / state-of-the-art / best-in-class | ベンチマーク・比較を引用 |

---

## 日本語パターン（観察ベース、拡張前提）

英語パターンほどの大規模研究に裏付けられていない。実使用を通じて追加・調整する。

| # | パターン | 例 | 修正方針 | なぜAI的か |
|---|---------|---|---------|-----------|
| 1 | 断定回避の過剰ヘッジ | 「〜と言えるでしょう」「〜かもしれません」「〜の可能性があります」 | 根拠があれば断定する | AIはRLHFで誤り回避を最適化し、過度にヘッジする |
| 2 | 空虚な重要性主張 | 「〜が重要です」「〜が不可欠です」「〜が鍵となります」 | なぜ重要かを具体的に述べる | 英語の significance inflation と同根。修飾で「分析感」を演出 |
| 3 | 網羅性の偽装 | 「様々な」「多岐にわたる」「幅広い」 | 具体的に列挙する | 具体性を持たない包括表現でカバレッジを装う |
| 4 | 接続詞の機械的反復 | 「また」「さらに」「加えて」の連続 | 文構造で繋がりを示す | 英語の transition filler と同根。安全な繋ぎの過剰使用 |
| 5 | 文末パターンの完全均一性 | です/ます調のみで全文統一 | 体言止め、疑問文、引用、会話体等を混ぜる | 英語の rhythm uniformity と同根。均一性は最大のAIシグナル |

---

## コンテキストプロファイル

ヒントなしの場合は内容から自動推定。ユーザーが override 可能。

### プロファイル定義

**blog**（デフォルト） — 一般的な長文散文。全ルール適用。
**technical** — コード・API・アーキテクチャを含む文章。技術用語（robust, comprehensive, seamless, ecosystem, leverage, facilitate, underpin, streamline）は正当使用としてフラグしない。ヘッジ（"may" は技術文脈で正確）は relaxed。箇条書きは technical list として許容。
**casual** — Slack、内部メモ、クイック返信。P0 のみフラグ。他は skip。

### 自動推定キュー

| Signal | Profile |
|--------|---------|
| コードブロック、API参照、技術アーキテクチャ | technical |
| 300語未満 + ハッシュタグ・メンション | casual |
| ステップバイステップ手順、パラメータドキュメント | technical |
| 明確なシグナルなし | blog |

---

## 良い文章の基準（リライトガイド）

検出（何がダメか）だけでなく、良い文章の原則を意識してリライトする。

1. **文長を変化させる** — 短い文（3-8語）と長い文（20+）を混ぜる。断片文も有効。疑問文がモノトニーを破る。
2. **具体的に書く** — 曖昧な主張を数値・名前・日付・事例に置換する。
3. **声を持つ** — 適切な場面では一人称を使い、好みを述べ、反応を示す。AIは徹底的に中立。中立性の不在がAIシグナル。
4. **意見を持つ** — 立場を取るべき文章では立場を取る。両論併記のフリは AI のデフォルト。
5. **強調を獲得する** — 読者に「これは面白い」と伝えるな。面白くしろ。
6. **置換テーブルは指針であって命令ではない** — フラグされた語が文脈上明らかに最適なら、そのまま残す。

---

## 出力フォーマット

### Rewrite mode（デフォルト）

4セクションで返す:

**1. Issues found** — 検出された全AI的パターン。問題テキストを引用。

**2. Rewritten version** — リライト後の全文。元の構造・意図・技術的詳細を保持。ガイドラインが要求する箇所のみ変更。

**3. What changed** — 主要な変更のサマリ。全語ではなく意味のある変更のみ。

**4. Second-pass audit** — セクション2のリライトを再読し、1パス目を生き残ったAI的パターンを検出。修正があればインラインで修正し、何を変えたか注記。クリーンなら「クリーン」と宣言。

### Detect mode

2セクションで返す:

**1. Issues found** — 検出された全AI的パターン。P0/P1/P2でグループ化。問題テキストを引用。

**2. Assessment** — 各フラグについて「確実な問題」か「判断が必要」かを評価。AI的パターンでも文脈上効果的なものがある（適切に配置された "however" は問題ない）。確実に修正すべきもの vs 文脈次第のものを区別する。

---

## Self-reference escape hatch

AI的パターン「について」書いている場合（ブログ記事、チュートリアル、スキル文書等）、引用例はフラグしない。引用符、コードブロック、明示的に例示とされたテキスト（「例えばAIは〜と書く」）はスキップ。著者自身の散文に現れるパターンのみをフラグする。

---

## Credits

パターン知識の基盤:
- [conorbronsdon/avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing) (v3.3.1) — 36パターンカテゴリ、3段階語彙テーブル、コンテキストプロファイル
- [brandonwise/humanizer](https://github.com/brandonwise/humanizer) — tiered vocabulary research
- [Pangram Labs](https://www.pangram.com/) — 構造的均一性が最大の検出シグナルという知見
- [Wikipedia: Signs of AI-generated text](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)

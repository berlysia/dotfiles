# 日本語の文章スキルの入口を、目的ごとの名前に組み直すか決める

文章スキルを役割と入口の 2 層に分けた（`docs/decisions/0036-japanese-writing-skills-roles-and-entries.md`）。そのとき、入口の名前と形は今のまま（koncise、tanteki、yomiyasu、japanese-tech-writing）にした。組み直す案は、使って不便が出たときに別の作業として扱う。

## 案

役割へ規則を寄せた結果、tanteki と yomiyasu は「誰に向けて何を直すか」の入口というより、上流の追跡と、検査の道具と一覧のデータの置き場になっている。

- 入口は、目的ごとに名前を付けた薄いスキルにする（koncise と japanese-tech-writing は今の名前のまま）
- 役割スキルは今のまま
- tanteki と yomiyasu は、利用者もモデルも直接は呼ばない置き場にする。`disable-model-invocation: true` に加えて `user-invocable: false` を付けるかを決める
- 上流の追跡は、置き場の `Derived from` 行で続ける。名前を変えても、`check-skill-upstreams.sh` の追跡は壊れない（`Derived from` 行の path は上流の側にある）

## 直すもの

- `.github/scripts/check-skill-refs.sh` の入口の一覧（`ENTRY_MODES`、`ENTRY_ROLES`、`ENTRY_COND_ROLES`、`ROLE_BACKREF_ENTRIES`）と、役割から読んでよい場所（`ROLE_ALLOWED_PREFIXES`）
- スキルの承認表（`home/dot_claude/skill-approvals.md`）
- ほかのスキルからの参照: `pr-description`、`cognitive-rhythm-writing`、hub（berlysia-writing。このリポジトリの外）

## 着手する条件

入口の名前や形のせいで、使うときに不便が出たとき（どの入口を呼べばよいか迷う、置き場のスキルが意図せず発火する、など）。設計の判断を含むので、Document Workflow で進める。

## このファイルを消す条件

組み直したか、組み直さないと決めたとき。

# 全 branch の workflow への push を人間だけに限る

## 背景

delivery-policy の merge 判定では、`integration_id` の無い必須の context を、check run でも満たせる。Bot が付けた commit status でも満たせる。agent は SSH の push で別の branch に `statuses: write`（または `checks: write`）の workflow を置ける。その workflow は github-actions 名義で、任意の sha に同名の status や check run を付けられる。そのため必須の context を偽れる。PR の diff の保護パス（`.github/`）は、別の branch への push を見ない。

## 決めること

- ruleset の「Restrict file paths」で、全 branch の `.github/workflows/**` の変更を禁じ、bypass を人間だけにするか。
- あわせて、Actions の「Require approval for all outside collaborators」などの承認を使うか。
- 代わりに、必須の context を check run にして `integration_id` を github-actions（15368）に固定するか。固定しても、github-actions 名義の workflow なら同じ名前で作れる点は変わらない。

## 出どころ

ADR-0046 の Amendments（2026-10-25）の受け入れた限界の 1 つ目。

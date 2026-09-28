# ADR-0017: claude / codex を repo ごとの OrbStack isolated machine で隔離起動する

## Status

accepted (2026-09-28)

## Context

mac 上で `claude` / `codex` はそのまま host のホームディレクトリで動く。agent は `~` 全体、1Password デスクトップ連携、host のコマンドに到達できる状態にある。

OrbStack の通常の machine（isolated 指定なし）は `/Users` 全体への読み書きと、`mac` コマンドによる host コマンド実行を持ち、これらを選択的に無効化できない。隔離を機構として持たせるには、通常 machine ではなく isolated machine（`--isolated --isolate-network --forward-ssh-agent`）を使う必要がある。

設計の全文は `docs/plans/agent-vm/spec.md`（K1〜K16、7 名 × 8 ラウンドのレビューと intent triage を経て verdict=pass）と、それに続く plan-1〜plan-4（各 5〜7 名 × 複数ラウンドで verdict=pass）にある。ここには骨子と、却下した代替案を記す。

## Decision

支配軸はエルゴノミクスである（ユーザー明示）。安全境界（isolated machine）はユーザー決定済みの制約であり、その内側で普段の打鍵・待ち時間・手作業を増やさないことを優先する。

### 境界と機構（K1〜K16 の骨子）

- **K1**: 境界は repo ごとの isolated machine。machine 名は repo basename の正規化と repo 絶対パスの sha256 先頭 6 桁から導出する。同一 machine への並行アクセスは `flock(2)` による排他（bash 3.2 と標準 perl だけで実現）で守る。
- **K2・K3**: 「読み込み限定」は、host 側の VM から見えない領域で tracked files を毎回コピーし直し、mount された staging へ `rename(2)` で置き換える方式で実現する。内容 hash が変われば VM 内で再適用する。
- **K4**: VM 向けの分岐は chezmoi データ `agent_vm` の 1 つに絞り、既存 host は無変更で動く（`dig` によるガード）。
- **K5**: VM の global mise ツールは軽量セットに絞る。
- **K6**: 秘密は host 所有の `op://` 参照ファイルだけを host 側で解決し、tmpfs 経由で VM に渡す。repo 内の `.env` は解決しない。
- **K7**: Claude・Codex とも machine ごとに初回ログインし、認証は VM の中にだけ置く。長期 token の注入も、認証の VM 間共有も行わない。
- **K8**: git の SSH 認証・署名は agent forwarding だけで行い、gitconfig は変更しない。
- **K9**: セッションログは常時 outbox に置き、起動時・終了時・`agent-vm sync` で host に取り込む。取り込みは追記専用を前提にした検証を伴う。
- **K10**: 既定で VM を経由し、opt-out（`AGENT_VM=off`、`~/.config/agent-vm/config`）は host 側にしか置けない。OrbStack が使えない・応答しないときは host に自動で切り替えず、fail closed する。
- **K11・K12**: host 側ファイルは darwin にのみ配布する。OrbStack は Homebrew cask で宣言管理する。
- **K13**: repo は VM から rw で mount されるため、`.git/hooks` や `.git/config` の実行系設定を VM が書き換える余地が残る。launcher は起動・終了のたびにこれらのスナップショットを取り、差分を検知・報告する。
- **K14**: machine の一覧・掃除（`list` / `gc` / `rm`）を提供する。
- **K15**: 初回の待ちを前倒しする `agent-vm prewarm` を提供する。自動 prewarm は行わない。
- **K16**: VM の claude は host と同じ公式 installer で導入し、bootstrap が未導入時だけ実行する。

### 却下した代替案

- **通常 machine + bubblewrap**: 通常 machine は `/Users` 全体 rw と `mac` コマンドを持ち、bubblewrap で追加の隔離層を作っても、OrbStack 自体が持つ mount と host 到達性を打ち消せない。isolated machine が標準機能として同等以上の隔離を提供する。
- **Docker container**: agent が対話的に使うツールチェイン一式（mise、chezmoi、各言語ランタイム）を container image として保守するコストが、VM 全体を repo ごとに使い捨てる方式より高い。OrbStack の isolated machine は VM でありながら起動が軽く、この用途に対して container の利点が薄い。
- **共有 staging（machine 間で 1 つの staging を使う）**: 1 つの VM が staging を書き換えられると、他の VM もその内容を読み込む経路になる。machine ごとに staging を分けることで、VM 間の書き込み経路そのものをなくす。
- **repo 内の `.env` を秘密解決の対象にする**: repo は VM から書き換えられる。そこに任意の `op://` 参照を書かれると、host 側の認証済み `op` が無関係な秘密まで解決して VM に渡してしまう。解決対象を host 所有のファイル 2 つに固定することで、この経路を閉じる。
- **認証（Codex の `auth.json` など）を全 VM で共有する**: 1 つの VM の侵害が全 repo 分の認証に及ぶ。VM ごとに個別の認証を持たせることで、侵害の影響をその VM だけに閉じる。
- **長期 token（`claude setup-token` 等）を 1Password から毎回注入する**: 同じ token を全 VM の環境変数に載せることになり、1 つの VM の侵害で全 repo 分の資格情報が漏れる。VM ごとの初回ログインのほうが、Codex と手順がそろい、被害範囲も machine 単位に閉じる。
- **mkdir + pid によるロック**: stale lock の回収手順が競合を繰り返し生んだ。`flock(2)` は open file description に属し、保持するプロセスが落ちれば OS が自動で解放するため、回収手順そのものが要らない。

## Consequences

- **R1**: OrbStack の実際の挙動は、この設計を作った WSL 上のセッションでは検証できない。依存する挙動は V1〜V17 として mac 実機での確認に委ねる（`docs/agent-vm.md` の該当節）。launcher 自体のロジック（名前導出・引数組立・opt-out 判定・hash 比較・取り込みフィルタ・git 面検査）は `orb` / `op` を stub にした smoke test で Linux 上でも検証している。
- **R2・R3**: 1Password agent forwarding と OrbStack の組み合わせ（1Password の承認粒度、agent forwarding 自体の相性）は V3 で確認する。gitconfig を変更しないため、問題が起きた場合は VM 内の署名エラーとして顕在化し、黙って未署名にはならない。
- **R4**: 侵害された machine はその machine の認証を持ち出せるが、影響は machine 単位に閉じる。失効手順（claude.ai / ChatGPT のセッション管理からの取り消しと `agent-vm rm`）は `docs/agent-vm.md` に記載した。
- **R5**: 初回プロビジョニングの待ち時間は K5（mise 軽量セット）と K15（`prewarm`）で抑える。実測は V4 に委ねる。
- **R6**: VM 内の default user は passwordless sudo を持つが、isolated machine の外には及ばない。VM 内 root が書ける host パスは repo・staging・outbox に限られ、いずれも元々 rw で渡している範囲と同じである。
- **R7**: outbox からの取り込みは VM 由来のデータを host に書き込む唯一の経路である。通常ファイルの jsonl 以外と symlink を除外し、取り込み先を 2 箇所に固定し、既存ファイルへは先頭一致を確認した追記しか行わない設計にすることで、host 側の完全性を保っている。
- **R8**: K13 の git 面検査は事後検知であり、VM セッション実行中に host で同じ repo の git を使うと、検査の前に改変が実行されうる。この運用ルール（VM セッション中は host の git を使わない）は `docs/agent-vm.md` に明記した。完全な防止には `.git` を mount から外す必要があるが、それでは VM 内で commit できなくなり、オーダー（repo で作業する）を満たさない。
- **R9**: Codex 内蔵 sandbox（Landlock + seccomp）が OrbStack のカーネルで動くかどうかは V9 で確認する。動かない場合は VM 境界を sandbox とみなし、VM 内の Codex だけ `sandbox_mode` を緩める設定を別 plan とする。
- Phase 1 で意図的に提供しない体験（egress の許可リスト制御、mac クリップボード画像の貼り付け、1Password 以外の host 資格情報ストアとの連携）は spec.md に記録し、`docs/agent-vm.md` には現状の制約として明記した。

## References

- `docs/plans/agent-vm/spec.md` / `research.md` / `plan-1.md` / `plan-2.md` / `plan-3.md` / `plan-4.md`
- `docs/agent-vm.md`（導入ガイド、mac 実機検証項目 V1〜V17）
- `home/dot_local/bin/executable_agent-vm`, `agent-vm/cloud-init.yaml`, `agent-vm/bootstrap.sh`, `home/dot_shell_common/agent_vm.sh`
- https://docs.orbstack.dev/machines/isolated

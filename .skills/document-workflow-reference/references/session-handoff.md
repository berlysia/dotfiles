# workflow dir の引き継ぎ

成果物を次のセッションへ引き継ぐときに読む。要約は SKILL.md「workflow dir の引き継ぎ」にある。

hook は wfDir を hook 入力の `session_id` + cwd から導出するので、環境変数が無くても enforce は効く。次セッションへ引き継ぐとき:

- **`/clear` して同じプロセスで続ける**: `/clear` は新しい session id を発行するので、前セッションの成果物を新 dir へ `cp -a` で複製する。auto-review hash は内容だけから算出されるので承認状態は保たれ、`approvals.log` も移るので同じ版の承認も引き継がれる。`workflow-cli dir` の値をリテラルで貼る（シェル変数を使わないので、空の変数でルートに展開する事故が起きない）:

  ```bash
  workflow-cli dir   # wfDir=<新しい dir> を確かめる
  cp -a .tmp/sessions/<旧 id 先頭8桁>/. <wfDir の値>/
  ```

- **`claude` を起動し直す**: `DOCUMENT_WORKFLOW_DIR=.tmp/sessions/<旧 id 先頭8桁> claude "..."` と起動時 env で pin する。containment を満たさない pin は `env-rejected` として捨てられ導出値が使われる。

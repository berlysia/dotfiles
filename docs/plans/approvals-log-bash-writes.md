# approvals.log への Bash の書き込みを止める

Document Workflow の承認の台帳 `approvals.log` は、Write/Edit/MultiEdit の書き込みを `document-workflow-guard` の `judgeApprovalWrite` が拒否する。Bash による書き込み（`echo ... >> <wfDir>/approvals.log` など）は止めていない。Bash の書き込み先の判定は workflow の Scope に照らすだけで、台帳に固有の規則が無い。

delivery-policy の台帳（ADR-0046）では、台帳の dir のパスを含む Bash を拒否する規則を入れた。同じ規則を `approvals.log` と `delegation-uses.log` にも当てるかを決める。

- 当てる場合: `<projectRoot>/.tmp/sessions/` の下の台帳のファイル名を含む Bash を拒否する。workflow-cli が書くので、workflow-cli のコマンドは通す形にする。
- 当てない場合: その理由（承認の偽造で得られるのは実装の着手だけ、など）を ADR-0023 の経緯に書く。

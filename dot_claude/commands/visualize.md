# /visualize - Code Visualization Command

## 概要

コードベースから様々な視覚的図表を自動生成するコマンド。複雑なシステムの理解、デバッグ、コミュニケーションを支援します。

## 使用法

```
/visualize <target>
/visualize <target> --type <flowchart|sequence|erd|architecture>
/visualize <target> --format <mermaid|plantuml|graphviz>
```

## 引数

- `<target>`: 分析対象（ファイル、ディレクトリ、関数名など）
- `--type`: 図表の種類を指定
  - `flowchart`: コードフロー図
  - `sequence`: シーケンス図
  - `erd`: データベースER図
  - `architecture`: システムアーキテクチャ図
- `--format`: 出力フォーマット
  - `mermaid`: Mermaid記法（デフォルト）
  - `plantuml`: PlantUML記法
  - `graphviz`: Graphviz記法

## 機能

### 生成可能な図表
1. **コードフロー図**: 関数やメソッドの実行フローを視覚化
2. **シーケンス図**: API呼び出しやメソッド間の相互作用を表現
3. **ER図**: データベーススキーマの関係性を図示
4. **アーキテクチャ図**: システム全体の構成要素と依存関係を表現
5. **クラス図**: クラスやモジュールの関係性を視覚化

### 特徴
- 複雑度メトリクスを図表に追加
- ソースコードへのクリック可能なリンク生成
- 依存関係の可視化
- 対話的な図表生成
- 複数のプログラミング言語に対応

## 出力

- デフォルト出力先: `/docs/diagrams/` ディレクトリ
- 生成された図表は自動的に適切な場所に保存
- Markdown形式での説明も同時生成
- `tee`コマンドを使用してコンソール表示と同時にファイル出力

## 使用例

```bash
# 特定のファイルのフロー図を生成
/visualize src/main.ts

# API のシーケンス図を生成
/visualize src/api/ --type sequence

# データベースのER図を生成
/visualize schema.sql --type erd

# システム全体のアーキテクチャ図を生成
/visualize . --type architecture --format plantuml
```

## 実装パターン

### teeコマンドを使った効率的な出力

```bash
# 図表生成と同時表示・保存
generate_visualization() {
    local target="$1"
    local output_file="PROJECT_VISUALIZATION.md"
    
    # 可視化内容を生成して同時に表示・保存
    cat <<EOF | tee "$output_file"
# プロジェクト可視化: $target

## アーキテクチャ図
\`\`\`mermaid
graph TB
    ...
\`\`\`

## 依存関係図
\`\`\`mermaid
graph LR
    ...
\`\`\`
EOF
}
```

### 実装上の利点

- **即座の確認**: ユーザーは生成内容を即座に確認できる
- **同時保存**: ファイルに自動保存される
- **効率性**: 一度の処理で表示と保存が完了
- **一貫性**: 表示内容とファイル内容が確実に一致

## 対象言語

- TypeScript/JavaScript
- Python
- Go
- Rust
- SQL
- YAML/JSON設定ファイル

## ベストプラクティス

1. **段階的な可視化**: 大きなシステムは部分ごとに分けて可視化
2. **適切な図表選択**: 目的に応じて最適な図表タイプを選択
3. **定期的な更新**: コード変更に合わせて図表を更新
4. **ドキュメント統合**: 生成された図表をドキュメントに組み込み

## 注意事項

- 大規模なコードベースでは処理時間が長くなる場合があります
- 生成される図表の品質はコードの構造に依存します
- 複雑すぎる図表は手動で調整が必要な場合があります

---

*「百聞は一見に如かず」- このコマンドはシステムの理解、デバッグ、コミュニケーションをより効果的にします。*
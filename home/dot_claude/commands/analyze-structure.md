# /analyze-structure - コード構造解析コマンド

## 概要

コードベースの構造を分析し、システムが処理しやすい構造化データフォーマットで出力するコマンド。専門エージェントのオーケストレーションにより、CI/CD、自動化、メトリクス収集などのシステム連携に最適化されています。

## 分析フェーズ

このコマンドは以下の2フェーズで専門エージェントを直接呼び出します：

### Phase 1: Analysis (並列実行)

以下の4つの専門エージェントを並列実行:

- **code-complexity-analyzer**: 複雑度メトリクス（McCabe、認知的複雑度等）
- **architecture-boundary-analyzer**: アーキテクチャ境界・依存関係分析
- **coupling-evaluator**: モジュール間結合度評価
- **cohesion-evaluator**: モジュール内凝集度評価

**実行方法**:
```
Task(code-complexity-analyzer): 対象コードの複雑度分析
Task(architecture-boundary-analyzer): アーキテクチャ境界分析
Task(coupling-evaluator): 結合度評価
Task(cohesion-evaluator): 凝集度評価
```

### Phase 2: Integration

エージェント分析結果の統合と出力フォーマット変換:
1. 各エージェントの結果を収集
2. メトリクスを統一スケール（1-5）に正規化
3. 指定フォーマット（JSON/YAML/CSV/XML）に変換
4. ファイル出力または標準出力

## 使用法

```bash
/analyze-structure <target>
/analyze-structure <target> --output <json|yaml|csv|xml>
/analyze-structure <target> --metrics <metric1,metric2,...>
/analyze-structure <target> --format structured --export <filename>
```

## 引数

- `<target>`: 分析対象（ファイル、ディレクトリ、関数名など）
- `--output`: 出力フォーマット
  - `json`: JSON形式（デフォルト）
  - `yaml`: YAML形式
  - `csv`: CSV形式
  - `xml`: XML形式
- `--metrics`: 収集するメトリクス
  - `complexity`: 循環的複雑度
  - `dependencies`: 依存関係
  - `coverage`: テストカバレッジ
  - `size`: コードサイズ
  - `maintainability`: 保守性指標
  - `security`: セキュリティメトリクス
- `--export`: 出力ファイル名

## 出力データ構造

### 基本構造（JSON例）
```json
{
  "metadata": {
    "timestamp": "2024-01-01T00:00:00Z",
    "target": "src/",
    "version": "1.0.0",
    "analyzer": "claude-analyze-structure"
  },
  "structure": {
    "files": [...],
    "directories": [...],
    "functions": [...],
    "classes": [...],
    "modules": [...]
  },
  "metrics": {
    "complexity": {...},
    "dependencies": {...},
    "coverage": {...}
  },
  "summary": {
    "total_files": 42,
    "total_functions": 156,
    "average_complexity": 3.2,
    "dependency_count": 28
  }
}
```

### エージェント別メトリクス

#### 複雑度メトリクス（`code-complexity-analyzer`）
- 循環的複雑度（McCabe）
- 認知的複雑度
- ネストレベル
- 分岐数
- 関数・クラスサイズ
- 保守性指標

#### アーキテクチャメトリクス（`architecture-boundary-analyzer`）
- 依存関係グラフ
- 循環依存検出
- 境界違反分析
- レイヤー準拠性

#### 結合度メトリクス（`coupling-evaluator`）
- 内部依存関係
- 外部依存関係
- 結合強度評価
- デカップリング推奨

#### 凝集度メトリクス（`cohesion-evaluator`）
- モジュール内統合度
- 責務一貫性
- 重複コード検出
- 単一責任原則準拠性

## 使用例

```bash
# 基本的な構造分析（エージェントオーケストレーション）
/analyze-structure src/

# 複雑度とアーキテクチャメトリクスをYAML形式で出力
/analyze-structure src/ --metrics complexity,architecture --output yaml

# 結合度・凝集度分析をCSVで出力
/analyze-structure . --metrics coupling,cohesion --output csv

# 全メトリクスをJSON形式でファイルに出力（統合分析）
/analyze-structure . --metrics all --export project-analysis.json

# 特定モジュールの複雑度・品質分析
/analyze-structure src/payment/ --metrics complexity,quality
```

## 実装詳細

### Phase 1: Analysis実行

```markdown
## 並列エージェント実行
Task(code-complexity-analyzer):
  - 対象: <target>
  - 出力: 複雑度メトリクス、保守性指標

Task(architecture-boundary-analyzer):
  - 対象: <target>
  - 出力: 依存関係グラフ、境界違反

Task(coupling-evaluator):
  - 対象: <target>
  - 出力: 結合度スコア、依存関係評価

Task(cohesion-evaluator):
  - 対象: <target>
  - 出力: 凝集度スコア、責務評価
```

### Phase 2: Integration実行

```markdown
## 結果統合プロセス
1. 各エージェント結果を収集
2. メトリクス正規化（1-5スケール）:
   - Complexity: McCabe複雑度 → スコア変換
   - Architecture: 境界違反数 → スコア変換
   - Coupling: 依存関係数 → スコア変換
   - Cohesion: 凝集度レベル → スコア変換
3. フォーマット変換:
   - JSON: 構造化オブジェクト
   - YAML: 階層的表現
   - CSV: 表形式データ
   - XML: タグベース構造
4. 出力:
   - --export指定時: ファイル保存
   - 未指定時: 標準出力
```

### 並列実行の利点

- **専門性**: 各エージェントが専門分野に特化した高精度分析
- **並列処理**: 4エージェント同時実行による高速化
- **統合分析**: 複数観点からの包括的品質評価
- **標準化**: 統一されたメトリクスフォーマット（1-5スケール）
- **拡張性**: 新しい専門エージェント追加による機能拡張
- **CI/CD統合**: 標準化されたデータフォーマットによるシステム連携

## 出力フォーマット例

### CSV出力例
```csv
file,function,complexity,lines,dependencies
src/main.ts,main,3,25,5
src/utils.ts,calculateTotal,7,45,2
```

### YAML出力例
```yaml
metadata:
  timestamp: 2024-01-01T00:00:00Z
  target: src/
structure:
  files:
    - name: main.ts
      functions: 3
      complexity: 8
```

## システム連携

### CI/CD統合（並列エージェント分析）
```yaml
# GitHub Actions例 - 4エージェント並列分析
- name: Structure Analysis
  run: |
    claude /analyze-structure src/ --export structure.json
    # 統合メトリクス取得
    cat structure.json | jq '.summary.overall_score'
    cat structure.json | jq '.metrics.complexity.score'
    cat structure.json | jq '.metrics.coupling.score'
    cat structure.json | jq '.metrics.cohesion.score'
    cat structure.json | jq '.metrics.architecture.score'
```

### 品質ゲート（統合メトリクス活用）
```bash
# 統合品質スコアチェック
overall_score=$(claude /analyze-structure src/ --metrics all --output json | jq '.summary.overall_score')
if (( $(echo "$overall_score < 3" | bc -l) )); then
  echo "Overall quality score too low: $overall_score"
  exit 1
fi

# 各次元での品質チェック
complexity_score=$(cat structure.json | jq '.metrics.complexity.score')
architecture_score=$(cat structure.json | jq '.metrics.architecture.score')
coupling_score=$(cat structure.json | jq '.metrics.coupling.score')
cohesion_score=$(cat structure.json | jq '.metrics.cohesion.score')
```

## 対象言語

- TypeScript/JavaScript
- Python
- Go
- Rust
- Java
- C/C++
- SQL
- YAML/JSON設定ファイル

## 連携コマンド

- `/visualize`: 構造分析結果を視覚化
- `/self-review`: 構造分析結果をコードレビューに統合

## 分析の特徴

- **専門性の高い分析**: 各エージェントが特定領域に特化（複雑度、アーキテクチャ、結合度、凝集度）
- **統合された洞察**: 4観点からの包括的な品質評価
- **標準化されたメトリクス**: 1-5スケールでの一貫した品質指標
- **効率的な並列処理**: 4エージェント同時実行による高速分析
- **拡張可能なアーキテクチャ**: 新しい分析エージェント追加対応

## 注意事項

- 大規模なコードベースでは4エージェント並列処理により処理時間を最適化
- Phase 2で結果統合により一貫性のある品質評価を提供
- メトリクス精度は各専門エージェントの言語サポートレベルに依存

---

*4つの専門エージェント並列実行によるデータ駆動型開発を支援し、多角的なコード品質の定量的管理を実現します。*
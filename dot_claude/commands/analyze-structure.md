# /analyze-structure - コード構造解析コマンド

## 概要

コードベースの構造を分析し、システムが処理しやすい構造化データフォーマットで出力するコマンド。専門エージェントのオーケストレーションにより、CI/CD、自動化、メトリクス収集などのシステム連携に最適化されています。

## エージェントオーケストレーション

このコマンドは`structure-analysis-orchestrator`エージェントに分析を委譲し、以下の専門エージェントを連携させます：

- **code-complexity-analyzer**: 複雑度メトリクス（McCabe、認知的複雑度等）
- **architecture-boundary-analyzer**: アーキテクチャ境界・依存関係分析
- **coupling-evaluator**: モジュール間結合度評価
- **cohesion-evaluator**: モジュール内凝集度評価
- **metrics-collection-orchestrator**: 構造化データ出力・フォーマット変換

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

## エージェント連携パターン

### オーケストレーションによる効率的な分析

```bash
# エージェント連携による構造分析結果を同時表示・保存
generate_structure_analysis() {
    local target="$1"
    local output_format="${2:-json}"
    local output_file="structure-analysis.${output_format}"
    
    # structure-analysis-orchestratorによる統合分析結果を表示・保存
    orchestrate_analysis "$target" --output "$output_format" | tee "$output_file"
}

# エージェント統合メトリクス収集
collect_orchestrated_metrics() {
    local target="$1"
    local metrics_file="metrics-$(date +%Y%m%d).json"
    
    # metrics-collection-orchestratorによる統合メトリクス収集・整形・保存
    orchestrate_metrics_collection "$target" | tee "$metrics_file"
}

# 複数エージェント結果の統合
analyze_with_orchestrated_agents() {
    local target="$1"
    local output_file="analysis-$(date +%Y%m%d).json"
    
    # structure-analysis-orchestratorによる複数エージェント統合分析
    structure_analysis_orchestrator "$target" --output json | tee "$output_file"
}
```

### エージェントオーケストレーションの利点

- **専門性**: 各エージェントが専門分野に特化した高精度分析
- **並列処理**: 複数エージェント同時実行による高速化
- **統合分析**: エージェント間の結果統合と矛盾解決
- **標準化**: 統一されたメトリクスフォーマットと品質基準
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

### CI/CD統合（エージェントオーケストレーション）
```yaml
# GitHub Actions例 - structure-analysis-orchestratorによる統合分析
- name: Orchestrated Structure Analysis
  run: |
    claude /analyze-structure src/ --export structure.json
    # 複数エージェントの統合メトリクス取得
    cat structure.json | jq '.summary.overall_score'
    cat structure.json | jq '.metrics.complexity.score'
    cat structure.json | jq '.metrics.coupling.score'
```

### 品質ゲート（統合メトリクス活用）
```bash
# 統合品質スコアチェック
overall_score=$(claude /analyze-structure src/ --metrics all --output json | jq '.summary.overall_score')
if (( $(echo "$overall_score < 3" | bc -l) )); then
  echo "Overall quality score too low: $overall_score"
  exit 1
fi

# 複数次元での品質チェック
complexity_score=$(cat structure.json | jq '.metrics.complexity.score')
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

## エージェント連携の特徴

- **専門性の高い分析**: 各エージェントが特定領域に特化
- **統合された洞察**: 複数観点からの包括的な品質評価
- **標準化されたメトリクス**: 1-5スケールでの一貫した品質指標
- **効率的な並列処理**: 複数エージェント同時実行による高速分析
- **拡張可能なアーキテクチャ**: 新しい分析エージェント追加対応

## 注意事項

- 大規模なコードベースでは複数エージェント並列処理により処理時間を最適化
- エージェント間の結果統合により一貫性のある品質評価を提供
- メトリクス精度は各専門エージェントの言語サポートレベルに依存

---

*エージェントオーケストレーションによるデータ駆動型開発を支援し、多角的なコード品質の定量的管理を実現します。*
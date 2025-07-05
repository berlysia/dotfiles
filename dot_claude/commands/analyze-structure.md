# /analyze-structure - コード構造解析コマンド

## 概要

コードベースの構造を分析し、システムが処理しやすい構造化データフォーマットで出力するコマンド。CI/CD、自動化、メトリクス収集などのシステム連携に最適化されています。

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

### メトリクス詳細

#### 複雑度メトリクス
- 循環的複雑度（McCabe）
- 認知的複雑度
- ネストレベル
- 分岐数

#### 依存関係メトリクス
- 内部依存関係
- 外部依存関係
- 依存関係グラフ
- 循環依存検出

#### サイズメトリクス
- 行数（LOC）
- 実行可能行数（SLOC）
- 関数サイズ
- クラスサイズ

#### 保守性メトリクス
- 保守性指標
- 重複コード検出
- 技術的負債
- コード品質スコア

## 使用例

```bash
# 基本的な構造分析
/analyze-structure src/

# 複雑度とサイズメトリクスをYAML形式で出力
/analyze-structure src/ --metrics complexity,size --output yaml

# 依存関係をCSVで出力
/analyze-structure package.json --metrics dependencies --output csv

# 全メトリクスをJSON形式でファイルに出力
/analyze-structure . --metrics all --export project-analysis.json

# 特定の関数の詳細分析
/analyze-structure src/utils.ts::calculateTotal --metrics complexity,size
```

## 実装パターン

### teeコマンドを使った効率的な出力

```bash
# 構造分析結果を同時表示・保存
generate_structure_analysis() {
    local target="$1"
    local output_format="${2:-json}"
    local output_file="structure-analysis.${output_format}"
    
    # 分析結果を生成して同時に表示・保存
    analyze_codebase "$target" --output "$output_format" | tee "$output_file"
}

# メトリクス収集と同時出力
collect_metrics() {
    local target="$1"
    local metrics_file="metrics-$(date +%Y%m%d).json"
    
    # メトリクスを収集してJSONとして整形・表示・保存
    jq -n \
        --arg timestamp "$(date -Iseconds)" \
        --arg target "$target" \
        --argjson metrics "$(collect_complexity_metrics "$target")" \
        --argjson summary "$(generate_summary "$target")" \
        '{
            timestamp: $timestamp,
            target: $target,
            metrics: $metrics,
            summary: $summary
        }' | tee "$metrics_file"
}

# 複数データソースの統合
analyze_with_multiple_sources() {
    local target="$1"
    local output_file="analysis-$(date +%Y%m%d).json"
    
    # 複数の分析結果を統合
    jq -s '.[0] * .[1] * .[2]' \
        <(analyze_structure "$target") \
        <(collect_dependencies "$target") \
        <(calculate_metrics "$target") \
        | tee "$output_file"
}
```

### 実装上の利点

- **即座の確認**: 分析結果を即座に確認できる
- **同時保存**: ファイルに自動保存される
- **パイプライン対応**: 他のコマンドと組み合わせ可能
- **CI/CD統合**: 標準出力とファイル出力を同時に活用

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

### CI/CD統合
```yaml
# GitHub Actions例
- name: Code Structure Analysis
  run: |
    claude /analyze-structure src/ --export structure.json
    cat structure.json | jq '.metrics.complexity.average'
```

### 品質ゲート
```bash
# 複雑度チェック
complexity=$(claude /analyze-structure src/ --metrics complexity --output json | jq '.metrics.complexity.average')
if (( $(echo "$complexity > 5" | bc -l) )); then
  echo "Complexity too high: $complexity"
  exit 1
fi
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

## 注意事項

- 大規模なコードベースでは処理時間が長くなる場合があります
- 外部依存関係の分析には適切な権限が必要です
- メトリクスの精度は言語サポートレベルに依存します

---

*データ駆動型の開発を支援し、コード品質の定量的な管理を実現します。*
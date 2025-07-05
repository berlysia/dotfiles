# プロジェクト可視化: Chezmoi Dotfiles

## プロジェクト概要

**Chezmoi Dotfiles Project** は、複数のプラットフォーム（macOS、Linux、Windows、WSL）で一貫した開発環境を提供するためのdotfiles管理システムです。

### 主要コンポーネント

1. **設定管理**: chezmoi によるテンプレートベースの設定管理
2. **Shell環境**: zsh/bash の共通設定とプラットフォーム別最適化
3. **開発ツール**: mise、direnv、fzf、ripgrep、bat の統合
4. **AI統合**: Claude AI との連携とMCPサーバー設定
5. **パッケージ管理**: プラットフォーム別の自動インストール

### 特徴

- **クロスプラットフォーム対応**: 単一の設定で複数OSをサポート
- **モジュラー設計**: 機能別に分離された設定ファイル
- **自動化**: パッケージインストールと環境セットアップの自動化
- **AI統合**: Claude AI との深い統合による開発効率化

## プロジェクトアーキテクチャ図

```mermaid
graph TB
    subgraph "Chezmoi Dotfiles Project"
        A[chezmoi管理] --> B[クロスプラットフォーム対応]
        
        subgraph "コア設定ファイル"
            C[.zshrc/.zshenv]
            D[.gitconfig]
            E[.bashrc/.bash_profile]
            F[starship.toml]
        end
        
        subgraph "Shell共通設定"
            G[aliases.sh]
            H[functions.sh]
            I[env.sh]
            J[path.sh]
            K[tools.sh]
            L[OS固有設定]
        end
        
        subgraph "Claude AI統合"
            M[CLAUDE.md]
            N[コマンド定義]
            O[Hooks設定]
            P[MCP設定]
        end
        
        subgraph "パッケージ管理"
            Q[mise.toml]
            R[インストールスクリプト]
            S[プラットフォーム別パッケージ]
        end
        
        subgraph "外部ツール"
            T[mise]
            U[direnv]
            V[fzf]
            W[ripgrep]
            X[bat]
        end
        
        A --> C
        A --> D
        A --> E
        A --> F
        
        B --> G
        B --> H
        B --> I
        B --> J
        B --> K
        B --> L
        
        A --> M
        M --> N
        M --> O
        M --> P
        
        A --> Q
        Q --> R
        R --> S
        
        Q --> T
        T --> U
        T --> V
        T --> W
        T --> X
        
        style A fill:#e1f5fe
        style B fill:#f3e5f5
        style M fill:#e8f5e8
        style Q fill:#fff3e0
    end
```

## 依存関係図

```mermaid
graph LR
    subgraph "依存関係フロー"
        A[chezmoi] --> B[OS検出]
        B --> C{プラットフォーム}
        
        C -->|macOS| D[Darwin設定]
        C -->|Linux| E[Linux設定]
        C -->|Windows| F[Windows設定]
        C -->|WSL| G[WSL設定]
        
        D --> H[Homebrew]
        E --> I[パッケージマネージャー]
        F --> J[Winget/Scoop]
        G --> K[WSL2 SSH Agent]
        
        H --> L[共通ツール]
        I --> L
        J --> L
        K --> L
        
        L --> M[mise]
        L --> N[direnv]
        L --> O[fzf]
        L --> P[ripgrep]
        L --> Q[bat]
        
        M --> R[実行時環境]
        N --> R
        O --> R
        P --> R
        Q --> R
        
        R --> S[開発環境]
        
        style A fill:#ffeb3b
        style S fill:#4caf50
    end
```

## システム構成図

```mermaid
graph TB
    subgraph "Dotfiles System Architecture"
        subgraph "管理レイヤー"
            A[chezmoi]
            B[Git Repository]
            C[Template System]
        end
        
        subgraph "設定レイヤー"
            D[Shell Configuration]
            E[Development Tools]
            F[System Integration]
        end
        
        subgraph "実行レイヤー"
            G[Runtime Environment]
            H[Development Workflow]
            I[AI Integration]
        end
        
        A --> D
        B --> A
        C --> A
        
        D --> G
        E --> G
        F --> G
        
        G --> H
        G --> I
        
        subgraph "外部システム"
            J[Claude AI]
            K[MCP Servers]
            L[Package Managers]
        end
        
        I --> J
        I --> K
        E --> L
        
        style A fill:#2196f3
        style D fill:#ff9800
        style G fill:#4caf50
        style I fill:#9c27b0
    end
```

## ディレクトリ構造

```
chezmoi/
├── README.md                   # プロジェクト説明
├── CONCEPT.md                  # 設計思想
├── PROJECT_VISUALIZATION.md   # このファイル
├── dot_claude/                 # Claude AI統合
│   ├── CLAUDE.md              # Claude設定
│   ├── commands/              # カスタムコマンド
│   ├── hooks/                 # フック設定
│   └── settings.json.tmpl     # 設定テンプレート
├── dot_shell_common/          # Shell共通設定
│   ├── aliases.sh             # エイリアス定義
│   ├── functions.sh           # 関数定義
│   ├── env.sh                 # 環境変数
│   ├── path.sh                # PATH設定
│   └── OS別設定ファイル
├── dot_zsh/                   # Zsh設定
├── private_dot_config/        # アプリケーション設定
├── scripts/                   # ユーティリティスクリプト
└── run_onchange_*.sh.tmpl     # インストールスクリプト
```

## 主要機能

### 1. クロスプラットフォーム対応
- macOS、Linux、Windows、WSL での統一環境
- プラットフォーム固有の最適化
- 条件分岐による設定の自動調整

### 2. Shell環境の最適化
- モジュラー設計による保守性
- パフォーマンス監視機能
- 履歴管理とFZF統合

### 3. 開発ツール統合
- mise による言語バージョン管理
- direnv による環境変数管理
- 検索・表示ツールの統合

### 4. AI統合
- Claude AI との深い統合
- カスタムコマンドの定義
- MCP サーバー設定

### 5. 自動化
- パッケージの自動インストール
- 設定の自動適用
- 環境セットアップの簡素化

## 使用技術

- **chezmoi**: dotfiles管理
- **Shell**: zsh/bash
- **Git**: バージョン管理
- **Templates**: 動的設定生成
- **Claude AI**: AI統合
- **MCP**: Model Context Protocol

このプロジェクトは開発者の生産性向上を目的とし、環境構築の手間を最小化しつつ、一貫性のある開発体験を提供します。
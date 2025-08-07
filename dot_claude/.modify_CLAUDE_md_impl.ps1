@set args=%*
@powershell "iex((@('')*3+(cat '%~f0'|select -skip 3))-join[char]10)"
@exit /b %ERRORLEVEL%
# ~/.claude/CLAUDE.md のシンプルパッチベースマージスクリプト (PowerShell版)
# diffとpatchコマンドを直接使用した軽量実装

param(
    [Parameter(ValueFromPipeline = $true)]
    [string[]]$InputObject
)

$ErrorActionPreference = "Stop"

# マージモード設定
$MERGE_MODE = $env:MERGE_MODE ?? "AUTO"

# 作業用一時ファイル
$TempDir = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath()) -Name ([System.Guid]::NewGuid().ToString())
$ExistingFile = Join-Path $TempDir "existing.md"
$ChezmoiFile = Join-Path $TempDir "chezmoi.md"

# エラー時のクリーンアップ
function Cleanup {
    Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

try {
    # 標準入力から既存のファイル内容を読み込み
    $inputContent = [System.Console]::In.ReadToEnd()
    $inputContent | Out-File -FilePath $ExistingFile -Encoding UTF8 -NoNewline

    # chezmoi管理のCLAUDE.md設定を読み込み
    @'
{{ includeTemplate "dot_claude/.CLAUDE.md" . }}
'@ | Out-File -FilePath $ChezmoiFile -Encoding UTF8

    # パッチ生成（変更検出）
    function Test-FilesEqual {
        $existing = Get-Content $ExistingFile -Raw -ErrorAction SilentlyContinue
        $chezmoi = Get-Content $ChezmoiFile -Raw -ErrorAction SilentlyContinue
        
        if ($existing -eq $chezmoi) {
            Write-Host "No changes detected between files" -ForegroundColor Green
            Get-Content $ExistingFile -Raw
            return $true
        }
        return $false
    }

    # パッチ適用
    function Apply-Patch {
        switch ($MERGE_MODE) {
            "INTERACTIVE" {
                Write-Host "Choose action:" -ForegroundColor Yellow
                Write-Host "1) Apply patch (update to chezmoi version)"
                Write-Host "2) Open merge tool"
                Write-Host "3) Keep existing version"
                Write-Host "4) Manual edit"
                Write-Host ""
                
                do {
                    $choice = Read-Host "Enter choice [1-4]"
                    switch ($choice) {
                        "1" {
                            Write-Host "Applying patch..." -ForegroundColor Blue
                            Copy-Item $ChezmoiFile $ExistingFile
                            Get-Content $ExistingFile -Raw
                            return
                        }
                        "2" {
                            Open-MergeTool
                            return
                        }
                        "3" {
                            Write-Host "Keeping existing version" -ForegroundColor Blue
                            Get-Content $ExistingFile -Raw
                            return
                        }
                        "4" {
                            Manual-Edit
                            return
                        }
                        default {
                            Write-Host "Invalid choice. Please enter 1-4." -ForegroundColor Red
                        }
                    }
                } while ($true)
            }
            "AUTO" {
                Write-Host "Auto-applying chezmoi version..." -ForegroundColor Blue
                Copy-Item $ChezmoiFile $ExistingFile
                Get-Content $ExistingFile -Raw
            }
            "FORCE" {
                Write-Host "Force-applying chezmoi version..." -ForegroundColor Blue
                Copy-Item $ChezmoiFile $ExistingFile
                Get-Content $ExistingFile -Raw
            }
        }
    }

    # マージツールを開く
    function Open-MergeTool {
        if (Get-Command code -ErrorAction SilentlyContinue) {
            Write-Host "Opening VS Code merge editor..." -ForegroundColor Blue
            & code --diff $ExistingFile $ChezmoiFile --wait
            Get-Content $ExistingFile -Raw
        } elseif (Get-Command notepad -ErrorAction SilentlyContinue) {
            Write-Host "Opening Notepad for manual editing..." -ForegroundColor Blue
            Write-Host "Files available:"
            Write-Host "  Current: $ExistingFile"
            Write-Host "  Target:  $ChezmoiFile"
            & notepad $ExistingFile
            Read-Host "Press Enter after manual editing..."
            Get-Content $ExistingFile -Raw
        } else {
            Write-Host "No suitable merge tool found" -ForegroundColor Red
            Write-Host "Available files for manual editing:"
            Write-Host "  Existing: $ExistingFile"
            Write-Host "  Chezmoi:  $ChezmoiFile"
            Read-Host "Press Enter after manual editing..."
            Get-Content $ExistingFile -Raw
        }
    }

    # 手動編集
    function Manual-Edit {
        $editor = $env:EDITOR ?? "notepad"
        Write-Host "Opening editor ($editor)..." -ForegroundColor Blue
        Write-Host "Files available:"
        Write-Host "  Current: $ExistingFile"
        Write-Host "  Target:  $ChezmoiFile"
        Write-Host ""
        
        & $editor $ExistingFile
        Get-Content $ExistingFile -Raw
    }

    # メイン処理
    if (!(Test-FilesEqual)) {
        Apply-Patch
    }

} finally {
    Cleanup
}

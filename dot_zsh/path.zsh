if [ -x /usr/libexec/path_helper ]; then
	PATH=""
	eval `/usr/libexec/path_helper -s`
fi

path=(
  # 環境ごとの実行ファイルやsymlinkの置き場所
  $HOME/.local/bin

  # dotfilesで管理する実行ファイルの置き場所
  $HOME/.local/.bin

  $HOME/.deno/bin
  $HOME/google-cloud-sdk/bin
  $HOME/workspace/depot_tools
  $path
)

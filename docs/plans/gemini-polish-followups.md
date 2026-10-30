# gemini-polish の残件

## 未確認のこと

- 有効な `GEMINI_API_KEY` での推敲。手元にキーが無く、ダミーのキーで `API_KEY_INVALID` が返るところまでしか確かめていない。
- API キーのときに、既定のモデル名 `gemini-3.8-flash-medium` を Gemini API が受け付けるか。受け付けなければ `-m` か `GEMINI_POLISH_MODEL` でモデル名を渡す。
- agy が新しいセッションで `~/.gemini/config/skills/` のスキルを読み込むか。

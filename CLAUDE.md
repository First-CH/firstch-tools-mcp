# CLAUDE.md — firstch-tools-mcp

公開リポジトリ。tools.first-ch.com の計算ロジックを MCP サーバー（npm `@first-ch/tools-mcp`）として配り、同じものを Claude Code の plugin / marketplace（`.claude-plugin/marketplace.json`・`plugins/firstch-tools/`）としても配る。**社内の情報・人名・内部 URL・内部リポジトリへのパスをこのリポジトリに書かない。**

## 構成

- `server.mjs` が MCP の入口、ツールは1機能1ファイル（`*.mjs`）。`apps.mjs` は apps.first-ch.com を呼ぶ `app_*` ツール（既定で無効）
- `plugins/firstch-tools/.mcp.json` は npm の版を `@first-ch/tools-mcp@X.Y.Z` で固定して起動する。plugin 側に実装は置かない
- 使い方・ツール一覧・プライバシーの正本は `README.md`（英日併記。ツールを足したら両方の表と `plugins/firstch-tools/README.md` を直す）

## 検査（push 前に3つとも緑）とリリース

```bash
npm ci && npm test && node e2e.mjs   # 単体＋app_* のテスト（ネットワーク不要）、stdio の疎通
```

- `.github/workflows/ci.yml` は稼働中: Node 24 でテスト・vendor チェックサム・tarball 内容・版の整合・plugin のピンを検査し、`main` への push が未公開の版なら npm Trusted Publishing で自動公開して `vX.Y.Z` タグを打つ（`README.md`「Development」）。手元で `npm publish` しない
- 版は**7か所を同時に**上げる: `package.json`・`package-lock.json`（2か所）・`server.json`（2か所）・`plugins/firstch-tools/.claude-plugin/plugin.json`・`plugins/firstch-tools/.mcp.json` のピン。1つでも違うと CI が落ちる。`server.json` の `description` は100文字以内
- 版を上げずに実装を変えた push は、tarball の内容が違えば CI が止める

## FirstCHTools（サイト側）との同期

サイト側（`FirstCHTools` の `site/<tool>/app.js`）の実装が正本で、こちらは**追従する側**。別リポジトリなので CI は相互比較できず、レビュー時の目視と各ファイル冒頭のコメントが頼り。
- アルゴリズムを変える変更はサイト側から始め、同じ変更をこちらに別コミットで反映する（こちらだけ先に変えない）
- `marp-theme.css` はサイト側の `site/marp/theme-firstch.css` とバイト一致させる（`diff` で確認。`@auto-scaling`・`@size` を消さない）
- `openapi-doc.mjs`・`lines.mjs`・`wiki-doc-lint.mjs` の「ここから〜ここまで」のコアは、サイト側の同名ツールと同一にする（照合コマンドは各ファイル冒頭）
- `vendor/jsquash-webp/` はサイト側と同じ `@jsquash/webp` の版を別々に固定している。片方だけ上げない

## 触らないもの
`vendor/` の配布物は無改変で置き直す（ライセンス文を同梱）。`ci.yml` の公開ステップと `id-token` の権限は、変更前に人へ確認する。

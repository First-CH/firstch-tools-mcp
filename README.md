# @first-ch/tools-mcp

MCP server exposing [First CH Tools](https://tools.first-ch.com)' free web-tool logic — WCAG contrast, JP character/X-weight counting, WebP conversion, JSON-LD generation, llms.txt generation, encoding/line-ending conversion, Marp Markdown→slide rendering, Japanese/English test-data generation, and text/code diffing — to AI agents such as Claude Code.

日本語版は [後半セクション](#日本語) を参照してください。

## Install

Three ways to add this server, pick whichever fits your client.

**Requires Node.js `>=18.14.1`** (all three methods below run the server via `npx`, so Node must be installed even when the MCP client itself — e.g. Claude Code's native, no-Node install — doesn't strictly require it).

### 1. npm, via the Claude Code CLI

```bash
claude mcp add firstch-tools -- npx -y @first-ch/tools-mcp
```

### 2. Claude Code plugin (also installs the same MCP server)

```
/plugin marketplace add First-CH/firstch-tools-mcp
/plugin install firstch-tools@first-ch
```

### 3. Any other MCP client (generic JSON config)

Add to your client's server config (e.g. `mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "firstch-tools": {
      "command": "npx",
      "args": ["-y", "@first-ch/tools-mcp"]
    }
  }
}
```

This server is also registered in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.First-CH/tools-mcp` (see [`server.json`](./server.json)), so registry-aware clients can discover and install it by that name too.

## Tools

| Tool | What it does | Main input |
| --- | --- | --- |
| `contrast_check` | Computes the WCAG 2.1 contrast ratio between a foreground and background color and returns AA/AAA pass/fail (normal text, large text, UI components) | `fg`, `bg` (hex, e.g. `#333333` / `333` / `fff`) |
| `count_chars` | Counts Japanese text by grapheme, breaks it down into zenkaku/hankaku, counts lines, and computes the X (Twitter) post weight (zenkaku=2, hankaku=1, URL=23 flat, limit 280) | `text` |
| `webp_convert` | Converts PNG/JPEG files (absolute paths) to WebP using the same libwebp WASM encoder (default quality 80) as the browser tool at tools.first-ch.com/webp/. Output defaults to the same directory as each input with a `.webp` extension | `paths[]` (absolute paths), `quality?` (1-100), `outputDir?` |
| `jsonld_generate` | Generates schema.org JSON-LD for `organization` / `faqpage` / `service` / `breadcrumb`. Empty fields are omitted automatically. Returns both a `json` object and a ready-to-embed `<script>` snippet | `type`, plus the matching `organization` / `faq` / `service` / `breadcrumb` object |
| `llmstxt_generate` | Generates an `llms.txt` file (per the llmstxt.org proposed format) summarizing a site for AI crawlers/agents | `siteName`, `summary?`, `notes?`, `sections?` |
| `encoding_convert` | Detects the character encoding (UTF-8 / Shift_JIS), BOM and line endings (CRLF / LF / CR) of a file or text and converts it to UTF-8. Useful for diagnosing garbled Japanese CSVs and for normalising line endings. Output is UTF-8 only — encoding *to* Shift_JIS is not supported (no standard API, and a mapping table would be required). | `base64` or `text`, `mode` (`analyze` \| `convert`), `encoding`, `newline`, `bom` |
| `marp_render` | Renders [Marp](https://marp.app) Markdown to slides. Emits a self-contained HTML file (theme CSS inlined; opens in a browser and prints one-slide-per-page) and optionally PDF. Ships a bundled Japanese theme `firstch` (firstch-design tokens: paper/ink/vermilion, IBM Plex Sans JP) used as the default theme. Marp front-matter in the Markdown (`theme:` / `paginate:` / `size:` / `<!-- _class: lead -->`) is honored. | `markdown` or `inputPath`, `theme?`, `formats?` (`html` \| `pdf`), `outputPath?`, `title?` |
| `testdata_generate` | Generates dummy data for form / CSV-import testing. `mode=records` returns names, kana readings, addresses, postal codes, emails and phone numbers as CSV/TSV/JSON/XLSX with a choice of encoding (UTF-8 / Shift_JIS), BOM and line endings. `format=xlsx` returns a real Excel workbook as base64 (or writes it to `outputPath`) — the ZIP/OOXML parts are assembled directly, with no spreadsheet dependency, and postal codes and phone numbers are written as text cells so leading zeros survive; `mode=text` returns strings of exactly n-1 / n / n+1 characters for `maxlength` boundary tests. All output is fictional (emails use the RFC 2606 `example.com` family). Passing a `seed` makes the output reproducible | `mode?`, `rows?`, `fields?`, `format?`, `locale?`, `encoding?`, `newline?`, `bom?`, `header?`, `seed?`, `preset?`, `length?`, `outputPath?` |
| `diff_check` | Compares two texts (or two files) and returns the added/removed/changed line counts plus a unified diff (`.patch`) — the same logic as the browser tool at tools.first-ch.com/diff/. Lines are matched with patience diff (lines occurring exactly once in both sides become anchors), falling back to Myers only inside anchor-less ranges. With `format=blocks` / `both`, paired changed lines are also compared at token level (runs of letters/digits are one token, CJK characters one each) and returned as `changed_parts`, so you can see *which words* changed. CRLF/CR/LF all count as the same line break; trailing-whitespace-only differences are ignored by default | `a`/`b` (text) or `pathA`/`pathB` (absolute paths), `format?` (`unified` \| `blocks` \| `both`), `context?`, `ignoreWhitespace?`, `ignoreCase?`, `words?` |

See [`server.mjs`](./server.mjs) for the exact Zod input schemas.

**PDF output (`marp_render`) needs a local Chrome/Chromium.** marp-core renders the HTML with no browser dependency (so the package stays light for `npx`); PDF is produced by driving a locally-installed Chrome/Chromium in headless mode. It is auto-detected on common paths, or set `MARP_CHROME_PATH` to the executable. If none is found, `marp_render` returns the HTML only and reports `pdf_skipped` — you can still open that HTML and print → PDF yourself (one slide per page).

## Telemetry

Nothing is logged by default. Usage is recorded **only** when you set the `FIRSTCH_TOOLS_USAGE_LOG` environment variable to a file path — each tool call then appends one JSON line (`{ ts, tool, source }`) to that local file. There is no network transmission of any kind; if the variable is unset, no file is written and no data leaves your machine.

## Web version

The same algorithms are also available as a free, no-install browser tool at **[tools.first-ch.com](https://tools.first-ch.com)** — useful when you want a UI instead of an MCP call, or want to hand a link to someone without an MCP client.

## Vendor sync (WebP codec)

`webp_convert` bundles a vendored, unmodified subset of [`@jsquash/webp`](https://github.com/jamsinclair/jSquash) v1.5.0 under [`vendor/jsquash-webp/`](./vendor/jsquash-webp/). The web version at tools.first-ch.com vendors the exact same v1.5.0 subset, so both surfaces produce identical output. Each side's CI independently verifies its vendored files against [`vendor/jsquash-webp/CHECKSUMS.sha256`](./vendor/jsquash-webp/CHECKSUMS.sha256) (see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)), so a silent, unnoticed drift between the two copies isn't possible.

## License

The package itself is licensed under [MIT](./LICENSE).

It bundles a subset of [jSquash](https://github.com/jamsinclair/jSquash)'s WebP codec under `vendor/jsquash-webp/` to power `webp_convert`, which carries its own licenses:

- The jSquash wrapper code is licensed under **Apache-2.0** — see [`vendor/jsquash-webp/LICENSE`](./vendor/jsquash-webp/LICENSE).
- The underlying libwebp codec (WASM binary and its JS glue) is licensed under **BSD-3-Clause, Copyright (c) 2010 Google Inc.** — see [`vendor/jsquash-webp/codec/LICENSE.codec.md`](./vendor/jsquash-webp/codec/LICENSE.codec.md).

Both license files are included verbatim in the published npm package, as required by their respective terms (BSD-3-Clause in particular requires the copyright notice, condition list, and disclaimer to be reproduced in binary redistributions).

## Development

```bash
npm ci
npm test        # unit tests (lib.mjs / webp.mjs / marp.mjs / testdata.mjs / diff.mjs), see test.mjs
node e2e.mjs     # stdio smoke test: spawns server.mjs, lists tools, calls a couple of handlers
```

CI runs both across Node 18.14.1 / 20 / 22, plus a vendor checksum check and a published-tarball content check — see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

---

## 日本語

`@first-ch/tools-mcp` は、[First CH Tools](https://tools.first-ch.com)（無料Webツール集）の計算ロジック — WCAGコントラスト比・日本語文字数/Xウェイト計測・WebP変換・JSON-LD生成・llms.txt生成・文字コード/改行コード変換・Marp Markdown→スライド レンダリング・テストデータ生成・テキスト/コード差分 — をAIエージェント（Claude Code等）向けMCPツールとして提供するサーバーです。

### インストール

導入経路は3通りあります。使っているクライアントに合わせて選んでください。

**Node.js `>=18.14.1` が必要です**（以下いずれの方法も `npx` 経由でサーバーを起動するため。Claude Code本体はNode不要のnativeインストールもありますが、その場合でもNodeは別途必要です）。

#### 1. npm（Claude Code CLI）

```bash
claude mcp add firstch-tools -- npx -y @first-ch/tools-mcp
```

#### 2. Claude Code plugin（同じMCPサーバーを導入）

```
/plugin marketplace add First-CH/firstch-tools-mcp
/plugin install firstch-tools@first-ch
```

#### 3. その他のMCPクライアント（汎用JSON設定）

設定ファイル（`mcp.json` / `claude_desktop_config.json` 等）に以下を追加します。

```json
{
  "mcpServers": {
    "firstch-tools": {
      "command": "npx",
      "args": ["-y", "@first-ch/tools-mcp"]
    }
  }
}
```

本サーバーは [MCP Registry](https://registry.modelcontextprotocol.io) にも `io.github.First-CH/tools-mcp` として登録済みです（[`server.json`](./server.json) 参照）。レジストリ対応クライアントはこの名前からも発見・導入できます。

### ツール一覧

| ツール | 何をするか | 主な入力 |
| --- | --- | --- |
| `contrast_check` | 文字色と背景色のWCAG 2.1コントラスト比を計算し、AA/AAA基準（通常テキスト・大テキスト・UI部品）の合否を返す | `fg`・`bg`（hex。例: `#333333` / `333` / `fff`） |
| `count_chars` | 日本語テキストを書記素単位で数え、全角/半角内訳・行数・X(Twitter)投稿ウェイト（全角=2・半角=1・URL=一律23・上限280）を返す | `text` |
| `webp_convert` | PNG/JPEG画像（絶対パス）をWebPへ変換する。tools.first-ch.com/webp/ と同一のlibwebp WASMエンコーダ（品質既定80）。出力先省略時は各入力と同じ場所に拡張子`.webp`で保存 | `paths[]`（絶対パス）・`quality?`（1-100）・`outputDir?` |
| `jsonld_generate` | schema.org準拠のJSON-LDを生成する（`organization` / `faqpage` / `service` / `breadcrumb`）。空項目は自動で省略。`json`オブジェクトと埋め込み用`<script>`スニペットの両方を返す | `type` と対応する `organization` / `faq` / `service` / `breadcrumb` オブジェクト |
| `llmstxt_generate` | AI検索・生成AI向けにサイト概要を伝える `llms.txt`（llmstxt.org提案フォーマット準拠）を生成する | `siteName`・`summary?`・`notes?`・`sections?` |
| `encoding_convert` | ファイル/テキストの文字コード（UTF-8 / Shift_JIS）・BOM有無・改行コード（CRLF / LF / CR）を判定し、UTF-8へ変換する。日本語CSVの文字化け調査、改行コードの統一に。**出力はUTF-8のみ**（Shift_JISへのエンコードは標準APIに無く変換表が必要なため非対応） | `base64` または `text`、`mode`（`analyze` \| `convert`）、`encoding`、`newline`、`bom` |
| `marp_render` | [Marp](https://marp.app) Markdown をスライドへレンダリングする。テーマCSSをインラインした自己完結HTML（ブラウザで開けて、印刷すると1スライド=1ページ）と、任意でPDFを書き出す。和文テーマ `firstch`（firstch-design トークン: 紙/墨/朱・IBM Plex Sans JP）を同梱し既定テーマにする。Markdown内の Marp フロントマター（`theme:` / `paginate:` / `size:` / `<!-- _class: lead -->`）はそのまま効く | `markdown` または `inputPath`、`theme?`、`formats?`（`html` \| `pdf`）、`outputPath?`、`title?` |
| `testdata_generate` | フォーム入力・CSV取り込みテスト用のダミーデータを生成する。`mode=records` は氏名・フリガナ・住所・郵便番号・メール・電話番号などをCSV/TSV/JSON/XLSXで返し、文字コード（UTF-8 / Shift_JIS）・BOM・改行コードを指定できる。`format=xlsx` は Excel ファイル本体を base64（または `outputPath` へ書き出し）で返す。ZIP+OOXMLを依存ライブラリなしで直接組み立てており、郵便番号・電話番号は文字列セルにするため先頭の0が消えない。`mode=text` は `maxlength` の境界値テスト用に n-1 / n / n+1 文字ちょうどの文字列を返す。生成データはすべて架空（メールは RFC 2606 の `example.com` 系）。`seed` を渡すと同じデータを再現できる | `mode?`・`rows?`・`fields?`・`format?`・`locale?`・`encoding?`・`newline?`・`bom?`・`header?`・`seed?`・`preset?`・`length?`・`outputPath?` |
| `diff_check` | 2つのテキスト（またはファイル）を比較し、追加/削除/変更の行数と unified diff（`.patch`）を返す。tools.first-ch.com/diff/ と同一ロジック。行の対応づけは patience diff（両方に1回だけ現れる行をアンカーに分割）＋アンカーの取れない範囲だけ Myers。`format=blocks` / `both` では、変更行のペアを語単位（英数字はひとかたまり・和文は1文字ずつ）でも比較し `changed_parts` として返すため「どの語が変わったか」まで取れる。CRLF/CR/LF は同じ行区切りとして扱い、行末の空白だけの差は既定で無視する | `a`/`b`（テキスト）または `pathA`/`pathB`（絶対パス）、`format?`（`unified` \| `blocks` \| `both`）、`context?`、`ignoreWhitespace?`、`ignoreCase?`、`words?` |

正確な入力スキーマ（Zod定義）は [`server.mjs`](./server.mjs) を参照してください。

**`marp_render` のPDF出力にはローカルの Chrome/Chromium が必要です。** marp-core によるHTML生成はブラウザ非依存（`npx` 導入を軽く保つため）で、PDFはローカルインストール済みの Chrome/Chromium を headless で駆動して生成します。定番パスから自動検出し、`MARP_CHROME_PATH` で実行ファイルを明示することもできます。見つからない場合は HTML のみを返し `pdf_skipped` を報告します（そのHTMLを開いて印刷→PDF保存でも1スライド=1ページで作成できます）。

### 計測（Telemetry）について

既定では何も記録しません。環境変数 `FIRSTCH_TOOLS_USAGE_LOG` にファイルパスを設定したときのみ、各ツール呼び出しごとに1行のJSON（`{ ts, tool, source }`）をそのローカルファイルへ追記します。ネットワーク送信は一切ありません（未設定であればファイルへの書き込み自体が発生せず、データが端末外に出ることはありません）。

### Web版

同一アルゴリズムを、インストール不要の無料ブラウザツールとしても公開しています: **[tools.first-ch.com](https://tools.first-ch.com)**。UIで使いたいとき・MCPクライアントを持たない相手にリンクを共有したいときはこちらをどうぞ。

### vendor同期（WebPコーデック）

`webp_convert` は [`@jsquash/webp`](https://github.com/jamsinclair/jSquash) v1.5.0 の無改変サブセットを [`vendor/jsquash-webp/`](./vendor/jsquash-webp/) 配下に同梱しています。Web版（tools.first-ch.com）も同じv1.5.0サブセットを無改変で使っており、双方が同一の出力を返します。各リポジトリのCIが独立に、自身のvendorファイルを [`vendor/jsquash-webp/CHECKSUMS.sha256`](./vendor/jsquash-webp/CHECKSUMS.sha256) に対して検証するため（[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) 参照）、両者が気づかないうちに乖離することはありません。

### ライセンス

本パッケージ自体は [MIT](./LICENSE) です。

`webp_convert` のために [jSquash](https://github.com/jamsinclair/jSquash) のWebPコーデックの一部を `vendor/jsquash-webp/` 配下に同梱しており、それぞれ別のライセンスが適用されます。

- jSquashのラッパーコード部分は **Apache-2.0** — [`vendor/jsquash-webp/LICENSE`](./vendor/jsquash-webp/LICENSE) を参照
- 内部で使われるlibwebpコーデック本体（WASMバイナリとそのJSグルーコード）は **BSD-3-Clause, Copyright (c) 2010 Google Inc.** — [`vendor/jsquash-webp/codec/LICENSE.codec.md`](./vendor/jsquash-webp/codec/LICENSE.codec.md) を参照

いずれのライセンスファイルも公開npmパッケージに原文のまま同梱しています（BSD-3-Clauseはバイナリ再配布時にも著作権表示・条件・免責事項の再掲を求めるため）。

### 開発者向け

```bash
npm ci
npm test        # ユニットテスト（lib.mjs / webp.mjs / marp.mjs）。詳細は test.mjs
node e2e.mjs     # stdio smokeテスト: server.mjsを子プロセス起動しツール一覧取得・実行を検証
```

CIはNode 18.14.1 / 20 / 22 の3系統に加え、vendorチェックサム検証・公開tarball内容検査を実行します（[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) 参照）。

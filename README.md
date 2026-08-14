# @first-ch/tools-mcp

MCP server exposing [First CH Tools](https://tools.first-ch.com)' free web-tool logic — WCAG contrast, JP character/X-weight counting, WebP conversion, JSON-LD generation, llms.txt generation, encoding/line-ending conversion, Marp Markdown→slide rendering, Japanese/English test-data generation, text/code diffing, cron-expression explanation, Base64/data-URI encoding, URL query-parameter editing, HTML entity escaping/unescaping, JSON⇄YAML conversion, px ⇄ rem/em unit conversion, colour-code conversion with alpha compositing, and MD5/SHA-1/SHA-256/SHA-384/SHA-512 hashing — to AI agents such as Claude Code.

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
| `cron_explain` | Explains a cron expression in plain language and returns the upcoming run times — the same logic as the browser tool at tools.first-ch.com/cron/. Parsing follows Vixie cron (`crontab(5)`): ranges, steps, lists, `JAN-DEC` / `SUN-SAT` names and the `@daily`-style shorthands; six fields means the first one is seconds (node-cron / Spring style). `warnings` call out the traps — day-of-month and day-of-week are OR'd (not AND'd) when both are restricted, `*/n` that does not divide its range evenly is not a uniform interval, and impossible dates such as February 30th never fire. Run times are found on the wall clock of the target time zone and converted back to real instants, so they stay correct across daylight-saving transitions | `expression`, `timeZone?` (IANA, default `UTC`), `count?` (default 5, max 100), `from?` (ISO 8601) |
| `base64_encode` | Encodes text or a file as Base64 and a `data:` URI, and returns ready-to-paste HTML `<img>` / CSS `background-image` snippets — the same logic as the browser tool at tools.first-ch.com/base64/. With `mode="decode"` it turns Base64 or a data URI back into bytes, writing them to `outputPath` when given. For SVG it returns both encodings and defaults to the shorter one (percent-encoding beats Base64, which always inflates by ~33%), always escaping `& " < > # %`, whitespace and non-ASCII so the URI drops straight into an HTML attribute or a CSS `url("…")`. Decoding accepts standard or URL-safe Base64, tolerates whitespace and newlines, does not require padding, and trusts the actual magic numbers (PNG/JPEG/GIF/WebP/ico/PDF/zip/woff/woff2/SVG) over the MIME type a data URI claims | `mode?` (`encode` default / `decode`), `text?` or `path?`, `base64?`, `outputPath?`, `urlSafe?`, `wrap?` (76 for MIME), `dataUri?`, `mimeType?`, `snippets?` |
| `url_params` | Breaks a URL's query string into keys and values, edits it (`set` / `remove` / `utm` / `removeTracking` / `sort`) and rebuilds it — the same logic as the browser tool at tools.first-ch.com/url/. Values come back decoded (`%XX` to characters, `+` to a space), and parameters you did not touch are written back byte-for-byte, so calling it with nothing but a `url` returns exactly what you passed in — signed URLs survive a round trip. `reencode` normalises the whole query with `encodeURIComponent` rules instead. `warnings` flag duplicate keys, unencoded spaces and non-ASCII, broken `%XX`, `+` being read as a space, mixed-case UTM values, a missing utm_source/utm_medium, passwords in the URL, credential-looking keys and URLs over 2,000 characters. Relative paths and broken percent-encoding are parsed as far as they can be read instead of throwing. `mode="encode"` / `"decode"` converts a bare string instead (`scheme`: `component` / `uri` / `form`). No network access — the URL is never fetched | `url?`, `mode?` (`parse` default / `encode` / `decode`), `text?`, `scheme?`, `set?`, `remove?`, `utm?`, `removeTracking?`, `sort?`, `reencode?`, `spaceAsPlus?` |
| `html_escape` | Escapes `< > & " '` into HTML entities, or with `mode="unescape"` turns entities such as `&amp;`, `&#39;` and `&#x3042;` back into characters — the same logic as the browser tool at tools.first-ch.com/html-escape/. Escaping handles `&` first, so a second pass never double-escapes what the first pass produced; pick named or numeric references (`numeric`), decide whether quotes are escaped (`quotes`, mandatory inside an attribute value) and whether `'` is written as `&#39;` or `&apos;` (`apos` — `&apos;` does not exist in HTML 4.01), and encode non-ASCII characters as references (`nonAscii`) when the charset may not survive the pipeline. Unescaping covers all 252 named references from HTML 4.01 plus decimal and hexadecimal ones, maps C1-range references such as `&#128;` to their Windows-1252 characters as the spec requires, and leaves unknown names, out-of-range numbers and semicolon-less references untouched rather than guessing. `notes` reports already-escaped input, bare `&`, missing semicolons, unknown entity names and no-break spaces (U+00A0) | `mode?` (`escape` default / `unescape`), `text?` or `path?`, `outputPath?`, `quotes?`, `apos?`, `numeric?`, `nonAscii?` (`none` / `named` / `decimal` / `hex`) |
| `json_to_yaml` | Converts JSON to formatted YAML, and `yaml_to_json` converts back — the same logic as the browser tool at tools.first-ch.com/json-yaml/, with no YAML dependency (the parser and writer are implemented in this package). Choose the indent width, the quoting style (`quote`), how null is written (`nullStyle`), whether multi-line strings become `|` blocks (`block`), whether keys are sorted (`sortKeys`) and whether the output starts with `---` (`docStart`). Strings another parser could read as a different type — `yes` / `no` / `on` / `off`, `0755`, `12:30`, `2026-08-12`, anything numeric-looking — plus strings with surrounding whitespace or a leading `-` / `*` / `#` are quoted automatically, so the output means the same thing to a YAML 1.1 parser such as PyYAML. JSON containing comments, trailing commas, single quotes or unquoted keys (as in `tsconfig.json`) is read and converted, with `notes` saying it is not valid JSON (`relaxed=false` rejects it strictly instead) | `text?` or `path?`, `outputPath?`, `indent?` (1-8), `quote?` (`auto` / `single` / `double`), `nullStyle?` (`null` / `tilde` / `empty`), `block?`, `sortKeys?`, `docStart?`, `relaxed?` |
| `yaml_to_json` | Converts YAML to JSON — useful for turning docker-compose, GitHub Actions, Kubernetes and CI config into something a program can handle, and for checking that a file parses at all. A syntax error is returned as an error naming the line, the column, the cause and the fix, with the two surrounding lines quoted and a `^` under the column. Multiple documents (`---`) become a single JSON array, and anchors (`&name`), aliases (`*name`) and merge keys (`<<`) are expanded because JSON has no references (`notes` says when that happened). Scalars follow the YAML 1.2 core schema, so `yes` / `no` / `on` / `off` / `NO` stay strings — but `notes` flags them, along with `0755` (decimal 755, not octal), `12:30` (750 in YAML 1.1's base 60), date-like values, duplicate keys and integers beyond 2^53. Supports block mappings and sequences, flow style, quoted scalars (multi-line, with escapes), block scalars (`|` `>` with chomping and an explicit indent), tags (`!!str` `!!int` `!!float` `!!bool` `!!null` `!!binary`) and comments; only the explicit `? key` notation is unsupported | `text?` or `path?`, `outputPath?`, `indent?` (0-8 or `"tab"`; 0 minifies), `sortKeys?`, `ascii?` |
| `px_rem_convert` | Converts CSS lengths between px, rem, em and pt — the same logic as the browser tool at tools.first-ch.com/px-rem/. Pass `value` for a single conversion and you get px/rem/em/pt, a ready-to-paste `font-size` line and the scale of common font sizes (12–64px, one row per size with its typical use); pass `css` or `path` and the whole stylesheet is rewritten (`direction`: `px2rem` default / `px2em` / `rem2px` / `em2px`). The bulk pass never touches comments, strings (`content: "10px"`), the contents of `url()` or digits inside identifiers such as `--size-16px`, and by default keeps hairlines in px (`minPx=2`, because a 1px border in rem varies in thickness between devices) and leaves the conditions of `@media` and other at-rules alone (`skipMedia`), which is where breakpoints live. `ignoreProps` excludes properties by prefix, `zeroUnitless` writes a bare `0`. The root can be given as a percentage (`root="62.5%"` → 10px, read against the 16px browser default), and `notes` reports rounding, skipped values and the accessibility cost of the 62.5% trick | `value?` (`24` / `"1.5rem"`) or `css?` / `path?`, `unit?`, `outputPath?`, `direction?`, `root?`, `parent?`, `precision?` (`auto` or 0-6), `minPx?`, `zeroUnitless?`, `skipMedia?`, `ignoreProps?`, `scale?` |
| `color_convert` | Converts a colour between HEX, RGB, HSL and OKLCH and builds the `rgba()` / `hsla()` / 8-digit HEX code at any alpha — the same logic as the browser tool at tools.first-ch.com/color/. Input can be HEX (3/4/6/8 digits), `rgb()`, `hsl()`, `hwb()`, `oklch()`, `oklab()`, one of the 148 CSS named colours or `transparent`, in either the legacy comma form or the modern slash form, with angles in `deg` / `grad` / `rad` / `turn`. Pass a `background` and `flattened` returns the colour that actually reaches the screen once the transparency is composited over it (`foreground × α + background × (1−α)`) — what you need to turn a semi-transparent layer from a mockup into a solid HEX. It also returns the WCAG 2.1 contrast against white and black, an `alpha_table` stepped by `step`%, and an 11-step lightness `palette` (50–950) that keeps the hue and chroma. An OKLCH value outside sRGB has its chroma lowered by binary search until it fits, keeping the lightness and hue, because clipping the RGB channels would shift the hue; `notes` says when that happened, when the colour matches a named colour exactly, and when it is a neutral grey | `color`, `alpha?` (0-1, 0-100 or `"50%"`), `background?` (default `#ffffff`), `syntax?` (`modern` default / `legacy`), `uppercase?`, `alphaPercent?`, `step?` (1-50, default 10), `alphaTable?`, `palette?` |
| `hash_generate` | Computes the MD5, SHA-1, SHA-256, SHA-384 and SHA-512 digests of a string or a file in one call — the same logic as the browser tool at tools.first-ch.com/hash/. Pass `expected` and the digest is verified against it: the algorithm is inferred from the length, and `verification` says whether it matched. `expected` takes command output as-is — the `<digest>␣␣<filename>` form from `sha256sum`, the output of `shasum -a 256`, the `SHA256 (file) = …` form, a `sha256:` prefix, colon-separated hex, Base64 and base64url are all understood. Output is lower-case hex by default, or `HEX` / `base64` / `base64url`. For `text`, `newline` (`lf` / `crlf`) and `bom` control the exact bytes that get hashed, so a digest produced from a Windows file can be reproduced (the encoding is always UTF-8); neither applies to `path`, which is hashed byte for byte and streamed in a single pass when large. `notes` warns that MD5 and SHA-1 are broken for collision resistance and that a plain digest is not password storage | `text?` or `path?`, `algorithms?` (default `["md5","sha1","sha256","sha512"]`), `format?` (`hex` default / `HEX` / `base64` / `base64url`), `newline?`, `bom?`, `expected?` |

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
npm test        # unit tests (lib.mjs / webp.mjs / marp.mjs / testdata.mjs / diff.mjs / cron.mjs), see test.mjs
node e2e.mjs     # stdio smoke test: spawns server.mjs, lists tools, calls a couple of handlers
```

CI runs both across Node 18.14.1 / 20 / 22, plus a vendor checksum check and a published-tarball content check — see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

---

## 日本語

`@first-ch/tools-mcp` は、[First CH Tools](https://tools.first-ch.com)（無料Webツール集）の計算ロジック — WCAGコントラスト比・日本語文字数/Xウェイト計測・WebP変換・JSON-LD生成・llms.txt生成・文字コード/改行コード変換・Marp Markdown→スライド レンダリング・テストデータ生成・テキスト/コード差分・Cron式の解説・Base64/Data URI変換・URLパラメータの分解/編集/再構築・HTML特殊文字のエスケープ/エンティティのデコード・JSON⇄YAMLの相互変換・px⇄rem/emの単位換算とCSSの一括変換・カラーコードの相互変換とアルファ透過の合成・MD5/SHA-1/SHA-256/SHA-384/SHA-512のハッシュ生成と照合 — をAIエージェント（Claude Code等）向けMCPツールとして提供するサーバーです。

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
| `cron_explain` | Cron式を人間向けの文へ読み下し、次回からの発火日時を返す。tools.first-ch.com/cron/ と同一ロジック。解釈は Vixie cron（`crontab(5)`）準拠で、範囲・ステップ・列挙・`JAN-DEC` / `SUN-SAT` の名前・`@daily` 等の省略記法に対応し、6フィールドのときは先頭を秒として扱う（node-cron / Spring 形式）。誤りやすい点は `warnings` で知らせる（「日」と「曜日」の両方指定は AND ではなく OR、範囲を割り切らない `*/n` は等間隔にならない、2月30日のような存在しない日付は発火しない）。発火日時はタイムゾーンの壁時計上で求めてから実時刻へ戻すため、夏時間のある地域でもずれない | `expression`、`timeZone?`（IANA名・既定 `UTC`）、`count?`（既定5・最大100）、`from?`（ISO 8601） |
| `base64_encode` | テキストやファイルを Base64・`data:` URI へ変換し、そのまま貼れる HTML `<img>` / CSS `background-image` のスニペットも返す。tools.first-ch.com/base64/ と同一ロジック。`mode="decode"` では Base64 や data URI を元のバイト列へ戻し、`outputPath` を渡せばファイルとして書き出す。SVGは両方のエンコードを返して短い方を既定にし（base64は必ず約1.33倍になるためパーセントエンコードの方が小さい）、`& " < > # %` と空白・非ASCIIを必ずエスケープするのでHTML属性にもCSSの `url("…")` にもそのまま貼れる。デコードは標準/URLセーフのどちらでも、空白・改行混じりでも、パディングが欠けていても読み取り、data URI が名乗るMIMEタイプより実際のマジックナンバー（PNG/JPEG/GIF/WebP/ico/PDF/zip/woff/woff2/SVG）から判定した種類を優先する | `mode?`（既定 `encode` / `decode`）、`text?` または `path?`、`base64?`、`outputPath?`、`urlSafe?`、`wrap?`（MIMEは76）、`dataUri?`、`mimeType?`、`snippets?` |
| `url_params` | URLのクエリ文字列をキーと値へ分解し、編集（`set` / `remove` / `utm` / `removeTracking` / `sort`）して再構築する。tools.first-ch.com/url/ と同一ロジック。値はデコードして返し（`%XX` を元の文字へ、`+` を半角スペースへ）、触っていないパラメータは生の文字列のまま書き戻すため、`url` だけを渡した場合の出力は入力と1バイトも変わらない（署名付きURLを通しても壊れない）。`reencode` を立てると全体を `encodeURIComponent` の規則へ正規化する。`warnings` では重複キー・未エンコードのスペースや非ASCII・壊れた `%XX`・`+` のスペース解釈・UTM値の大文字混在・utm_source/utm_medium の片落ち・URL内のパスワード・トークンらしきキー・2000文字超を知らせる。相対パスや壊れたパーセントエンコードでも例外にせず読める範囲まで分解する。`mode="encode"` / `"decode"` では文字列単体を変換する（`scheme`: `component` / `uri` / `form`）。URLへのアクセスは行わない | `url?`、`mode?`（既定 `parse` / `encode` / `decode`）、`text?`、`scheme?`、`set?`、`remove?`、`utm?`、`removeTracking?`、`sort?`、`reencode?`、`spaceAsPlus?` |
| `html_escape` | テキスト中の `< > & " '` をHTMLエンティティへ変換し、`mode="unescape"` では `&amp;` `&#39;` `&#x3042;` などの文字参照を元の文字へ戻す。tools.first-ch.com/html-escape/ と同一ロジック。エスケープは `&` を最初に処理するため、1回目の出力をもう一度通しても二重エスケープにならない。名前付きと数値文字参照の切り替え（`numeric`）、引用符を変換するか（`quotes`・属性値へ入れるなら必須）、`'` を `&#39;` と `&apos;` のどちらで書くか（`apos`・`&apos;` はHTML 4.01に無い）、非ASCII文字を参照にするか（`nonAscii`・文字コードが伝わらない経路への保険）を選べる。デコードはHTML 4.01の名前付き文字参照252個すべてと10進/16進に対応し、`&#128;` のようなC1領域の参照は仕様どおり Windows-1252 の文字へ読み替え、知らない名前・範囲外の数値・セミコロン無しの参照は推測で変換せずそのまま残す。`notes` ではすでにエスケープ済みの入力・裸の `&`・セミコロンの閉じ忘れ・知らないエンティティ名・ノーブレークスペース（U+00A0）の混入を知らせる | `mode?`（既定 `escape` / `unescape`）、`text?` または `path?`、`outputPath?`、`quotes?`、`apos?`、`numeric?`、`nonAscii?`（`none` / `named` / `decimal` / `hex`） |
| `json_to_yaml` | JSONをYAMLへ変換して整形する（逆向きは `yaml_to_json`）。tools.first-ch.com/json-yaml/ と同一ロジックで、YAMLの解析・生成もこのパッケージ内に実装しており外部のYAMLライブラリには依存しない。インデント幅・引用符の付け方（`quote`）・nullの書き方（`nullStyle`）・複数行文字列をブロックスカラー `|` で書くか（`block`）・キーを名前順に並べるか（`sortKeys`）・先頭に `---` を付けるか（`docStart`）を選べる。別の型に読まれうる文字列（`yes` / `no` / `on` / `off`・`0755`・`12:30`・`2026-08-12`・数値に見える文字列）、前後に空白がある文字列、`-` / `*` / `#` で始まる文字列は自動で引用符を付けるので、YAML 1.1 のパーサ（PyYAMLなど）に渡しても意味が変わらない。コメント・末尾カンマ・シングルクォート・引用符なしのキーを含むJSON（`tsconfig.json` など）も読み取って変換し、JSONとしては不正であることを `notes` で知らせる（`relaxed=false` で厳密に拒否できる） | `text?` または `path?`、`outputPath?`、`indent?`（1-8）、`quote?`（`auto` / `single` / `double`）、`nullStyle?`（`null` / `tilde` / `empty`）、`block?`、`sortKeys?`、`docStart?`、`relaxed?` |
| `yaml_to_json` | YAMLをJSONへ変換する。docker-compose・GitHub Actions・Kubernetes・CIの設定をプログラムから扱える形へ読み替えるときや、構文が通るかを確かめるときに使う。構文エラーは「何行何桁・原因・直し方」と前後2行の抜き出し（桁を指す `^` つき）をエラーとして返す。複数ドキュメント（`---`）はJSONの配列1つにまとめ、アンカー `&名前`・エイリアス `*名前`・マージキー `<<` はJSONに参照の仕組みが無いため展開する（展開したことは `notes` で知らせる）。スカラーの解釈は YAML 1.2 core schema なので `yes` / `no` / `on` / `off` / `NO` は文字列のままだが、`notes` でそれを知らせる。`0755`（8進数ではなく10進の755になる）・`12:30`（YAML 1.1では60進数の750）・日付に見える値・キーの重複・2の53乗を超える整数も同様。ブロックマップ/シーケンス・フロー表記・引用スカラー（複数行・エスケープ）・ブロックスカラー（`|` `>` と chomping・明示インデント）・タグ（`!!str` `!!int` `!!float` `!!bool` `!!null` `!!binary`）・コメントに対応し、未対応は「`? キー`」の明示キー記法のみ | `text?` または `path?`、`outputPath?`、`indent?`（0-8 または `"tab"`。0で1行）、`sortKeys?`、`ascii?` |
| `px_rem_convert` | CSSの長さの単位を px ⇄ rem / em / pt で換算する。tools.first-ch.com/px-rem/ と同一ロジック。`value` を渡すと1つの値の換算になり、px・rem・em・pt の値、そのまま貼れる `font-size` の1行、よく使うフォントサイズのスケール表（12〜64pxの15段・用途の目安つき）を返す。`css` / `path` を渡すとCSS全体の一括変換になる（`direction`: 既定 `px2rem` / `px2em` / `rem2px` / `em2px`）。一括変換ではコメント・文字列（`content: "10px"`）・`url()` の中身と、`--size-16px` のように識別子の一部になっている数字は書き換えない。既定は `minPx=2` で1pxの罫線を残し（remにすると環境によって太さがばらつくため）、ブレークポイントが書かれる `@media` などアットルールの条件も変換しない（`skipMedia`）。`ignoreProps` は前方一致でプロパティを除外し、`zeroUnitless` は 0 を単位なしで書き出す。ルートは `root="62.5%"` のようにパーセントでも指定でき（ブラウザ既定16pxに対する割合として10pxと読む）、丸めが起きたこと・変換しなかった箇所・62.5%テクニックのアクセシビリティ上の副作用は `notes` で返る | `value?`（`24` / `"1.5rem"`）または `css?` / `path?`、`unit?`、`outputPath?`、`direction?`、`root?`、`parent?`、`precision?`（`auto` または 0-6）、`minPx?`、`zeroUnitless?`、`skipMedia?`、`ignoreProps?`、`scale?` |
| `color_convert` | 色のコードを HEX / RGB / HSL / OKLCH で相互変換し、アルファ付きの `rgba()` / `hsla()` / 8桁HEX を作る。tools.first-ch.com/color/ と同一ロジック。入力は HEX（3/4/6/8桁）・`rgb()`・`hsl()`・`hwb()`・`oklch()`・`oklab()`・CSSの名前付き色（148色）・`transparent` に対応し、旧記法のカンマ区切りと新記法のスラッシュ区切り、角度の単位（`deg` / `grad` / `rad` / `turn`）も読む。`background` を渡すと、透過色をその背景の上に重ねたときに実際に見える色（`前景×α + 背景×(1−α)`）を `flattened` で返すので、デザインカンプの半透明レイヤーを実装で不透明なHEXへ置き換えるときに使える。あわせて白・黒とのWCAG 2.1コントラスト比、`step`%刻みの `alpha_table`、色相と彩度を保ったまま明度だけを50〜950の11段に振った `palette` を返す。sRGBの範囲外のOKLCHは、RGBを切り詰めると色相までずれるため、明度と色相を保ったまま彩度だけを二分探索で下げて収める（収めたこと・名前付き色と完全一致したこと・無彩色であることは `notes` で知らせる） | `color`、`alpha?`（0〜1・0〜100・`"50%"`）、`background?`（既定 `#ffffff`）、`syntax?`（既定 `modern` / `legacy`）、`uppercase?`、`alphaPercent?`、`step?`（1〜50・既定10）、`alphaTable?`、`palette?` |
| `hash_generate` | テキストまたはファイルの MD5・SHA-1・SHA-256・SHA-384・SHA-512 ハッシュ値を一度に算出する。tools.first-ch.com/hash/ と同一の仕様。`expected` に期待値を渡すと桁数から対象のアルゴリズムを判定して照合し、一致したかどうかを `verification` で返す。`expected` はコマンドの出力をそのまま渡せる（`sha256sum` の `<ハッシュ値>␣␣<ファイル名>`・`shasum -a 256` の出力・`SHA256 (file) = …`・`sha256:` のような接頭辞・コロン区切りの16進・Base64 / base64url）。出力は既定が16進の小文字で、`HEX` / `base64` / `base64url` も選べる。`text` では `newline`（`lf` / `crlf`）と `bom` で実際にハッシュへ渡すバイト列を決められるので、Windowsで作られたファイルの値も再現できる（文字コードはUTF-8固定）。`path` にはどちらも影響せず中身をそのまま読み、大きなファイルは1パスのストリームで処理する。MD5とSHA-1が衝突耐性を破られていること・ハッシュ値をそのままパスワード保存に使ってはいけないことは `notes` で知らせる | `text?` または `path?`、`algorithms?`（既定 `["md5","sha1","sha256","sha512"]`）、`format?`（既定 `hex` / `HEX` / `base64` / `base64url`）、`newline?`、`bom?`、`expected?` |

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

# First CH Tools (Claude plugin)

This plugin adds the **First CH Tools** MCP server to Claude. It exposes the same logic as the free browser tools at [tools.first-ch.com](https://tools.first-ch.com) as MCP tools, aimed at everyday web-production and development work.

## What it does

The server provides tools for, among others:

- **Web and accessibility checks** — WCAG 2.1 contrast ratio, px ⇄ rem/em conversion, HEX/RGB/HSL/OKLCH colour conversion, aspect-ratio sizing
- **SEO and AI-crawler files** — schema.org JSON-LD, `llms.txt`, `robots.txt` with AI-crawler presets, URL parameter editing, URL slugs from Japanese titles
- **Japanese text** — character and X (Twitter) post-weight counting, full-width ⇄ half-width conversion, Japanese era ⇄ Western date conversion, encoding and line-ending detection/conversion (UTF-8 / Shift_JIS)
- **Images and documents** — PNG/JPEG → WebP conversion, Marp Markdown → slides (HTML, optional PDF), QR codes, HTML → Markdown
- **Developer utilities** — JSON ⇄ YAML, CSV/TSV ⇄ JSON, Markdown tables, SQL formatting, text/code diffing, cron explanation, Base64/data URIs, HTML escaping, hashing, JWT decoding, User-Agent parsing, UUID/ULID, Unix time, IP/CIDR calculation, business-day date calculation, case conversion, test data generation

The full, current tool list with inputs is in the [repository README](https://github.com/First-CH/firstch-tools-mcp#tools).

## Installation

In Claude Code:

```
/plugin marketplace add First-CH/firstch-tools-mcp
/plugin install firstch-tools@first-ch
```

## Requirements

- **Node.js 24 or later.** The plugin starts the server with `npx -y @first-ch/tools-mcp@<version>` (the version is pinned in this plugin's `.mcp.json`), so Node.js must be installed even if your Claude client itself does not need it.
- The server runs as a **local stdio process** on your machine, so it needs a Claude environment that can launch local MCP servers, such as Claude Code.
- PDF output from `marp_render` additionally needs a locally installed Chrome/Chromium; without one, it returns HTML only.

## Data handling

- **All processing happens locally on your machine.** The tools do not send your input to any server; nothing leaves your machine during a tool call.
- The server makes no network requests of its own. Network access happens only when `npx` downloads the `@first-ch/tools-mcp` package from the npm registry at startup, and in the `marp_render` PDF case noted below. The package is published from this repository through npm Trusted Publishing.
- **No usage data is collected by default.** Only if you set the `FIRSTCH_TOOLS_USAGE_LOG` environment variable to a file path does each tool call append one line (`{ ts, tool, source }` — timestamp, tool name and the fixed value `mcp`) to that local file. Tool inputs are not recorded, and nothing is transmitted.
- Some tools write their results to local files: `webp_convert` saves `.webp` files next to the inputs (or to `outputDir`), and several tools write to an `outputPath` when you pass one.
- `marp_render` PDF output is rendered by your local Chrome/Chromium, which loads any remote images referenced in your Markdown, as a browser would.

## License

MIT. The bundled WebP codec carries its own licenses (Apache-2.0 and BSD-3-Clause); see the [repository README](https://github.com/First-CH/firstch-tools-mcp#license).

## Publisher

First CH LLC — [first-ch.com](https://first-ch.com)

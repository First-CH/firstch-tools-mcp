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

## Where it works

**Claude Code** (and Cowork on the desktop) only. The server is a local stdio process started with `npx`, and the Claude chat apps (claude.ai web, desktop chat and mobile) ignore local MCP servers, so installing the plugin there provides nothing.

## Requirements

- **Node.js 24 or later.** The plugin starts the server with `npx -y @first-ch/tools-mcp@<version>` (the version is pinned in this plugin's `.mcp.json`), so Node.js must be installed even if your Claude client itself does not need it. Older Node versions print an `EBADENGINE` warning, and refuse to start if npm's `engine-strict` is enabled.
- PDF output from `marp_render` additionally needs a locally installed Chrome/Chromium; without one, it returns HTML only.

## Example prompts

1. **Contrast check** — "Check whether #767676 text on a #ffffff background passes WCAG AA and AAA."
   Claude calls `contrast_check` and reports the ratio (4.54:1): AA passes for normal text, AAA fails for normal text (passes for large text).
2. **Structured data** — "Create FAQPage JSON-LD for these two questions: 'Do you build WordPress sites?' — 'Yes.' and 'How long does a site take?' — 'About a month.'"
   Claude calls `jsonld_generate` and returns the JSON-LD object plus a ready-to-paste `<script type="application/ld+json">` snippet.
3. **Image optimisation** — "Convert /Users/me/site/images/hero.png to WebP at quality 75."
   Claude calls `webp_convert`, writes `/Users/me/site/images/hero.webp` next to the original and reports the size saving. If `hero.webp` already exists it stops with an error instead of overwriting it, unless you ask it to overwrite.

## Data handling

- **The plugin collects nothing and sends nothing to First CH or anyone else.** The tools process the input you give them on your machine and return the result to Claude.
- **Network access** happens only (1) when `npx` downloads `@first-ch/tools-mcp` and its dependencies from the npm registry at startup, and (2) when you call `marp_render` with `allowRemote: true`, in which case your local Chrome/Chromium fetches the remote images and stylesheets that your own Markdown references (those URLs reach their hosts). By default `marp_render` loads no web fonts, keeps emoji as text, strips remote `@import`s from the built-in themes and starts Chrome with network access blocked. If you later open an HTML file it produced in a browser, that browser loads any remote images your Markdown links to.
- **Files**: tools read only the paths you pass (`path`, `inputPath`, `paths`, …). Tools with `outputPath`/`outputDir`, plus `webp_convert` (next to the input by default) and `marp_render` (next to `inputPath`, or in `<OS temp dir>/firstch-tools-mcp/` when no path is given), write result files. **Existing files are never overwritten unless you pass `overwrite: true`.** Written files are yours; the server does not delete them. These tools are annotated `readOnlyHint: false`, `destructiveHint: true`; all others are `readOnlyHint: true`.
- **No usage data is collected by default.** Only if you set the `FIRSTCH_TOOLS_USAGE_LOG` environment variable to a file path does each tool call append one line (`{ ts, tool, source }` — timestamp, tool name and the fixed value `mcp`) to that local file. Tool inputs are not recorded, and nothing is transmitted.
- Chrome/Chromium for PDFs runs with its sandbox enabled. Only in environments where the sandbox cannot start (for example as root in a container) can you opt out with `MARP_CHROME_NO_SANDBOX=1`.

Details: [PRIVACY.md](./PRIVACY.md).

## Support

- Bugs and questions: [GitHub Issues](https://github.com/First-CH/firstch-tools-mcp/issues)
- Security concerns or anything you'd rather not post publicly: the contact form at [first-ch.com](https://first-ch.com/#contact)

## License

MIT. The bundled WebP codec carries its own licenses (Apache-2.0 and BSD-3-Clause); see the [repository README](https://github.com/First-CH/firstch-tools-mcp#license).

## Publisher

First CH LLC — [first-ch.com](https://first-ch.com)

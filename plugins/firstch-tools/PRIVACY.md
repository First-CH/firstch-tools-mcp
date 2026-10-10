# Privacy policy — First CH Tools (Claude plugin / `@first-ch/tools-mcp`)

Publisher: First CH LLC (First CH合同会社) — [first-ch.com](https://first-ch.com)
Last updated: 2026-10-10

## What we collect

Nothing. The plugin runs the `@first-ch/tools-mcp` server as a local process on your machine. It has no telemetry, no analytics and no account, and it does not send your input, results or any identifier to First CH LLC or to any third party.

## How your data is used

The tools process only what you (or Claude, on your instruction) pass to them — text, file paths, colours, CSV, tokens and so on — on your machine, and return the result to Claude. Nothing is stored by the server after the call returns, except the result files described below.

## Files on your machine

- Tools read only the file paths you pass to them.
- Tools that take `outputPath`/`outputDir`, plus `webp_convert` and `marp_render`, write result files to the path you choose or, for `marp_render` without a path, to `<OS temp dir>/firstch-tools-mcp/`. They never overwrite an existing file unless you pass `overwrite: true`. The server does not delete these files; they are yours to keep or remove.
- If you set the `FIRSTCH_TOOLS_USAGE_LOG` environment variable, each tool call appends one line (timestamp, tool name and the fixed value `mcp`) to the local file you choose. Inputs are not recorded and the file is never transmitted. If you do not set it, nothing is written.

## Network access

- At startup, `npx` downloads the package and its dependencies from the npm registry (subject to npm's own privacy policy).
- `marp_render` makes no network requests by default. Only when you pass `allowRemote: true` does your local Chrome/Chromium fetch the remote images and stylesheets that your Markdown references, so those URLs reach their hosts.
- No other tool makes network requests.

## Retention

The server keeps nothing. Result files and the optional usage log stay on your machine until you delete them.

## Contact

[GitHub Issues](https://github.com/First-CH/firstch-tools-mcp/issues), or the contact form at [first-ch.com](https://first-ch.com/#contact). First CH LLC's general privacy policy for its website and enquiries: [first-ch.com/privacy/](https://first-ch.com/privacy/).

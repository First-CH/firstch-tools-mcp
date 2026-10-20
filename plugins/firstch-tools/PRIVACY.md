# Privacy policy — First CH Tools (Claude plugin / `@first-ch/tools-mcp`)

Publisher: First CH LLC (First CH合同会社) — [first-ch.com](https://first-ch.com)
Last updated: 2026-10-21

## Two kinds of tools

- **Local tools** (every tool whose name does not start with `app_`) run inside the `@first-ch/tools-mcp` process on your machine. They do not send your input, results or any identifier to First CH LLC or to any third party.
- **`app_*` tools** call the web apps at [apps.first-ch.com](https://apps.first-ch.com), which First CH LLC operates. **Each call sends the tool's input to apps.first-ch.com** (see below). Only these tools do that, and only when Claude calls them.

## What we collect

- The plugin has no telemetry, no analytics and no account.
- **Local tools: nothing.**
- **`app_*` tools:** the input you (or Claude, on your instruction) pass — a URL, domain or host name, DKIM selector, User-agent name, record type, or, for `app_tone_check` and `app_lp_persona_check`, the text and industry — is sent to apps.first-ch.com together with the request itself (your public IP address and the request headers, with the User-Agent `first-ch-tools-mcp/<version>`). apps.first-ch.com processes the request and returns the result. It does **not** store the input or the result. The IP address is used only for short-lived, in-memory per-IP rate limits and is not stored. For the two AI apps, apps.first-ch.com records only the date and the total number of AI calls that day (no text, no IP) to enforce a daily cap.

## How your data is used

- Local tools process only what is passed to them — text, file paths, colours, CSV, tokens and so on — on your machine, and return the result to Claude. Nothing is stored after the call returns, except the result files described below.
- `app_*` tools: apps.first-ch.com uses the input only to produce the result of that call. Apps that check a website fetch that site (and, for some apps, its robots.txt, CSS, feeds, images or linked pages) from First CH's server, so that site sees a request from apps.first-ch.com; DNS, RDAP and certificate checks query public DNS resolvers, registries and the target host. `app_tone_check` and `app_lp_persona_check` pass the text to Cloudflare Workers AI, a language model run by Cloudflare. apps.first-ch.com is hosted on Cloudflare, which handles requests under its own terms.

## Files on your machine

- Tools read only the file paths you pass to them.
- Tools that take `outputPath`/`outputDir`, plus `webp_convert` and `marp_render`, write result files to the path you choose or, for `marp_render` without a path, to `<OS temp dir>/firstch-tools-mcp/`. They never overwrite an existing file unless you pass `overwrite: true`. The server does not delete these files; they are yours to keep or remove.
- If you set the `FIRSTCH_TOOLS_USAGE_LOG` environment variable, each tool call appends one line (timestamp, tool name and the fixed value `mcp`) to the local file you choose. Inputs are not recorded and the file is never transmitted. If you do not set it, nothing is written.

## Network access

- At startup, `npx` downloads the package and its dependencies from the npm registry (subject to npm's own privacy policy).
- `marp_render` makes no network requests by default. Only when you pass `allowRemote: true` does your local Chrome/Chromium fetch the remote images and stylesheets that your Markdown references, so those URLs reach their hosts.
- Each `app_*` tool sends one HTTPS request to apps.first-ch.com (or to `FIRSTCH_APPS_BASE_URL`, if you set it for testing).
- No other tool makes network requests.

## Retention

The local server keeps nothing. Result files and the optional usage log stay on your machine until you delete them. apps.first-ch.com keeps no input or result from `app_*` calls; the only thing it keeps is the daily count of AI calls described above.

## Contact

[GitHub Issues](https://github.com/First-CH/firstch-tools-mcp/issues), or the contact form at [first-ch.com](https://first-ch.com/#contact). First CH LLC's general privacy policy for its website and enquiries: [first-ch.com/privacy/](https://first-ch.com/privacy/).

> `app_*` tools are off by default and only appear when `FIRSTCH_ENABLE_APPS=1` is set; without it, nothing leaves your machine.

# dsh-gui-auth-url

[![CI](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0--0-6f42c1)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/NingYuanLee/dsh-gui-auth-url?style=social)](https://github.com/NingYuanLee/dsh-gui-auth-url/stargazers)

> Third-party community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Not an official DeepSeek product. MIT licensed.

English | [中文](README-zh.md) | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

Expose the running DeepSeek Harness Web GUI's **authenticated URL** as an agent tool, so browser automation and scripts can open the GUI instead of hitting `401 dsh web authentication required`.

## The problem

`dsh --profile web` mints a random launch token per process and prints it once:

```text
dsh web: http://127.0.0.1:3080/?token=...
```

`GET /?token=...` verifies the token, sets a signed cookie bound to host:port, and redirects to `/`. Opening the bare address returns:

```text
401 dsh web authentication required; reopen the URL printed by dsh web.
```

The Desktop edition starts its own Host process on a random port and never prints that line, so any external browser or automation tool opening `http://127.0.0.1:<port>/` always gets 401. There is no `--no-browser-auth` switch today.

## How it works

The plugin runs inside the Host process and asks the official public API `connection.authenticatedUrl(baseUrl)` — the same call `dsh web` uses to build the URL it prints — then returns the result as a tool result.

It never reads the cookie-signing secret in `$DSH_HOME/.credentials.yaml` and never mints a cookie itself, so the URL is a genuine first-party session bound to this process.

Base URL resolution prefers `webApp.getAdvertisedUrl()` (respects `--public-url` and mounts), then `webServer.getOrigin()`, then protocol plus loopback port. Every call re-reads the live value, so random Desktop ports and restarted tokens need no cache. The token is attached only when that base is absolute `http` or `https`, has no username or password, and — unless the plugin config sets `allowPublic: true` — names a loopback host (`127.0.0.0/8`, `localhost`, or `::1`). The returned URL must be that same origin and carry exactly one `token`. An unacceptable base is refused before `authenticatedUrl` is called, and the error text never includes the URL.

## Install

```bash
dsh plugin --profile web add github:NingYuanLee/dsh-gui-auth-url
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` writes the bundle into the profile's `dsh.profile.bundles` automatically. Restart DeepSeek Harness and the tool appears.

Local checkout instead:

```bash
git clone https://github.com/NingYuanLee/dsh-gui-auth-url.git
dsh plugin --profile web add ./dsh-gui-auth-url
```

The package is published on npm as `dsh-gui-auth-url`. GitHub is the source repository.

Upgrading from the old name `dsh-gui-session` (0.1.x): the package name, Cordis row id and tool name all changed, so reinstall once:

```bash
dsh plugin --profile <name> remove dsh-gui-session
dsh plugin --profile <name> add github:NingYuanLee/dsh-gui-auth-url
```

## Usage

The plugin registers one tool, `gui_auth_url`, with no parameters. It returns:

```json
{
  "url": "http://127.0.0.1:3080/?token=...",
  "origin": "http://127.0.0.1:3080",
  "protocol": "http:",
  "host": "127.0.0.1",
  "port": "3080",
  "secure": false
}
```

The model sees the `url` text; the other fields are available to programmatic callers. Hand the URL to `navigate_page`, `curl`, or any HTTP client to enter the GUI.

Typical use: while debugging DeepSeek Harness itself, let the agent open the live GUI with chrome-devtools-mcp and verify layout, interaction and RPC for real instead of guessing from code.

## Security

- The returned URL contains **this process's launch token**. It is a credential equivalent to a signed-in session and only works while the Host process is alive.
- Do not write it to logs, commit it, or paste it into chats. Regenerate by calling the tool again; a restart invalidates it.
- A successful call still places the token in the session transcript and in later model requests. "Do not write it to logs" does not stop the host from storing the tool result. That is a wider audience than the one line `dsh web` prints in a terminal.
- The plugin does not read `.credentials.yaml` and does not mint cookies.
- Non-loopback URLs (`--public-url`, a LAN address, or `0.0.0.0`) are refused unless the plugin config is exactly `allowPublic: true`. That flag trusts the advertised host.
- It is unrelated to [Discussion #8678](https://github.com/deepseek-ai/deepseek-harness/discussions/8678) (reading the signing secret inside a sandbox to forge cookies): this plugin never touches that secret.

## Compatibility

| Item | Value |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0` |
| Node | `>=22.19.0` |
| Verified on | dsh `0.2.1-rc.2`, Windows x64, desktop and web profiles |
| Web combination | needs the `connection` service; a profile without a Web GUI reports a clear error |

Display metadata (`locale/*.json` plus the exported `./icon`) makes the Plugins page and Settings show a proper title, description and artwork instead of the raw package id. The plugin does not require a build step: it ships plain ESM JavaScript.

## Troubleshooting

**The tool does not appear after install.** Check that the profile's `package.json` lists `dsh-gui-auth-url` in `dsh.profile.bundles`. `dsh plugin add` normally writes it, but a failed install can leave only the dependency:

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-gui-auth-url"] } }
}
```

Restart DeepSeek Harness, then confirm with `dsh --profile <name> --dump-config` and look for the `gui-auth-url` row.

**Installation rejected because of a version mismatch.** DSH checks `engines.dsh` (or dsh peer ranges) at install time. If your host is outside the declared range, grant the exact-version exemption, reinstall, and revoke it once a compatible release exists:

```bash
dsh plugin --profile <profile> version-exemptions
dsh plugin --profile <profile> allow-version dsh-gui-auth-url@0.2.1 --dsh-version <runtime> --accept-risk
dsh plugin --profile <profile> revoke-version dsh-gui-auth-url@0.2.1
```

**`EPERM: rename ... node_modules\dsh-gui-auth-url_tmp_*` on Windows.** Stop the DSH process using that profile, delete the stale `node_modules\dsh-gui-auth-url` directory, and retry. A running process locks the directory.

**"This profile serves no Web GUI".** The plugin only returns a URL when the profile mounts `webApp` or `webServer` plus `connection`. Headless-style profiles have no GUI to open.

**"refusing to attach the launch token to a non-loopback host".** The advertised URL is not loopback. The token is not returned. To allow that host, set this entry in the profile patch. A later patch replaces the whole `config` object, so keep any other keys you need in that same object:

```yaml
- id: gui-auth-url
  config:
    allowPublic: true
```

Leave `allowPublic` unset on a Desktop loopback profile. The flag trusts whatever `webApp.getAdvertisedUrl()` returns.

## Development

```bash
node --test test/*.test.js          # unit + manifest compliance tests
node --check src/index.js && node --check src/auth-url.js
npm run check:pack                  # verifies the published tarball contents
```

```text
src/auth-url.js    pure helpers: base URL resolution + Host session call (unit-tested)
src/index.js       Cordis plugin entry: registers the gui_auth_url tool
locale/            display metadata (en, zh, es, pt, hi)
test/              node:test suites, including packaging invariants
scripts/           tarball check used by prepublishOnly and CI
```

The plugin only registers a tool; `ctx.tools.register` returns the disposer that Cordis owns, so unloading or hot-reloading the plugin removes it cleanly.

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — local scripts hitting 401 on the Web UI
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — request for `--no-browser-auth`, not adopted
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — Desktop cannot obtain a valid session
- [Official connection contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)

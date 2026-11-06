# dsh-gui-auth-url

[![CI](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-gui-auth-url/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dsh-gui-auth-url.svg)](https://www.npmjs.com/package/dsh-gui-auth-url) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![Node >=22.19](https://img.shields.io/badge/node-%3E%3D22.19.0-339933.svg)](#compatibility) [![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0--0%20%7C%7C%20%3E%3D0.2.2--0%20%3C0.3.0--0-6f42c1)](#compatibility) [![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-6f42c1.svg)](https://github.com/topics/dsh-plugin) [![GitHub stars](https://img.shields.io/github/stars/NingYuanLee/dsh-gui-auth-url?style=social)](https://github.com/NingYuanLee/dsh-gui-auth-url/stargazers) [![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

> Third-party community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Not an official DeepSeek product. MIT licensed.

English | [中文](README-zh.md) | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

Expose the running DeepSeek Harness Web GUI's **authenticated URL** as an agent tool, so browser automation and scripts can open the GUI instead of hitting `401 dsh web authentication required`.

It also ships **temporary authenticated DSH Web**: an agent (`dsh_web_start` / `dsh_web_restart` / `dsh_web_stop` / `dsh_web_status` tools) or a person (`/dsh-web` command — start when absent, restart in place when running) can get a per-session instance with its own throwaway `DSH_HOME` and port, to exercise new plugins, surfaces, or profiles without touching the live session — one per session, sessions never disturb each other, and an instance only ever exists as a tracked background job bound to a session.

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

The plugin registers one read-only agent tool, `gui_auth_url`, four instance tools — `dsh_web_start`, `dsh_web_restart`, `dsh_web_stop`, `dsh_web_status` — and one human command, `/dsh-web` (the old `/web-gui` spelling stays executable as an alias). The read-only tool returns:

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

`/dsh-web` is the human half: type it in the GUI input box and the plugin decides for you — with no instance for this session it spawns a **separate** `dsh web` host with its own temporary `DSH_HOME` and an OS-assigned port; with one already running it restarts it in place, keeping the temporary home and anything installed into it, and reusing the same port so an open tab keeps working (only the launch token changes). Either way it opens the new URL in the system default browser. Nothing is shared with the desktop edition's live session, so the browser GUI is a disposable, isolated place to work. Each session owns its own host, so Session A's instance is never reused or stopped by Session B. An instance only ever exists while bound to a session: a call with no session id, or a job registry that refuses the ownership binding, fails instead of leaving an unowned host. The instance is a tracked session job whose registry owner is the **invoking session id**, so the desktop session keeps showing "running" in its header control and you can stop it there; archiving that session while it runs lists it as live activity in the archive confirmation and can stop it with the session. Set `openBrowser: false` in the profile patch when the Host machine has no browser to open; the command then only reports the link. By default the plugin also copies this process's `DEEPSEEK_API_KEY` (inherited environment first, then the credentials store) to the isolated instance as an environment variable, so it can talk to the model without logging in again — the key is never written to the temporary home, and every turn bills the same account; set `shareApiKey: false` in the profile patch to opt out. At most 4 isolated hosts run at once (tune with `maxInstances`, 1–32); a start beyond that fails until one is stopped, because every host is a whole `dsh web` process, and a host stopped on request shows as cancelled rather than failed in the task roster. **In-place restart**: `/dsh-web restart` (or the agent's `dsh_web_restart` tool) replaces the host process but keeps the temporary `DSH_HOME`, so installed plugins, settings, and in-instance sessions survive, while the port is reused and only the launch token changes — the browser's auth cookie is bound to `host:port` and signed with a secret kept in that home, so an already-open page only needs a refresh. A busy port falls back to an OS-assigned one, and the result says which happened. — that is how you try a plugin that needs a restart, verify it, then stop the host and lose the whole throwaway profile on purpose without installing anything on the desktop. To keep leftovers from piling up, each temporary home records `instance.json` (host PID, Desktop PID, port); on mount the plugin scans `%TEMP%/dsh-web-gui-*`, removes homes whose host or Desktop process is gone, and only ends a leftover host when its recorded port still returns the DSH 401 signature; marker-less homes from older plugin versions are removed after 24 hours. Stopping an instance ends its process tree on Windows so terminal children do not survive. A **blank** session (no message yet) is refused: DSH filters blank sessions out of the session list, so switching away would hide the instance and its stop control — send a message first or use an existing session. That refusal is shown above the input box: a blank session renders the hero layout rather than the transcript where command results normally appear, so the browser half repeats the failure through the composer notice channel. Typing the full `/web-gui` can leave the `/` menu's highlight on the next candidate, and Enter accepts that row instead of executing the typed command; pick the row with the mouse instead. **Start arguments.** Every start argument is optional, and each one is passed through to the spawned `dsh web`. Each also has a price:

- `install` (string[]): package specs to install into the temporary `DSH_HOME` with `dsh plugin --profile web add` before the host boots. This is how a local or published plugin gets tried inside a throwaway instance. At most 16 specs per call, and a spec may not start with `-` (that would be a package-manager flag). **Cost:** pnpm runs those packages' lifecycle scripts as your user, so only name packages you are willing to run; failure is terminal — the error carries the tail of the install output (capped at 4,000 characters), no host is left running, and a fresh start also deletes the temporary home while an in-place restart leaves the preserved home for the startup sweep. Install is allowed by default; set `allowInstall: false` in the profile patch to reject every request that carries `install`.
- `host` (string): the bind address. It must be a concrete IPv4 or IPv6 literal — `0.0.0.0`, `::` and `*` are refused, because a wildcard would publish the instance on every interface. Accepted only when the plugin config is exactly `allowPublic: true`.
- `public_url` (string): the advertised root URL; absolute `http` or `https`, no username or password. Accepted only with `allowPublic: true`.
- `tls_cert` and `tls_key` (string): PEM certificate and key paths, which must be supplied as a pair. Accepted only with `allowPublic: true`. TLS encrypts the transport; it does not make the printed token safe to hand out.
- `trusted_host` (string[]): extra authorities accepted by the `/api` trust fence. Accepted only with `allowPublic: true`.
- `port` (integer, 0–65535): the listening port; `0` or no `port` lets the OS assign one. `dsh_web_restart` has no `port` on purpose — a restart reuses the port so an already-open tab keeps working. A `port`-only call that finds this session's instance already running reuses it and ignores the port: rebinding a live host is not a reconfiguration.

Turning `allowPublic` on is the one setting that widens the blast radius: the instance then answers beyond loopback, and the token is all that stands between that network and a signed-in session. Leave it unset on a loopback desktop profile.

**Complete loop: a local plugin, tried in a throwaway instance.** `install` on `dsh_web_restart` is what turns "install, restart to load it, verify, tear down" into one clean cycle:

```text
1. dsh_web_start()
   -> { "url": "http://127.0.0.1:49312/?token=...", "jobId": "job-..." }

2. dsh_web_restart({ "install": ["D:/tools/dsh-plugins/dsh-gui-auth-url"] })
   installs with `dsh plugin --profile web add` into the temporary DSH_HOME,
   then replaces the host: same port when free, new launch token.

3. Verify: open the returned url with navigate_page/curl, or call
   dsh_web_status() -> { "running": true, "install": [...], "exposed": false, ... }
   The plugin's tool and command now exist in that instance only.

4. dsh_web_stop() -> { "stopped": true }
   ends the process tree, deletes the temporary home; the desktop profile never changed.
```

For a fresh instance, `dsh_web_start({ "install": [...] })` collapses steps 1 and 2 into one call. Either way everything lands in `%TEMP%/dsh-web-gui-*`, and a restart keeps that home so the install survives.

Agents get five entries, and they are not interchangeable: `gui_auth_url` returns this process's own address (the GUI the person is looking at, read-only and side-effect free); `dsh_web_start` starts this session's isolated host and returns its `url`, `jobId` and `reused` **without opening a browser** — a bare call reuses the running instance, while a call carrying `install` or an exposure argument restarts it in place, because that is a request for a differently configured host; `dsh_web_restart` replaces that host in place, keeps the temporary home, inherits every exposure option it is not given, and re-runs the install only when the call names specs again; `dsh_web_stop` stops it, deletes the temporary home, and returns `{ stopped }` — `stopped: false` when there was nothing to stop, which is not an error; `dsh_web_status` reports the session's instance without changing anything — `running`, `runningCount`, `maxInstances`, and while an instance is recorded also `startedAt`, `home`, `port`, `sharedKey`, `install`, `exposed` and `jobStatus`, plus `url` and `jobId` while it is running. All five stop paths — roster, `job_kill`, `dsh_web_stop` — share the same ownership and cleanup rules and end in the same state.

 The browser half also relabels the command in Chinese and adds an icon where the client exposes them; that patch degrades to a no-op if a future client supports label/icon natively.

## Security

- The returned URL contains **this process's launch token**. It is a credential equivalent to a signed-in session and only works while the Host process is alive.
- Do not write it to logs, commit it, or paste it into chats. Regenerate by calling the tool again; a restart invalidates it.
- A successful call still places the token in the session transcript and in later model requests. "Do not write it to logs" does not stop the host from storing the tool result. That is a wider audience than the one line `dsh web` prints in a terminal.
- The plugin does not read `.credentials.yaml` and does not mint cookies.
- Non-loopback URLs (`--public-url`, a LAN address, or `0.0.0.0`) are refused unless the plugin config is exactly `allowPublic: true`. That flag trusts the advertised host.
- An isolated instance is a real `dsh web` child process. With `shareApiKey: true` (the default) it receives this process's `DEEPSEEK_API_KEY` through its environment: not written to the temporary home and not printed, but readable by any process running as the same user, and every turn inside it bills the same account. `shareApiKey: false` opts out.
- `install` runs pnpm's lifecycle scripts for the named packages as your user. Specs are character-checked (no spaces, quotes, or `&|<>^`), which blocks shell injection into the install command but says nothing about a well-formed malicious package. `allowInstall: false` rejects install requests outright.
- The exposure arguments (`host`, `public_url`, `tls_cert`/`tls_key`, `trusted_host`) are accepted only behind `allowPublic: true`, and `host` refuses wildcards even then. Once it is on, the reachable network is the token's audience; TLS does not shrink that audience.
- Stopping ends the process tree (`taskkill /T` on Windows) and deletes the temporary home. The startup sweep only kills a leftover process when its recorded port still answers with DSH's 401 signature, so a reused PID is never killed by mistake.
- It is unrelated to [Discussion #8678](https://github.com/deepseek-ai/deepseek-harness/discussions/8678) (reading the signing secret inside a sandbox to forge cookies): this plugin never touches that secret.

## Compatibility

| Item | Value |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0 \|\| >=0.2.2-0 <0.3.0-0` |
| Node | `>=22.19.0` |
| Verified on | dsh `0.2.1-rc.2` and `0.2.2-rc.1`, Windows x64, desktop and web profiles |
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

**`dsh_web_start` refuses `install`.** Either the profile config is `allowInstall: false`, or a spec contains a character outside `[A-Za-z0-9@._~:/\\+=%-]` (a space, a quote, `&|<>^`). Fix the spec, or re-enable installs in the profile patch if you meant to use them.

**An install fails and no instance appears.** That is the intended behaviour: the temporary home is deleted and the error carries the tail of the install output. Read that tail — usually it is a version mismatch (`engines.dsh`, see the exemption flow above) or a registry/network failure. Nothing is left half-installed to clean up.

**`dsh_web_start` refuses `host`, `public_url`, `tls_cert`, `tls_key` or `trusted_host`.** Exposure arguments are refused unless the config is exactly `allowPublic: true`. A wildcard (`0.0.0.0`, `::`, `*`) is refused even then — pass a concrete address and keep any reverse proxy or tunnel outside the plugin.

**A restart invalidated the URL.** Only the port is reused, and only when it is free; the launch token changes on every start and restart, so older links answer 401. Call `dsh_web_status` for the current `url`.

**`dsh_web_stop` reports nothing was stopped.** This session had no instance by then — already stopped, killed from the task roster, or ended with `job_kill`. `dsh_web_status` confirms before you assume it failed.

## Development

```bash
node --test test/*.test.js          # unit + manifest compliance tests
node --check src/index.js && node --check src/auth-url.js && node --check src/api-key.js && node --check src/command.js && node --check src/isolated-tool.js && node --check src/isolated-web.js && node --check client.js
npm run check:pack                  # verifies the published tarball contents
```

```text
src/auth-url.js      pure helpers: base URL resolution + Host session call (unit-tested)
src/api-key.js       DeepSeek API key resolution for the isolated host
src/command.js       /dsh-web command: start/auto-restart and browser opening
src/isolated-web.js  per-session instance manager (spawn, restart, stop, sweep)
src/isolated-tool.js agent tools dsh_web_start / dsh_web_restart / dsh_web_stop / dsh_web_status
src/index.js         Cordis entry: gui_auth_url plus the instance surfaces
client.js            browser half: command label/icon, hidden alias, blank-session notice
locale/              display metadata (en, zh, es, pt, hi)
test/                node:test suites, including packaging invariants
scripts/             tarball check used by prepublishOnly and CI
```

The plugin registers one read-only tool, four instance tools and one human command; `ctx.tools.register` disposers belong to Cordis, so unloading or hot-reloading the plugin removes them cleanly.

Pushing a `v*` tag runs `.github/workflows/publish.yml`; when the repository secret `NPM_TOKEN` is not configured the workflow skips publishing and says so in the log. Manual publishing (above) stays valid.

## Releasing

Releases take one command: `npm run release -- patch|minor|major` (add `--dry-run` to preview without changing anything). It runs the full validation chain (tests, syntax, pack) first and aborts untouched when a check fails; then it bumps the version, commits, tags and pushes. The tag triggers `.github/workflows/publish.yml`, which publishes to npm when the repository secret `NPM_TOKEN` is configured under Settings → Secrets and variables → Actions, and skips with a log line otherwise.

## Related

- [Discussion #5932](https://github.com/deepseek-ai/deepseek-harness/discussions/5932) — local scripts hitting 401 on the Web UI
- [Discussion #5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) — request for `--no-browser-auth`, not adopted
- [Discussion #9085](https://github.com/deepseek-ai/deepseek-harness/discussions/9085) — Desktop cannot obtain a valid session
- [Official connection contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)

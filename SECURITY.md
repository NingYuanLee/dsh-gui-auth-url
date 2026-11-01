# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories on this repository
(`Security` → `Report a vulnerability`). Do not open a public issue for a token leak or an
authentication bypass.

Include the DeepSeek Harness version, the profile, the exact tool output shape (redact the
token), and reproduction steps. Expected first response within 7 days.

## Scope

The plugin has four paths with different trust implications: reading the current process's URL,
spawning an isolated `dsh web` instance, installing packages into that instance, and widening
where an instance advertises itself. This document describes them separately, because a single
"the plugin does X" claim is no longer true — the isolated-instance path spawns processes and
opens a listener, and the install path runs third-party code.

### Reading the current process's URL

`gui_auth_url` returns the current process's authenticated Web GUI URL by calling the official
`connection.authenticatedUrl(baseUrl)` API. The URL embeds the Host process launch token and is
therefore a credential.

- The plugin never reads `$DSH_HOME/.credentials.yaml` and never mints a cookie on this path.
- This path itself adds no network listener and performs no outbound request: it is a read of
  in-process state.
- It registers one read-only tool with no parameters, so the model cannot choose which host
  receives the token.
- Before `authenticatedUrl` is called, the base URL must be absolute `http` or `https` with no
  username or password. Unless config `allowPublic` is exactly `true`, the hostname must be
  loopback (`127.0.0.0/8`, `localhost`, or `::1`). `0.0.0.0` is not loopback.
- The returned URL must be that same origin and carry exactly one non-empty `token`. Failures
  use a fixed message and do not include the URL.
- Possessing a successful tool result grants the same access as the URL printed by `dsh web`,
  and only while the Host process is alive.

### Spawning a temporary isolated instance

`dsh_web_start`, `dsh_web_restart` and `/dsh-web` start a **separate** `dsh web` process per
session. This path does spawn a process (a whole `dsh web`, with its own listener), which the
previous version of this document wrongly denied.

- The child runs with a temporary `DSH_HOME` under `%TEMP%/dsh-web-gui-*`, not the caller's
  home, so its sessions, credentials and installed bundles are separate from the desktop
  instance. Nothing is shared with the live session.
- The child prints a launch URL containing its own token; the plugin reads it from the child's
  stdout and returns it. That token is a credential for the child only, and only while the child
  is alive.
- By default (`shareApiKey: true`) the parent copies its `DEEPSEEK_API_KEY` into the child's
  environment. The key is not written to the temporary home and not printed, but any process
  running as the same user can read that user's environment, and every turn inside the instance
  bills the same account. Set `shareApiKey: false` to opt out.
- An instance is bound to the invoking session and registered as a tracked background job; there
  is no unowned instance, so every started host has a stop control. At most 4 run at once by
  default (`maxInstances`, 1–32); each one is a full `dsh web` process.
- Stopping terminates the process tree (`taskkill /T` on Windows, so terminal children do not
  survive the host) and deletes the temporary home. Each temp home records `instance.json` with
  the host PID, Desktop PID and port; at plugin startup the leftover sweep removes homes whose
  host or parent is gone, and only kills a surviving process when its port still answers with
  DSH's 401 signature (so a reused PID is not killed by mistake). Unmarked directories from older
  versions are removed after 24 hours.
- A failed start (child exits without printing a URL, or times out) kills the half-started
  process, deletes the temporary home, and returns an error instead of a fabricated address.

### Installing packages into an instance

The `install` parameter takes a list of package specs and installs them into the temporary
`DSH_HOME` before the host starts. The plugin runs `dsh plugin --profile web add <spec>`, which
forwards to pnpm inside that profile directory.

- pnpm runs the lifecycle scripts of the packages it installs (`preinstall`, `install`,
  `postinstall`), which means **third-party code runs with your user's privileges**. This is the
  same trust boundary as running `npm install` in a checkout you have not read: a package you
  name can do anything your account can do. Only pass specs whose packages you are willing to
  run.
- Specs are checked against a restricted character set
  (`[A-Za-z0-9@._~:/\\+=%-]`; no spaces, quotes, or `&|<>^`). That blocks shell-metacharacter
  injection into the install command. It says nothing about whether a well-formed package is
  malicious.
- The parameter is accepted by default (`allowInstall: true`) because trying a plugin in a
  throwaway instance is the feature's purpose. Set `allowInstall: false` to reject any request
  carrying `install`; nothing else in the plugin needs it.
- A failed install deletes the temporary home, returns an error together with the tail of the
  install output, and leaves no half-created instance behind.

### Where an instance is advertised

By default the child binds loopback, and the same loopback rule as `gui_auth_url` applies. The
exposure parameters are refused unless config `allowPublic` is exactly `true`:

- `host` must be a concrete IPv4 or IPv6 literal. `0.0.0.0`, `::` and `*` are refused — a
  wildcard would silently publish the instance on every interface.
- `public_url` must be an absolute `http` or `https` URL with no username or password.
- `tls_cert` and `tls_key` are PEM paths and must be supplied as a pair.
- `trusted_host` adds authorities to the `/api` trust fence.
- `port` is 0–65535; 0 lets the system choose.

Turning `allowPublic` on means the instance is reachable from other machines. TLS encrypts the
transport; it does not make the printed token safe to hand out, and it does not reduce the
audience to people you know. Treat the reachable network as the token's audience.

## Token handling

Tool output is meant to be passed directly to a browser or HTTP client. Do not persist it in
logs, commit it to a repository, or paste it into chat transcripts. Restarting the Host
invalidates the token; calling the tool again returns the current value. The same holds for the
token of an isolated instance: it dies with that child process, and an in-place restart issues a
new one even when the port is reused.

A successful call still stores the URL in the session transcript, and later model requests
include that transcript. The warning above does not stop the host from doing so. That audience
is wider than the one line `dsh web` prints in a terminal. Non-loopback advertised hosts are
refused unless the plugin config is `{ "allowPublic": true }`.

## Supported versions

Security fixes target the latest `0.7.x` and `0.8.x` releases of this plugin. Older releases are
unsupported.

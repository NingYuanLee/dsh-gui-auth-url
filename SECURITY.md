# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories on this repository
(`Security` → `Report a vulnerability`). Do not open a public issue for a token leak or an
authentication bypass.

Include the DeepSeek Harness version, the profile, the exact tool output shape (redact the
token), and reproduction steps. Expected first response within 7 days.

## Scope

`dsh-gui-auth-url` returns the current process's authenticated Web GUI URL by calling the
official `connection.authenticatedUrl(baseUrl)` API. The URL embeds the Host process launch
token and is therefore a credential.

- The plugin never reads `$DSH_HOME/.credentials.yaml` and never mints a cookie.
- The plugin adds no network listener, spawns no process, and performs no outbound request.
- It registers one read-only tool with no parameters, so the model cannot choose which
  host receives the token.
- Before `authenticatedUrl` is called, the base URL must be absolute `http` or `https` with no
  username or password. Unless config `allowPublic` is exactly `true`, the hostname must be
  loopback (`127.0.0.0/8`, `localhost`, or `::1`). `0.0.0.0` is not loopback.
- The returned URL must be that same origin and carry exactly one non-empty `token`. Failures
  use a fixed message and do not include the URL.
- Possessing a successful tool result grants the same access as the URL printed by `dsh web`,
  and only while the Host process is alive. The difference is who receives it: the agent
  session and later model requests, not only the terminal.

## Token handling

Tool output is meant to be passed directly to a browser or HTTP client. Do not persist it in
logs, commit it to a repository, or paste it into chat transcripts. Restarting the Host
invalidates the token; calling the tool again returns the current value.

A successful call still stores the URL in the session transcript, and later model requests
include that transcript. The warning above does not stop the host from doing so. Non-loopback
advertised hosts are refused unless the plugin config is `{ "allowPublic": true }`.

## Supported versions

Security fixes target the latest `0.2.x` release on the `>=0.2.1-rc.2 <0.3.0-0` DeepSeek Harness
range. Older 0.1.x releases are unsupported.

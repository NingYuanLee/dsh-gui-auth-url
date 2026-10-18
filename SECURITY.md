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
- It registers one read-only tool with no parameters, so there is no model-controlled input
  surface to validate.
- Possessing the tool result grants exactly the same access as the URL printed by `dsh web`
  in a terminal, and only while the Host process is alive.

## Token handling

Tool output is meant to be passed directly to a browser or HTTP client. Do not persist it in
logs, commit it to a repository, or paste it into chat transcripts. Restarting the Host
invalidates the token; calling the tool again returns the current value.

## Supported versions

Security fixes target the latest `0.2.x` release on the `>=0.2.0-rc.2 <0.3.0` DeepSeek Harness
range. Older 0.1.x releases are unsupported.

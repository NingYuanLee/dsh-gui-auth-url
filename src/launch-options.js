/**
 * @module dsh-gui-auth-url/launch-options
 *
 * Validate the model-facing launch request and translate it into `dsh web` argv.
 *
 * Two separate concerns live here, both pure so they can be unit-tested without
 * spawning anything:
 *
 * 1. **Exposure** — `--host`, `--public-url`, `--trusted-host`, `--tls-cert` and
 *    `--tls-key` widen who can reach the isolated host. Binding one concrete
 *    local interface is still a local exposure, but the launch token then rides
 *    on a LAN/HTTPS address, so these flags are refused unless the plugin config
 *    explicitly sets `allowPublic: true` — the same gate the read-only
 *    `gui_auth_url` tool applies before handing out the desktop token.
 * 2. **Installing** — `install` specs are passed to `dsh plugin --profile web
 *    add`, which forwards them to pnpm in the temporary profile. That command
 *    runs third-party install scripts as this user, so the specs are restricted
 *    to a conservative character set: no spaces, quotes, or shell metacharacters
 *    (the Windows fallback launcher reaches `dsh` through `cmd.exe /c`, where a
 *    `&` would otherwise become a second command).
 *
 * Nothing here guesses at `dsh`'s own behaviour: `dsh web --help` documents each
 * flag, including that `--host` accepts one concrete IPv4/IPv6 literal and
 * rejects wildcard addresses such as `0.0.0.0`.
 */
import { isIP } from 'node:net';

/** Profile `dsh web` serves; `dsh plugin --profile <name>` manages the same one. */
export const PROFILE_NAME = 'web';

/** Upper bound on one request's install list; every spec is a package manager call. */
export const MAX_INSTALL_SPECS = 16;

/** Package spec characters: registry names, `github:owner/repo`, `file:` and relative paths. */
const SAFE_SPEC = /^[A-Za-z0-9@._~:/\\+=%-]+$/u;

/** One authority (host or host:port) that the /api browser-trust fence may accept. */
const SAFE_AUTHORITY = /^[A-Za-z0-9.\-:_[\]]+$/u;

/** Options that widen reachability and therefore need `allowPublic: true`. */
const EXPOSE_OPTIONS = ['host', 'publicUrl', 'tlsCert', 'tlsKey', 'trustedHost'];

/** Every accepted option, in camelCase. */
const KNOWN_OPTIONS = new Set(['install', 'host', 'publicUrl', 'tlsCert', 'tlsKey', 'trustedHost', 'port']);

/** Model-facing parameter names that differ from the internal spelling. */
const ALIASES = new Map([
	['public_url', 'publicUrl'],
	['tls_cert', 'tlsCert'],
	['tls_key', 'tlsKey'],
	['trusted_host', 'trustedHost'],
]);

/** Raise one fixed, URL-free refusal. */
function refuse(message) {
	throw new Error(`gui-auth-url: ${message}`);
}

/** Copy one string value, trimmed; refuse empty or non-string input. */
function requireText(value, name) {
	if (typeof value !== 'string') refuse(`${name} must be a string`);
	const trimmed = value.trim();
	if (trimmed === '') refuse(`${name} must not be empty`);
	return trimmed;
}

/** Copy one string list with a cap, refusing empties. */
function requireTextList(value, name, limit) {
	if (!Array.isArray(value)) refuse(`${name} must be an array of strings`);
	if (value.length > limit) refuse(`${name} accepts at most ${String(limit)} entries`);
	return value.map((entry) => requireText(entry, `${name} entry`));
}

/**
 * Validate `--host`: exactly what `dsh web` accepts, one concrete literal.
 * A wildcard would expose every interface at once, which is a different decision
 * than naming the interface to serve.
 * @param {unknown} value - requested bind address.
 * @returns {string} the validated literal.
 */
function requireHostLiteral(value) {
	const host = requireText(value, 'host');
	if (host.includes('*') || host === '0.0.0.0' || host === '::' || host === '[::]') {
		refuse('host must name one concrete local interface, not a wildcard address');
	}
	if (isIP(host) === 0) refuse('host must be an IPv4 or IPv6 literal');
	return host;
}

/**
 * Validate `--public-url`: an absolute http(s) root with no credentials.
 * @param {unknown} value - advertised root.
 * @returns {string} the validated root, as given.
 */
function requirePublicRoot(value) {
	const root = requireText(value, 'public_url');
	let parsed;
	try {
		parsed = new URL(root);
	} catch {
		refuse('public_url must be an absolute http or https URL');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		refuse('public_url must be http or https');
	}
	if (parsed.username !== '' || parsed.password !== '') refuse('public_url must not include credentials');
	return root;
}

/**
 * Validate one `/api` trust-fence authority: a host or host:port.
 * @param {unknown} value - requested authority.
 * @returns {string} the validated authority.
 */
function requireAuthority(value) {
	const authority = requireText(value, 'trusted_host entry');
	if (!SAFE_AUTHORITY.test(authority)) refuse(`trusted_host entry is not a host or host:port: ${authority}`);
	return authority;
}

/**
 * Validate one install spec. Conservative on purpose: the spec ends up in a
 * package manager argv, and one launcher reaches it through `cmd.exe`.
 * @param {unknown} value - requested package spec.
 * @returns {string} the validated spec.
 */
function requireInstallSpec(value) {
	const spec = requireText(value, 'install entry');
	if (!SAFE_SPEC.test(spec)) {
		refuse(`install entry contains characters the plugin does not pass to the package manager: ${spec}`);
	}
	if (spec.startsWith('-')) refuse(`install entry must not start with a flag: ${spec}`);
	return spec;
}

/**
 * Validate one listen port.
 * @param {unknown} value - requested port.
 * @returns {number} the port, `0` meaning OS-assigned.
 */
function requirePort(value) {
	if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
		refuse('port must be an integer between 0 and 65535');
	}
	return value;
}

/** Canonicalize one request key: snake_case tool spelling to internal camelCase. */
function canonicalKey(key) {
	return ALIASES.get(key) ?? key;
}

/**
 * Validate a launch request and return its canonical form.
 *
 * Absent, `null`, and `{}` all mean "no extra options" and produce an empty
 * request, so every caller can pass the tool arguments straight through.
 *
 * @param {unknown} raw - the model's or caller's request.
 * @param {{allowPublic?: boolean, allowInstall?: boolean}} [options] - plugin config gates.
 * @returns {{install: string[], host?: string, publicUrl?: string, tlsCert?: string, tlsKey?: string, trustedHost: string[], port?: number}} the canonical request.
 * @throws {Error} on an unknown key, a disabled option, or invalid input.
 */
export function normalizeLaunchRequest(raw, options = {}) {
	const allowPublic = options.allowPublic === true;
	const allowInstall = options.allowInstall !== false;
	const request = { install: [], trustedHost: [] };
	if (raw === undefined || raw === null) return request;
	if (typeof raw !== 'object' || Array.isArray(raw)) refuse('launch options must be an object');

	const canonical = {};
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		const name = canonicalKey(key);
		if (!KNOWN_OPTIONS.has(name)) refuse(`unknown launch option ${key}`);
		canonical[name] = value;
	}

	if (canonical.install !== undefined) {
		if (!allowInstall) {
			refuse('install is disabled by this profile (set allowInstall: true in the plugin config to enable it)');
		}
		const specs = requireTextList(canonical.install, 'install', MAX_INSTALL_SPECS);
		request.install = specs.map((spec) => requireInstallSpec(spec));
	}

	const exposed = EXPOSE_OPTIONS.some((name) => canonical[name] !== undefined);
	if (exposed && !allowPublic) {
		refuse('binding or advertising a non-loopback address requires allowPublic: true in the plugin config');
	}

	if (canonical.host !== undefined) request.host = requireHostLiteral(canonical.host);
	if (canonical.publicUrl !== undefined) request.publicUrl = requirePublicRoot(canonical.publicUrl);
	if (canonical.tlsCert !== undefined || canonical.tlsKey !== undefined) {
		if (canonical.tlsCert === undefined || canonical.tlsKey === undefined) {
			refuse('tls_cert and tls_key must be provided together');
		}
		request.tlsCert = requireText(canonical.tlsCert, 'tls_cert');
		request.tlsKey = requireText(canonical.tlsKey, 'tls_key');
	}
	if (canonical.trustedHost !== undefined) {
		request.trustedHost = requireTextList(canonical.trustedHost, 'trusted_host', 16).map(requireAuthority);
	}
	if (canonical.port !== undefined) request.port = requirePort(canonical.port);
	return request;
}

/**
 * Whether a request asks for anything beyond "start an instance".
 * @param {{install?: string[], host?: string, publicUrl?: string, tlsCert?: string, trustedHost?: string[], port?: number}} [request] - canonical request.
 * @returns {boolean} true when the request carries any option.
 */
export function hasLaunchOptions(request) {
	if (request === undefined || request === null) return false;
	return (request.install?.length ?? 0) > 0
		|| request.host !== undefined
		|| request.publicUrl !== undefined
		|| request.tlsCert !== undefined
		|| (request.trustedHost?.length ?? 0) > 0
		|| request.port !== undefined;
}

/**
 * Whether a request widens who can reach the isolated host.
 * @param {{host?: string, publicUrl?: string, tlsCert?: string, trustedHost?: string[]}} [request] - canonical request.
 * @returns {boolean} true when the instance is bound or advertised beyond loopback.
 */
export function isExposed(request) {
	if (request === undefined || request === null) return false;
	return request.host !== undefined
		|| request.publicUrl !== undefined
		|| request.tlsCert !== undefined
		|| (request.trustedHost?.length ?? 0) > 0;
}

/**
 * Build the extra `dsh web` flags one request implies.
 *
 * Order is stable so a restart's argv is comparable in tests and logs:
 * bind address, advertised root, trust fence, then TLS.
 *
 * @param {object} [request] - canonical request.
 * @returns {string[]} additional argv entries after `--port <n>`.
 */
export function launchArgs(request) {
	if (request === undefined || request === null) return [];
	const args = [];
	if (request.host !== undefined) args.push('--host', request.host);
	if (request.publicUrl !== undefined) args.push('--public-url', request.publicUrl);
	for (const authority of request.trustedHost ?? []) args.push('--trusted-host', authority);
	if (request.tlsCert !== undefined) args.push('--tls-cert', request.tlsCert, '--tls-key', request.tlsKey);
	return args;
}

/**
 * Build the package-manager argv that installs specs into a temporary profile.
 *
 * `dsh plugin` forwards its remaining arguments verbatim to pnpm inside the
 * profile directory, and the child gets `DSH_HOME` pointed at the disposable
 * home, so nothing here touches the caller's real profile.
 *
 * @param {{command: string, args: string[], env: Record<string, string>}} launcher - output of `resolveLauncher()`.
 * @param {string[]} specs - validated install specs.
 * @returns {{command: string, args: string[]}} argv for one install run.
 */
export function installArgs(launcher, specs) {
	return {
		command: launcher.command,
		args: [...launcher.args, 'plugin', '--profile', PROFILE_NAME, 'add', ...specs],
	};
}

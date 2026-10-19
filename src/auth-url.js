/**
 * @module dsh-gui-auth-url/auth-url
 *
 * Pure helpers that turn the live Host services into a usable Web GUI address.
 *
 * The launch token is minted per process by `dsh-client-connection`
 * (`BrowserAuth.authenticatedUrl`) and printed only by `dsh --profile web`.
 * The Desktop edition starts its own Host process and never prints it, so an
 * external browser opening `http://127.0.0.1:<port>/` gets
 * `401 dsh web authentication required`.
 *
 * This module reads the *official* value — `connection.authenticatedUrl(base)` —
 * instead of the signing secret in `$DSH_HOME/.credentials.yaml`. It therefore
 * asks the Host for a session, exactly like `dsh web` does, and never forges a
 * cookie. Before that call, the base URL must be http(s) with no credentials.
 * Unless `allowPublic` is exactly true, the host must be loopback. The returned
 * URL must be that same origin and carry exactly one token. Refusals use a fixed
 * message and never include the URL.
 */

/** Services this module reads opportunistically; none is required to import it. */
const WEB_APP = 'webApp';
const WEB_SERVER = 'webServer';
const CONNECTION = 'connection';

/**
 * Resolve one service from a Cordis context.
 * @param {object} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {any} the service, or undefined when this composition omits it.
 */
function service(ctx, name) {
	return ctx.get(name) ?? ctx[name];
}

/**
 * Build the clean base URL a browser uses to reach this Web GUI.
 *
 * Preference order mirrors `@deepseek-ai/dsh-web-app`:
 *   1. `webApp.getAdvertisedUrl()` — respects `--public-url` and mounts;
 *   2. `webServer.getOrigin()` — the listener's own origin;
 *   3. `webServer.protocol` + loopback port — the Desktop Host's own spelling.
 *
 * @param {object} ctx - plugin context.
 * @returns {string} clean base URL, without a token.
 * @throws {Error} when this profile serves no Web GUI.
 */
export function resolveGuiBaseUrl(ctx) {
	const webApp = service(ctx, WEB_APP);
	if (webApp !== undefined && typeof webApp.getAdvertisedUrl === 'function') {
		const advertised = webApp.getAdvertisedUrl();
		if (typeof advertised === 'string' && advertised !== '') return advertised;
	}
	const webServer = service(ctx, WEB_SERVER);
	if (webServer !== undefined) {
		if (typeof webServer.getOrigin === 'function') {
			const origin = webServer.getOrigin();
			if (typeof origin === 'string' && origin !== '') return origin;
		}
		if (typeof webServer.protocol === 'string' && Number.isInteger(webServer.port)) {
			return `${webServer.protocol}//127.0.0.1:${String(webServer.port)}`;
		}
	}
	throw new Error('gui-auth-url: this profile serves no Web GUI (no webApp or webServer service); start the Web UI first');
}

/**
 * Accept only an absolute http(s) URL with no username or password.
 * @param {string} baseUrl - candidate GUI root.
 * @returns {URL} parsed base URL.
 * @throws {Error} when the value is missing, relative, non-http, or has credentials.
 */
function assertHttpBase(baseUrl) {
	let base;
	try {
		base = new URL(baseUrl);
	} catch {
		throw new Error('gui-auth-url: base URL must be an absolute http or https URL');
	}
	if (base.protocol !== 'http:' && base.protocol !== 'https:') {
		throw new Error('gui-auth-url: base URL must be http or https');
	}
	if (base.username !== '' || base.password !== '') {
		throw new Error('gui-auth-url: base URL must not include credentials');
	}
	return base;
}

/**
 * Whether a URL hostname is a loopback name this plugin will tokenise by default.
 * `127.0.0.0/8`, `localhost`, and `::1` count. `0.0.0.0` does not.
 * This runtime's `URL.hostname` keeps the brackets on an IPv6 address (`[::1]`).
 * @param {string} hostname - `URL.hostname`, with or without brackets.
 * @returns {boolean} true when the host is loopback.
 */
function isLoopbackHost(hostname) {
	let host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
	if (host === 'localhost' || host === '::1') return true;
	const parts = host.split('.');
	return parts.length === 4
		&& parts[0] === '127'
		&& parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

/**
 * Require the Host result to be the same http(s) origin with exactly one token.
 * @param {URL} base - accepted GUI base.
 * @param {unknown} url - value returned by `authenticatedUrl`.
 * @returns {URL} parsed authenticated URL.
 * @throws {Error} when the result is empty, a different origin, credentialed, or has no single token.
 */
function assertAuthResult(base, url) {
	if (typeof url !== 'string' || url === '') {
		throw new Error('gui-auth-url: authenticated URL must be a non-empty string');
	}
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('gui-auth-url: authenticated URL must be an absolute http or https URL');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('gui-auth-url: authenticated URL must be http or https');
	}
	if (parsed.username !== '' || parsed.password !== '') {
		throw new Error('gui-auth-url: authenticated URL must not include credentials');
	}
	if (parsed.origin !== base.origin) {
		throw new Error('gui-auth-url: authenticated URL origin does not match the GUI origin');
	}
	const tokens = parsed.searchParams.getAll('token').filter((token) => token !== '');
	if (tokens.length !== 1) {
		throw new Error('gui-auth-url: authenticated URL must carry exactly one token');
	}
	return parsed;
}

/**
 * Ask the Host for this process's authenticated GUI URL.
 * @param {object} ctx - plugin context.
 * @param {{allowPublic?: boolean}} [options] - `allowPublic: true` permits a non-loopback host.
 * @returns {{url: string, origin: string, protocol: string, host: string, port: string, secure: boolean}} auth URL facts.
 * @throws {Error} when the GUI, the base URL, the host policy, the connection service, or the returned URL is unacceptable.
 */
export function resolveGuiAuthUrl(ctx, options = {}) {
	const allowPublic = options?.allowPublic === true;
	const baseUrl = resolveGuiBaseUrl(ctx);
	const base = assertHttpBase(baseUrl);
	if (!allowPublic && !isLoopbackHost(base.hostname)) {
		throw new Error('gui-auth-url: refusing to attach the launch token to a non-loopback host');
	}
	const connection = service(ctx, CONNECTION);
	if (connection === undefined || typeof connection.authenticatedUrl !== 'function') {
		throw new Error('gui-auth-url: the connection service is unavailable, so no browser session can be minted');
	}
	const url = connection.authenticatedUrl(baseUrl);
	const parsed = assertAuthResult(base, url);
	return {
		url,
		origin: parsed.origin,
		protocol: parsed.protocol,
		host: parsed.hostname,
		port: parsed.port,
		secure: parsed.protocol === 'https:',
	};
}

export const internals = { service };

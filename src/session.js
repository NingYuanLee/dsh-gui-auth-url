/**
 * @module dsh-gui-session/session
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
 * cookie.
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
	throw new Error('gui-session: this profile serves no Web GUI (no webApp or webServer service); start the Web UI first');
}

/**
 * Ask the Host for this process's authenticated GUI URL.
 * @param {object} ctx - plugin context.
 * @returns {{url: string, origin: string, protocol: string, host: string, port: string, secure: boolean}} session facts.
 * @throws {Error} when the connection service is absent or the URL carries no token.
 */
export function resolveGuiSession(ctx) {
	const baseUrl = resolveGuiBaseUrl(ctx);
	const connection = service(ctx, CONNECTION);
	if (connection === undefined || typeof connection.authenticatedUrl !== 'function') {
		throw new Error('gui-session: the connection service is unavailable, so no browser session can be minted');
	}
	const url = connection.authenticatedUrl(baseUrl);
	const parsed = new URL(url);
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

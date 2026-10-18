import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGuiBaseUrl, resolveGuiAuthUrl } from '../src/auth-url.js';

/** Minimal fake Cordis context: services resolve through get() and properties. */
const contextOf = (services) => ({
	get: (name) => services[name],
	...services,
});

const connectionWith = (prefix) => ({
	authenticatedUrl: (baseUrl) => {
		const url = new URL(baseUrl);
		url.searchParams.set('token', 'launch-token');
		return url.href;
	},
});

test('prefers the advertised URL from webApp', () => {
	const ctx = contextOf({
		webApp: { getAdvertisedUrl: () => 'https://gui.example.com/prefix/' },
		webServer: { getOrigin: () => 'http://127.0.0.1:3080' },
	});
	assert.equal(resolveGuiBaseUrl(ctx), 'https://gui.example.com/prefix/');
});

test('falls back to the listener origin', () => {
	const ctx = contextOf({
		webServer: { getOrigin: () => 'http://127.0.0.1:62924' },
	});
	assert.equal(resolveGuiBaseUrl(ctx), 'http://127.0.0.1:62924');
});

test('falls back to protocol and port when getOrigin is absent', () => {
	const ctx = contextOf({ webServer: { protocol: 'http:', port: 62924 } });
	assert.equal(resolveGuiBaseUrl(ctx), 'http://127.0.0.1:62924');
});

test('rejects a profile that serves no Web GUI', () => {
	assert.throws(() => resolveGuiBaseUrl(contextOf({})), /serves no Web GUI/u);
});

test('returns the Host-minted authenticated URL and its parts', () => {
	const ctx = contextOf({
		webServer: { getOrigin: () => 'http://127.0.0.1:62924' },
		connection: connectionWith(),
	});
	const session = resolveGuiAuthUrl(ctx);
	assert.match(session.url, /^http:\/\/127\.0\.0\.1:62924\/\?token=launch-token$/u);
	assert.equal(session.origin, 'http://127.0.0.1:62924');
	assert.equal(session.protocol, 'http:');
	assert.equal(session.host, '127.0.0.1');
	assert.equal(session.port, '62924');
	assert.equal(session.secure, false);
});

test('marks TLS listeners secure', () => {
	const ctx = contextOf({
		webApp: { getAdvertisedUrl: () => 'https://127.0.0.1:8443' },
		connection: connectionWith(),
	});
	assert.equal(resolveGuiAuthUrl(ctx).secure, true);
});

test('refuses to answer when the connection service is missing', () => {
	const ctx = contextOf({ webServer: { getOrigin: () => 'http://127.0.0.1:62924' } });
	assert.throws(() => resolveGuiAuthUrl(ctx), /connection service is unavailable/u);
});

test('a real URL from connection carries exactly one token parameter', () => {
	const ctx = contextOf({
		webServer: { getOrigin: () => 'http://127.0.0.1:62924' },
		connection: {
			authenticatedUrl: (baseUrl) => {
				const url = new URL(baseUrl);
				url.searchParams.set('token', 'abc');
				return url.href;
			},
		},
	});
	const parsed = new URL(resolveGuiAuthUrl(ctx).url);
	assert.deepEqual(parsed.searchParams.getAll('token'), ['abc']);
});

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

/** Assert a refusal whose message does not contain a URL or a token. */
function assertRefusal(fn, pattern) {
	assert.throws(fn, (error) => {
		assert.match(error.message, pattern);
		assert.equal(error.message.includes('token='), false);
		assert.equal(error.message.includes('super-secret'), false);
		assert.equal(error.message.includes('://'), false);
		return true;
	});
}

test('accepts localhost and IPv6 loopback without allowPublic', () => {
	for (const baseUrl of ['http://localhost:3080/', 'http://[::1]:62924/']) {
		const ctx = contextOf({
			webApp: { getAdvertisedUrl: () => baseUrl },
			connection: connectionWith(),
		});
		const session = resolveGuiAuthUrl(ctx);
		assert.equal(new URL(session.url).searchParams.get('token'), 'launch-token');
		assert.equal(session.secure, false);
	}
});

test('rejects a non-http base before asking the Host for a token', () => {
	let called = false;
	const ctx = contextOf({
		webApp: { getAdvertisedUrl: () => 'javascript:alert(1)' },
		connection: { authenticatedUrl: () => { called = true; return 'http://127.0.0.1/?token=super-secret'; } },
	});
	assertRefusal(() => resolveGuiAuthUrl(ctx), /must be http or https/u);
	assert.equal(called, false);
});

test('rejects credentials in the base URL before asking for a token', () => {
	let called = false;
	const ctx = contextOf({
		webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:3080@evil.example/' },
		connection: { authenticatedUrl: () => { called = true; return 'http://evil.example/?token=super-secret'; } },
	});
	assertRefusal(() => resolveGuiAuthUrl(ctx), /must not include credentials/u);
	assert.equal(called, false);
});

test('refuses a public advertised host unless allowPublic is exactly true', () => {
	let called = false;
	const ctx = contextOf({
		webApp: { getAdvertisedUrl: () => 'https://gui.example.com/prefix/' },
		connection: {
			authenticatedUrl: (baseUrl) => {
				called = true;
				const url = new URL(baseUrl);
				url.searchParams.set('token', 'launch-token');
				return url.href;
			},
		},
	});
	assertRefusal(() => resolveGuiAuthUrl(ctx), /non-loopback host/u);
	assertRefusal(() => resolveGuiAuthUrl(ctx, { allowPublic: 'true' }), /non-loopback host/u);
	assert.equal(called, false);
	const session = resolveGuiAuthUrl(ctx, { allowPublic: true });
	assert.equal(session.url, 'https://gui.example.com/prefix/?token=launch-token');
	assert.equal(session.secure, true);
	assert.equal(called, true);
});

test('refuses a wildcard or LAN listener by default', () => {
	for (const origin of ['http://0.0.0.0:3080', 'http://192.168.1.20:3080']) {
		const ctx = contextOf({
			webServer: { getOrigin: () => origin },
			connection: connectionWith(),
		});
		assertRefusal(() => resolveGuiAuthUrl(ctx), /non-loopback host/u);
	}
});

test('does not echo a token when the authenticated origin differs', () => {
	const ctx = contextOf({
		webServer: { getOrigin: () => 'http://127.0.0.1:62924' },
		connection: { authenticatedUrl: () => 'https://evil.example/?token=super-secret' },
	});
	assertRefusal(() => resolveGuiAuthUrl(ctx), /origin does not match/u);
});

test('rejects a result that does not carry exactly one token', () => {
	const missing = contextOf({
		webServer: { getOrigin: () => 'http://127.0.0.1:62924' },
		connection: { authenticatedUrl: (baseUrl) => baseUrl },
	});
	assertRefusal(() => resolveGuiAuthUrl(missing), /exactly one token/u);
	const doubled = contextOf({
		webServer: { getOrigin: () => 'http://127.0.0.1:62924' },
		connection: {
			authenticatedUrl: (baseUrl) => {
				const url = new URL(baseUrl);
				url.searchParams.append('token', 'one');
				url.searchParams.append('token', 'two');
				return url.href;
			},
		},
	});
	assertRefusal(() => resolveGuiAuthUrl(doubled), /exactly one token/u);
});

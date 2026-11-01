import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_INSTALL_SPECS,
	PROFILE_NAME,
	hasLaunchOptions,
	installArgs,
	isExposed,
	launchArgs,
	normalizeLaunchRequest,
} from '../src/launch-options.js';

const OPEN = { allowPublic: true, allowInstall: true };

test('an absent request normalizes to an empty one', () => {
	for (const raw of [undefined, null, {}]) {
		assert.deepEqual(normalizeLaunchRequest(raw), { install: [], trustedHost: [] });
		assert.equal(hasLaunchOptions(normalizeLaunchRequest(raw)), false);
		assert.equal(isExposed(normalizeLaunchRequest(raw)), false);
		assert.deepEqual(launchArgs(normalizeLaunchRequest(raw)), []);
	}
});

test('model-facing snake_case names map to the internal spelling', () => {
	const request = normalizeLaunchRequest({
		public_url: 'https://gui.example.com/',
		tls_cert: '/certs/chain.pem',
		tls_key: '/certs/key.pem',
		trusted_host: ['gui.example.com', 'gui.example.com:8443'],
	}, OPEN);
	assert.equal(request.publicUrl, 'https://gui.example.com/');
	assert.equal(request.tlsCert, '/certs/chain.pem');
	assert.equal(request.tlsKey, '/certs/key.pem');
	assert.deepEqual(request.trustedHost, ['gui.example.com', 'gui.example.com:8443']);
	assert.equal(isExposed(request), true);
});

test('an unknown option is refused instead of being ignored', () => {
	assert.throws(() => normalizeLaunchRequest({ sandbox: true }), /unknown launch option sandbox/u);
	assert.throws(() => normalizeLaunchRequest([]), /launch options must be an object/u);
	assert.throws(() => normalizeLaunchRequest('host=1.2.3.4'), /launch options must be an object/u);
});

test('install is refused when the profile turns it off', () => {
	assert.throws(
		() => normalizeLaunchRequest({ install: ['github:you/plugin'] }, { allowInstall: false }),
		/install is disabled/u,
	);
	assert.deepEqual(
		normalizeLaunchRequest({ install: ['github:you/plugin'] }).install,
		['github:you/plugin'],
		'allowed by default',
	);
});

test('install specs are restricted to package-spec characters', () => {
	assert.deepEqual(
		normalizeLaunchRequest({
			install: ['@scope/pkg@1.2.3', 'github:owner/repo', 'file:../my-plugin', '..\\plugin'],
		}).install,
		['@scope/pkg@1.2.3', 'github:owner/repo', 'file:../my-plugin', '..\\plugin'],
	);
	for (const bad of ['a b', 'pkg; rm -rf /', 'pkg && calc', 'pkg"x"', "pkg'x'", 'pkg|cat', 'pkg$HOME', 'pkg`id`']) {
		assert.throws(() => normalizeLaunchRequest({ install: [bad] }), /install entry contains characters|must not start with a flag/u, bad);
	}
	assert.throws(() => normalizeLaunchRequest({ install: ['--registry=http://evil'] }), /must not start with a flag/u);
	assert.throws(() => normalizeLaunchRequest({ install: 'github:you/plugin' }), /install must be an array/u);
	assert.throws(() => normalizeLaunchRequest({ install: [''] }), /install entry must not be empty/u);
	assert.throws(
		() => normalizeLaunchRequest({ install: Array.from({ length: MAX_INSTALL_SPECS + 1 }, () => 'a') }),
		/at most 16 entries/u,
	);
});

test('exposure options are refused unless allowPublic is on', () => {
	for (const raw of [
		{ host: '192.168.1.5' },
		{ public_url: 'https://gui.example.com/' },
		{ tls_cert: '/a.pem', tls_key: '/b.pem' },
		{ trusted_host: ['gui.example.com'] },
	]) {
		assert.throws(() => normalizeLaunchRequest(raw), /requires allowPublic: true/u, JSON.stringify(raw));
	}
	assert.deepEqual(
		normalizeLaunchRequest({ port: 8080 }).port,
		8080,
		'a listen port alone is not an exposure decision',
	);
});

test('host must be one concrete IP literal', () => {
	assert.equal(normalizeLaunchRequest({ host: '192.168.1.5' }, OPEN).host, '192.168.1.5');
	assert.equal(normalizeLaunchRequest({ host: '::1' }, OPEN).host, '::1');
	for (const bad of ['0.0.0.0', '::', '*', 'gui.example.com', '192.168.1.5/24']) {
		assert.throws(() => normalizeLaunchRequest({ host: bad }, OPEN), /host must name one concrete local interface|host must be an IPv4 or IPv6 literal/u, bad);
	}
});

test('public_url must be an absolute http(s) root without credentials', () => {
	assert.equal(normalizeLaunchRequest({ public_url: 'https://gui.example.com/ui' }, OPEN).publicUrl, 'https://gui.example.com/ui');
	for (const bad of ['gui.example.com', 'ftp://gui.example.com/', 'https://user:pass@gui.example.com/']) {
		assert.throws(
			() => normalizeLaunchRequest({ public_url: bad }, OPEN),
			/public_url must be an absolute|public_url must be http|public_url must not include credentials/u,
			bad,
		);
	}
});

test('tls paths must come as a pair', () => {
	assert.throws(
		() => normalizeLaunchRequest({ tls_cert: '/a.pem' }, OPEN),
		/tls_cert and tls_key must be provided together/u,
	);
	assert.throws(
		() => normalizeLaunchRequest({ tls_key: '/b.pem' }, OPEN),
		/tls_cert and tls_key must be provided together/u,
	);
});

test('trusted_host entries are validated as authorities', () => {
	assert.throws(() => normalizeLaunchRequest({ trusted_host: ['a b'] }, OPEN), /not a host or host:port/u);
	assert.throws(() => normalizeLaunchRequest({ trusted_host: ['a&b'] }, OPEN), /not a host or host:port/u);
	assert.throws(() => normalizeLaunchRequest({ trusted_host: 'a' }, OPEN), /trusted_host must be an array/u);
});

test('port must be an integer inside the listen range', () => {
	assert.equal(normalizeLaunchRequest({ port: 0 }).port, 0);
	assert.equal(normalizeLaunchRequest({ port: 65535 }).port, 65535);
	for (const bad of [-1, 65536, 1.5, '8080', null]) {
		assert.throws(() => normalizeLaunchRequest({ port: bad }), /port must be an integer between 0 and 65535/u, String(bad));
	}
});

test('launchArgs emits dsh web flags in a stable order', () => {
	const args = launchArgs(normalizeLaunchRequest({
		host: '192.168.1.5',
		public_url: 'https://gui.example.com/',
		trusted_host: ['gui.example.com', 'gui.example.com:8443'],
		tls_cert: '/certs/chain.pem',
		tls_key: '/certs/key.pem',
	}, OPEN));
	assert.deepEqual(args, [
		'--host', '192.168.1.5',
		'--public-url', 'https://gui.example.com/',
		'--trusted-host', 'gui.example.com',
		'--trusted-host', 'gui.example.com:8443',
		'--tls-cert', '/certs/chain.pem',
		'--tls-key', '/certs/key.pem',
	]);
});

test('installArgs runs the package manager inside the disposable profile', () => {
	const launcher = { command: 'C:\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe', args: ['--expose-internals', 'cli.js'], env: {} };
	assert.deepEqual(installArgs(launcher, ['github:you/plugin', 'file:../p']), {
		command: launcher.command,
		args: ['--expose-internals', 'cli.js', 'plugin', '--profile', PROFILE_NAME, 'add', 'github:you/plugin', 'file:../p'],
	});
	assert.equal(PROFILE_NAME, 'web', 'the profile `dsh web` serves');
});

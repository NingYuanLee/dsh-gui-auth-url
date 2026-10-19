import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, apply, inject, name } from '../src/index.js';

/** Collect registrations from a fake tools service. */
function fakeContext(services) {
	const registered = [];
	return {
		registered,
		get: (serviceName) => services[serviceName],
		...services,
		tools: { register: (tool) => { registered.push(tool); return () => {}; } },
	};
}

const services = () => ({
	webServer: { getOrigin: () => 'http://127.0.0.1:62924' },
	connection: {
		authenticatedUrl: (baseUrl) => `${baseUrl}/?token=launch-token`,
	},
});

test('declares the services it needs', () => {
	assert.deepEqual(inject, ['connection', 'tools']);
	assert.equal(name, 'gui-auth-url');
});

test('registers exactly one gui_auth_url tool', () => {
	const ctx = fakeContext(services());
	apply(ctx);
	assert.equal(ctx.registered.length, 1);
	assert.equal(ctx.registered[0].name, 'gui_auth_url');
	assert.equal(typeof ctx.registered[0].description, 'string');
});

test('the tool takes no parameters', () => {
	const ctx = fakeContext(services());
	apply(ctx);
	const [tool] = ctx.registered;
	assert.equal(tool.parameters.type, 'object');
	assert.deepEqual(tool.parameters.properties, {});
});

test('executing the tool returns the authenticated GUI address', async () => {
	const ctx = fakeContext(services());
	apply(ctx);
	const result = await ctx.registered[0].execute({}, { signal: undefined });
	assert.equal(result.url, 'http://127.0.0.1:62924/?token=launch-token');
	assert.equal(result.secure, false);
});

test('the rendered content is the url itself', () => {
	const ctx = fakeContext(services());
	apply(ctx);
	const [tool] = ctx.registered;
	const rendered = tool.output.render({}, { url: 'http://127.0.0.1:62924/?token=t' });
	assert.deepEqual(rendered, [{ type: 'text', text: 'http://127.0.0.1:62924/?token=t' }]);
});

test('a rejected Host call surfaces as a tool error, not a fake URL', async () => {
	const ctx = fakeContext({ webServer: { getOrigin: () => 'http://127.0.0.1:62924' } });
	apply(ctx);
	await assert.rejects(() => ctx.registered[0].execute({}, { signal: undefined }), /connection service is unavailable/u);
});

test('config defaults to a closed public host and rejects other keys', () => {
	assert.deepEqual(Config['~standard'].validate(undefined).value, { allowPublic: false });
	assert.deepEqual(Config['~standard'].validate({}).value, { allowPublic: false });
	assert.deepEqual(Config['~standard'].validate({ allowPublic: true }).value, { allowPublic: true });
	assert.ok(Config['~standard'].validate({ allowPublic: 'true' }).issues);
	assert.ok(Config['~standard'].validate({ other: true }).issues);
	assert.ok(Config['~standard'].validate('nope').issues);
});

test('the tool refuses a public GUI unless allowPublic is true', async () => {
	const publicServices = {
		webApp: { getAdvertisedUrl: () => 'https://gui.example.com/' },
		connection: {
			authenticatedUrl: (baseUrl) => {
				const url = new URL(baseUrl);
				url.searchParams.set('token', 'launch-token');
				return url.href;
			},
		},
	};
	const denied = fakeContext(publicServices);
	apply(denied, { allowPublic: false });
	await assert.rejects(() => denied.registered[0].execute({}, { signal: undefined }), /non-loopback host/u);
	const allowed = fakeContext(publicServices);
	apply(allowed, { allowPublic: true });
	const result = await allowed.registered[0].execute({}, { signal: undefined });
	assert.equal(result.url, 'https://gui.example.com/?token=launch-token');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_KEY_REF, resolveDeepSeekApiKey } from '../src/api-key.js';

/** A context exposing only a credentials service. */
function credentialsContext(resolve) {
	return {
		get: (name) => (name === 'credentials' ? { resolve } : undefined),
	};
}

test('the inherited environment wins over the credentials seam', async () => {
	let resolved = 0;
	const ctx = credentialsContext(async () => {
		resolved += 1;
		return { value: 'from-store', source: 'file' };
	});
	assert.equal(await resolveDeepSeekApiKey(ctx, { [API_KEY_REF]: 'from-env' }), 'from-env');
	assert.equal(resolved, 0, 'a present environment value short-circuits the store');
});

test('the credentials seam is the fallback', async () => {
	const refs = [];
	const ctx = credentialsContext(async (ref) => {
		refs.push(ref);
		return { value: 'stored-key', source: 'file' };
	});
	assert.equal(await resolveDeepSeekApiKey(ctx, {}), 'stored-key');
	assert.deepEqual(refs, [API_KEY_REF]);
});

test('absent or empty values mean no key', async () => {
	assert.equal(await resolveDeepSeekApiKey(undefined, {}), undefined);
	assert.equal(await resolveDeepSeekApiKey({ get: () => undefined }, {}), undefined);
	assert.equal(await resolveDeepSeekApiKey(credentialsContext(async () => undefined), {}), undefined);
	assert.equal(await resolveDeepSeekApiKey(credentialsContext(async () => ({ value: '' })), {}), undefined);
	assert.equal(await resolveDeepSeekApiKey(credentialsContext(async () => ({ value: 'x' })), { [API_KEY_REF]: '' }), 'x');
});

test('a failing provider is treated as no key', async () => {
	const ctx = credentialsContext(async () => {
		throw new Error('provider exploded');
	});
	assert.equal(await resolveDeepSeekApiKey(ctx, {}), undefined);
});

test('the service is also reachable as a context property', async () => {
	const ctx = { credentials: { resolve: async () => ({ value: 'property-key' }) } };
	assert.equal(await resolveDeepSeekApiKey(ctx, {}), 'property-key');
});

test('a missing context never throws', async () => {
	assert.equal(await resolveDeepSeekApiKey(undefined, undefined), undefined);
});

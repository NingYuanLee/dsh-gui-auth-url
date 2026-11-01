import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const PRIMITIVES = {
	IconGlobeOutlineRegular: 'GLOBE_ICON',
	IconStopFillRegular: 'STOP_ICON',
};

/**
 * Run the shipped classic script in a bare window shim, capture the loader
 * entry it registers, and materialize its factory with module fixtures.
 * @param {object} [options] - language and primitives fixture (`null` = absent).
 * @returns {{id: string, plugin: object}} loader id plus the client plugin object.
 */
function loadClient({ lang = 'zh-CN', primitives = PRIMITIVES } = {}) {
	let captured;
	const sandbox = {
		window: { __ModuleLoader__: { load: (entry) => { captured = entry; } } },
		document: { documentElement: { lang } },
		navigator: { language: lang },
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: 'client.js' });
	const plugin = captured.factory((specifier) => {
		if (primitives === null) throw new Error(specifier + ' unavailable');
		return primitives;
	});
	return { id: captured.id, plugin };
}

/**
 * A client context whose `effect` runs the callback immediately and whose `on`
 * records listeners so a test can dispatch a client event.
 * @param {object} commandUi - the commandUi fixture.
 * @param {object} [services] - extra services resolved by name.
 * @returns {object} the context fixture plus a `listeners` map and `emit`.
 */
function fakeContext(commandUi, services = {}) {
	const disposers = [];
	const listeners = new Map();
	return {
		disposers,
		listeners,
		get: (serviceName) => (serviceName === 'commandUi' ? commandUi : services[serviceName]),
		on: (eventName, listener) => {
			listeners.set(eventName, listener);
		},
		emit: (eventName, ...args) => listeners.get(eventName)?.(...args),
		effect: (install) => {
			disposers.push(install());
		},
	};
}

/** A commandUi stand-in exposing the prototype-style candidates method. */
function fakeCommandUi(rows) {
	return {
		async candidates() {
			return rows;
		},
	};
}

/**
 * A client sessions stand-in: one session whose snapshot reports `blank`, plus
 * the session scope carrying the composer notice channel.
 * @param {object} [options] - session fixture.
 * @param {boolean} [options.blank] - the session snapshot's blank flag.
 * @returns {object} the service fixture and the notices it received.
 */
function fakeSessions({ blank = true } = {}) {
	const notified = [];
	const actx = {
		get: (serviceName) => (serviceName === 'conversation'
			? { input: { for: () => ({ notify: (level, text) => notified.push({ level, text }) }) } }
			: undefined),
	};
	return {
		notified,
		binding: (sessionId) => ({ session: { getSnapshot: () => ({ sessionId, blank }) } }),
		scope: (sessionId) => (sessionId === 'session-1' ? actx : undefined),
	};
}

const ROWS = () => [
	{ name: 'dsh-web', description: '启动或重启临时鉴权 DSH Web…' },
	{ name: 'web-gui', description: '已弃用的旧命令名…' },
	{ name: 'compact', description: '压缩以上对话内容' },
];

test('registers the client plugin under the package id', () => {
	const { id, plugin } = loadClient();
	assert.equal(id, 'dsh-gui-auth-url');
	assert.equal(plugin.name, 'dsh-gui-auth-url');
	assert.deepEqual([...plugin.inject], ['commandUi']);
	assert.equal(typeof plugin.apply, 'function');
});

test('the patch labels the command and hides the deprecated alias row', async () => {
	const commandUi = fakeCommandUi(ROWS());
	const original = commandUi.candidates;
	const ctx = fakeContext(commandUi);
	loadClient().plugin.apply(ctx);

	const rows = await commandUi.candidates({}, {});
	assert.deepEqual(rows.map((row) => row.name), ['dsh-web', 'compact'], 'the deprecated alias is not offered');
	assert.equal(rows[0].label, '临时鉴权 DSH Web');
	assert.equal(rows[0].icon, 'GLOBE_ICON');
	assert.equal(rows[1].label, undefined);
	assert.equal(rows[1].icon, undefined);

	ctx.disposers.forEach((dispose) => dispose?.());
	assert.equal(commandUi.candidates, original, 'dispose restores the original method');
});

test('the label follows the document language', async () => {
	const commandUi = fakeCommandUi(ROWS());
	loadClient({ lang: 'en-US' }).plugin.apply(fakeContext(commandUi));
	const rows = await commandUi.candidates({}, {});
	assert.equal(rows[0].label, 'Temporary Authenticated DSH Web');
});

test('a row that already carries an icon is left untouched', async () => {
	const rows = ROWS();
	rows[0] = { ...rows[0], icon: 'OFFICIAL_ICON' };
	const commandUi = fakeCommandUi(rows);
	loadClient().plugin.apply(fakeContext(commandUi));
	const patched = await commandUi.candidates({}, {});
	assert.equal(patched[0].icon, 'OFFICIAL_ICON');
	assert.equal(patched[0].label, undefined, 'no half-patch when the host already decorates the row');
});

test('missing primitives keeps the label and drops only the icon', async () => {
	const commandUi = fakeCommandUi(ROWS());
	loadClient({ primitives: null }).plugin.apply(fakeContext(commandUi));
	const rows = await commandUi.candidates({}, {});
	assert.equal(rows[0].label, '临时鉴权 DSH Web');
	assert.equal(rows[0].icon, undefined);
	assert.equal(rows[1].label, undefined);
	assert.equal(rows[1].icon, undefined);
});

test('a missing commandUi service leaves the menu alone', () => {
	const ctx = fakeContext(undefined);
	assert.doesNotThrow(() => loadClient().plugin.apply(ctx));
	assert.equal(ctx.disposers.length, 1);
	assert.equal(typeof ctx.disposers[0], 'function');
});

test('a service without the candidates method installs nothing', () => {
	const commandUi = {};
	assert.doesNotThrow(() => loadClient().plugin.apply(fakeContext(commandUi)));
	assert.equal(commandUi.candidates, undefined);
});

test('a throwing row is returned untouched instead of breaking the menu', async () => {
	const hostileRows = [Object.defineProperty({}, 'name', {
		get() {
			throw new Error('boom');
		},
	})];
	const hostile = fakeCommandUi(hostileRows);
	loadClient().plugin.apply(fakeContext(hostile));
	const rows = await hostile.candidates({}, {});
	assert.deepEqual(rows, hostileRows);
});

test('a blank-session command failure is repeated in the composer notice', () => {
	const sessions = fakeSessions();
	const ctx = fakeContext(fakeCommandUi(ROWS()), { sessions });
	loadClient().plugin.apply(ctx);

	ctx.emit('command/executed', 'session-1', 'dsh-web', { kind: 'error', text: '当前会话还没有消息，不能启动临时鉴权 DSH Web。' });

	assert.deepEqual(sessions.notified, [{ level: 'error', text: '当前会话还没有消息，不能启动临时鉴权 DSH Web。' }]);
});

test('an ordinary session relies on its flow node and gets no duplicate notice', () => {
	const sessions = fakeSessions({ blank: false });
	const ctx = fakeContext(fakeCommandUi(ROWS()), { sessions });
	loadClient().plugin.apply(ctx);

	ctx.emit('command/executed', 'session-1', 'dsh-web', { kind: 'error', text: '启动失败' });

	assert.deepEqual(sessions.notified, []);
});

test('other commands, successful results, and empty text are ignored', () => {
	const sessions = fakeSessions();
	const ctx = fakeContext(fakeCommandUi(ROWS()), { sessions });
	loadClient().plugin.apply(ctx);

	ctx.emit('command/executed', 'session-1', 'compact', { kind: 'error', text: '别的命令失败' });
	ctx.emit('command/executed', 'session-1', 'dsh-web', { kind: 'success' });
	ctx.emit('command/executed', 'session-1', 'dsh-web', { kind: 'error', text: '' });

	assert.deepEqual(sessions.notified, []);
});

test('a context without an event registry still mounts the menu patch', async () => {
	const commandUi = fakeCommandUi(ROWS());
	const ctx = fakeContext(commandUi);
	delete ctx.on;
	assert.doesNotThrow(() => loadClient().plugin.apply(ctx));
	const rows = await commandUi.candidates({}, {});
	assert.equal(rows[0].label, '临时鉴权 DSH Web');
});

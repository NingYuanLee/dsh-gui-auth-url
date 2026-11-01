import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
	COMMAND_DESCRIPTION,
	COMMAND_NAME,
	executeWebGuiCommand,
	openUrlInBrowser,
	registerWebGuiCommand,
	sessionIsBlank,
} from '../src/command.js';

const ISOLATED_URL = 'http://127.0.0.1:4123/?token=isolated';

/** A context with an optional command registry. */
function fakeContext({ withCommands = true } = {}) {
	const registered = [];
	const ctx = {
		registered,
		get: (serviceName) => (serviceName === 'commands' ? ctx.commands : undefined),
	};
	if (withCommands) {
		ctx.commands = {
			register: (definition) => {
				registered.push(definition);
				return () => {};
			},
		};
	}
	return ctx;
}

/** An instance-manager stand-in; the session id it was asked for is recorded. */
function fakeGui({ url = ISOLATED_URL, reused = false, sharedKey, autoRestart = false, portKept = true } = {}) {
	const calls = { ensure: 0, ensureOrRestart: 0, restart: 0, stop: 0, sessions: [] };
	return {
		calls,
		async ensure(sessionId) {
			calls.ensure += 1;
			calls.sessions.push(sessionId);
			return {
				url,
				reused,
				...sharedKey === undefined ? {} : { sharedKey },
			};
		},
		async ensureOrRestart(sessionId) {
			calls.ensureOrRestart += 1;
			if (!autoRestart) return this.ensure(sessionId);
			return this.restart(sessionId);
		},
		async restart(sessionId) {
			calls.restart += 1;
			calls.sessions.push(sessionId);
			return {
				url,
				reused: false,
				restarted: true,
				portKept,
				...sharedKey === undefined ? {} : { sharedKey },
			};
		},
		async stop() {
			calls.stop += 1;
			return true;
		},
	};
}

/** A spawn stand-in that reports a successful launch on the next tick. */
function fakeSpawn(calls, { fail = false } = {}) {
	return (command, args, options) => {
		const child = new EventEmitter();
		child.unref = () => {};
		calls.push({ command, args, options });
		process.nextTick(() => child.emit(fail ? 'error' : 'spawn'));
		return child;
	};
}

test('registers the human /dsh-web command plus its deprecated alias', () => {
	const ctx = fakeContext();
	assert.equal(registerWebGuiCommand(ctx, { gui: fakeGui() }), true);
	assert.deepEqual(ctx.registered.map((command) => command.name), [COMMAND_NAME, 'web-gui']);
	assert.equal(ctx.registered[0].name, 'dsh-web');
	assert.equal(ctx.registered[0].description, COMMAND_DESCRIPTION);
	assert.equal(typeof ctx.registered[0].handler, 'function');
	assert.equal(typeof ctx.registered[1].handler, 'function', 'the alias shares the handler');
});

test('the registered handler refuses a blank session through the Host projections', async () => {
	const ctx = fakeContext();
	const baseGet = ctx.get;
	ctx.get = (name) => name === 'sessionProjections'
		? { stateOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }) }
		: baseGet(name);
	const gui = fakeGui();
	registerWebGuiCommand(ctx, { gui });
	const result = await ctx.registered[0].handler({ agent: { id: 'session-1', session: {} } });
	assert.equal(result.kind, 'error');
	assert.match(result.text, /还没有消息/u);
	assert.equal(gui.calls.ensure, 0);
});

test('a composition without a command registry registers nothing', () => {
	const ctx = fakeContext({ withCommands: false });
	assert.equal(registerWebGuiCommand(ctx, { gui: fakeGui() }), false);
	assert.equal(ctx.registered.length, 0);
});

test('the command refuses to register without an instance manager', () => {
	const ctx = fakeContext();
	assert.equal(registerWebGuiCommand(ctx, { gui: { stop: async () => false } }), false);
	assert.equal(ctx.registered.length, 0);
});

test('the command starts an isolated host, opens it and reports the URL', async () => {
	const gui = fakeGui();
	const opened = [];
	const agent = { id: 'session-1' };
	const result = await executeWebGuiCommand(gui, { rawInput: '', agent }, {
		open: async (url) => {
			opened.push(url);
			return true;
		},
	});
	assert.equal(result.kind, 'success');
	assert.deepEqual(opened, [ISOLATED_URL]);
	assert.ok(result.text.includes(ISOLATED_URL));
	assert.match(result.text, /已启动临时鉴权 DSH Web/u);
	assert.match(result.text, /不共享当前 DSH_HOME/u);
	assert.match(result.text, /后台任务/u);
	assert.equal(gui.calls.ensureOrRestart, 1);
	assert.deepEqual(gui.calls.sessions, ['session-1'], 'the manager receives the session id, not the Agent object');
});

test('a running instance makes the single command restart in place', async () => {
	const gui = fakeGui({ autoRestart: true });
	const result = await executeWebGuiCommand(gui, { agent: { id: 'session-1' } }, { open: async () => true });
	assert.equal(result.kind, 'success');
	assert.equal(gui.calls.ensureOrRestart, 1);
	assert.equal(gui.calls.restart, 1);
	assert.match(result.text, /已原地重启临时鉴权 DSH Web/u);
	assert.match(result.text, /已安装的插件与配置都还在/u);
	assert.match(result.text, /端口沿用原值/u);
});

test('a restart that had to change ports says so', async () => {
	const gui = fakeGui({ autoRestart: true, portKept: false });
	const result = await executeWebGuiCommand(gui, { agent: { id: 'session-1' } }, { open: async () => true });
	assert.equal(result.kind, 'success');
	assert.match(result.text, /端口已更换/u);
	assert.match(result.text, /新链接/u);
});

test('an invocation without a live agent id forwards no owner and surfaces the refusal', async () => {
	const gui = fakeGui();
	gui.ensureOrRestart = async (sessionId) => {
		gui.calls.sessions.push(sessionId);
		throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
	};
	const result = await executeWebGuiCommand(gui, {}, { open: async () => true });
	assert.deepEqual(gui.calls.sessions, [undefined]);
	assert.equal(result.kind, 'error');
	assert.match(result.text, /requires a session-bound owner/u, 'the refusal is reported, never downgraded to an unowned host');
});

test('a blank session is refused instead of starting an unstoppable host', async () => {
	const gui = fakeGui();
	const result = await executeWebGuiCommand(gui, { agent: { id: 'session-1' } }, {
		isBlank: () => true,
		open: async () => true,
	});
	assert.equal(result.kind, 'error');
	assert.match(result.text, /还没有消息/u);
	assert.match(result.text, /再执行 \/dsh-web/u);
	assert.equal(gui.calls.ensure, 0, 'nothing is spawned for a session that will disappear');
});

test('sessionIsBlank follows the turn-boundary projection', () => {
	const stateOf = (boundary) => ({ stateOf: () => boundary });
	const session = {};
	assert.equal(sessionIsBlank({ get: () => stateOf(undefined) }, { session }), true, 'no boundary means no turn yet');
	assert.equal(sessionIsBlank({ get: () => stateOf({ openTurnStartSeq: null, lastTurn: 0 }) }, { session }), true);
	assert.equal(sessionIsBlank({ get: () => stateOf({ openTurnStartSeq: 3, lastTurn: 1 }) }, { session }), false);
	assert.equal(sessionIsBlank({ get: () => undefined }, { session }), false, 'an absent service never blocks the command');
	assert.equal(sessionIsBlank({ get: () => ({ stateOf: () => { throw new Error('boom'); } }) }, { session }), false);
});

test('a reused instance is reported as reused', async () => {
	const result = await executeWebGuiCommand(fakeGui({ reused: true }), {}, { open: async () => true });
	assert.equal(result.kind, 'success');
	assert.match(result.text, /复用了已启动的临时实例/u);
});

test('a started instance is reported as this session\'s tracked background job', async () => {
	const result = await executeWebGuiCommand(fakeGui(), {}, { open: async () => true });
	assert.equal(result.kind, 'success');
	assert.match(result.text, /本会话的后台任务/u);
	assert.match(result.text, /归档这个会话时若它仍在运行/u);
});

test('sharing the API key is the default', async () => {
	const result = await executeWebGuiCommand(fakeGui({ sharedKey: true }), {}, { open: async () => true });
	assert.equal(result.kind, 'success');
	assert.match(result.text, /DEEPSEEK_API_KEY 复制给隔离实例/u);
	assert.ok(!result.text.includes('DEEPSEEK_API_KEY='), 'the value itself is never printed');
});

test('a shared API key is reported to the human', async () => {
	const result = await executeWebGuiCommand(fakeGui({ sharedKey: true }), {}, {
		shareApiKey: true,
		open: async () => true,
	});
	assert.equal(result.kind, 'success');
	assert.match(result.text, /已把当前桌面端的 DEEPSEEK_API_KEY 复制给隔离实例/u);
	assert.ok(!result.text.includes('DEEPSEEK_API_KEY='), 'the value itself is never printed');
});

test('sharing requested but no key found says the instance needs a login', async () => {
	const result = await executeWebGuiCommand(fakeGui({ sharedKey: false }), {}, {
		shareApiKey: true,
		open: async () => true,
	});
	assert.equal(result.kind, 'success');
	assert.match(result.text, /没找到可共享的 DEEPSEEK_API_KEY/u);
});

test('sharing off keeps the isolated instance credential-free', async () => {
	const result = await executeWebGuiCommand(fakeGui(), {}, { shareApiKey: false, open: async () => true });
	assert.equal(result.kind, 'success');
	assert.match(result.text, /未共享凭据/u);
});

test('openBrowser: false leaves the browser alone', async () => {
	let opened = 0;
	const result = await executeWebGuiCommand(fakeGui(), {}, {
		openBrowser: false,
		open: async () => {
			opened += 1;
			return true;
		},
	});
	assert.equal(opened, 0);
	assert.equal(result.kind, 'success');
	assert.match(result.text, /未能自动打开浏览器/u);
});

test('a failing opener still returns the URL', async () => {
	const result = await executeWebGuiCommand(fakeGui(), {}, {
		open: async () => {
			throw new Error('no browser here');
		},
	});
	assert.equal(result.kind, 'success');
	assert.ok(result.text.includes(ISOLATED_URL));
	assert.match(result.text, /未能自动打开浏览器/u);
});

test('a failed start is an error, not a URL', async () => {
	const gui = fakeGui();
	gui.ensure = async () => {
		throw new Error('dsh web exited before announcing a URL (failed)');
	};
	const result = await executeWebGuiCommand(gui, {}, { open: async () => true });
	assert.equal(result.kind, 'error');
	assert.ok(!result.text.includes('token='));
	assert.match(result.text, /启动临时鉴权 DSH Web 失败/u);
});

test('trailing input is a usage error that points at the task roster', async () => {
	const result = await executeWebGuiCommand(fakeGui(), { rawInput: ' stop' }, {});
	assert.equal(result.kind, 'error');
	assert.match(result.text, /后台任务/u);
});

test('/dsh-web restart restarts in place and keeps the temporary profile', async () => {
	const gui = fakeGui();
	const result = await executeWebGuiCommand(gui, { rawInput: 'restart', agent: { id: 'session-1' } }, { open: async () => true });
	assert.equal(result.kind, 'success');
	assert.equal(gui.calls.restart, 1);
	assert.equal(gui.calls.ensure, 0, 'a restart never starts a fresh instance');
	assert.deepEqual(gui.calls.sessions, ['session-1']);
	assert.match(result.text, /原地重启/u);
	assert.match(result.text, /已安装的插件与配置都还在/u);
});

test('a failed restart reports restart rather than start', async () => {
	const gui = fakeGui();
	gui.restart = async () => {
		throw new Error('no isolated Web GUI is running for this session; start one before restarting');
	};
	const result = await executeWebGuiCommand(gui, { rawInput: 'restart' }, { open: async () => true });
	assert.equal(result.kind, 'error');
	assert.match(result.text, /重启临时鉴权 DSH Web 失败/u);
	assert.match(result.text, /no isolated Web GUI is running/u);
});

test('openUrlInBrowser prefers the Electron shell when the Host runs inside Electron', async () => {
	const calls = [];
	const opened = [];
	const result = await openUrlInBrowser(ISOLATED_URL, {
		platform: 'win32',
		electronOpen: async (url) => {
			opened.push(url);
			return true;
		},
		spawn: fakeSpawn(calls),
	});
	assert.equal(result, true);
	assert.deepEqual(opened, [ISOLATED_URL]);
	assert.equal(calls.length, 0, 'the shell API wins over spawning');
});

test('openUrlInBrowser maps each platform to its launcher', async () => {
	for (const [platform, expected] of [
		['win32', 'rundll32.exe'],
		['darwin', 'open'],
		['linux', 'xdg-open'],
	]) {
		const calls = [];
		const result = await openUrlInBrowser(ISOLATED_URL, {
			platform,
			electronOpen: async () => undefined,
			spawn: fakeSpawn(calls),
			settleMs: 10,
		});
		assert.equal(result, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].command, expected);
		assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore', windowsHide: true });
		if (platform === 'win32') {
			assert.deepEqual(calls[0].args, ['url.dll,FileProtocolHandler', ISOLATED_URL]);
		} else {
			assert.deepEqual(calls[0].args, [ISOLATED_URL]);
		}
	}
});

test('openUrlInBrowser falls through a launcher that exits non-zero', async () => {
	const calls = [];
	const spawn = (command, args, options) => {
		const child = new EventEmitter();
		child.unref = () => {};
		calls.push({ command, args, options });
		process.nextTick(() => {
			child.emit('spawn');
			if (calls.length === 1) child.emit('exit', 1);
		});
		return child;
	};
	const result = await openUrlInBrowser(ISOLATED_URL, {
		platform: 'win32',
		electronOpen: async () => undefined,
		spawn,
		settleMs: 10,
	});
	assert.equal(result, true);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].command, 'cmd.exe');
	assert.equal(calls[1].args.at(-1), `start "" "${ISOLATED_URL}"`);
});

test('openUrlInBrowser reports a launcher that cannot start', async () => {
	const calls = [];
	assert.equal(await openUrlInBrowser(ISOLATED_URL, {
		platform: 'linux',
		electronOpen: async () => undefined,
		spawn: fakeSpawn(calls, { fail: true }),
		settleMs: 10,
	}), false);
	assert.equal(await openUrlInBrowser(ISOLATED_URL, {
		platform: 'linux',
		electronOpen: async () => undefined,
		spawn: () => {
			throw new Error('spawn unavailable');
		},
		settleMs: 10,
	}), false);
});

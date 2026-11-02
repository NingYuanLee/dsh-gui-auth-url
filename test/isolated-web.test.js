import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { INSTANCE_PREFIX, ownerRecordPath } from '../src/instance-home.js';
import {
	HOME_PREFIX,
	MARKER_FILENAME,
	createIsolatedWebGui,
	killTree,
	parseLaunchedUrl,
	parseNetstatListeners,
	resolveLauncher,
	resolvePortOwnerFrom,
	sweepStaleHomes,
} from '../src/isolated-web.js';

/** A child process stand-in with a stdout stream the test can feed. */
function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.exitCode = null;
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		process.nextTick(() => {
			child.exitCode = 0;
			child.emit('exit', 0);
		});
		return true;
	};
	return child;
}

/** Spawn stand-in that records argv/env and announces the URL on the next tick. */
function fakeSpawn(calls, { url = 'http://127.0.0.1:4123/?token=t', fail = false } = {}) {
	return (command, args, options) => {
		const child = fakeChild();
		calls.push({ command, args, options, child });
		process.nextTick(() => {
			if (fail) {
				child.exitCode = 1;
				child.emit('exit', 1);
				return;
			}
			child.stdout.emit('data', Buffer.from(`dsh web: ${url}\n`));
		});
		return child;
	};
}

/** Minimal `ctx.jobs` stand-in: records jobs, enforces the session-id owner fence, kills synchronously. */
function fakeJobs() {
	const records = new Map();
	const counters = new Map();
	const calls = { kill: [], wait: [] };
	const fence = (record, caller) => {
		if (record.owner !== undefined && caller !== record.owner) throw new Error(`job ${record.id} belongs to another session`);
	};
	return {
		records,
		calls,
		start(spec) {
			// Mirror the real registry: an owner is a session-id string, never an Agent object.
			if (spec.owner !== undefined && typeof spec.owner !== 'string') {
				throw new Error(`session "${String(spec.owner)}" has no live agent (background job owner must be live)`);
			}
			const count = (counters.get(spec.kind) ?? 0) + 1;
			counters.set(spec.kind, count);
			const id = `${spec.kind}-${count}`;
			const hooks = spec.run();
			const record = { id, kind: spec.kind, label: spec.label, owner: spec.owner, status: 'running', hooks, killed: false };
			records.set(id, record);
			hooks.done.then((outcome) => {
				record.outcome = outcome;
				record.status = record.killed ? 'killed' : outcome.status;
				record.detail = outcome.detail;
			});
			return id;
		},
		get(id, caller) {
			const record = records.get(id);
			if (record === undefined) throw new Error(`unknown job ${id}`);
			fence(record, caller);
			return { id: record.id, kind: record.kind, label: record.label, owner: record.owner, status: record.status, detail: record.detail };
		},
		kill(id, caller, reason) {
			calls.kill.push({ id, caller, reason });
			const record = records.get(id);
			if (record === undefined) throw new Error(`unknown job ${id}`);
			fence(record, caller);
			if (record.status !== 'running') return;
			record.killed = true;
			record.hooks.cancel('test');
		},
		wait(id, timeoutMs, caller) {
			calls.wait.push({ id, caller, timeoutMs });
			const record = records.get(id);
			if (record === undefined) throw new Error(`unknown job ${id}`);
			return record.hooks.done.then(() => this.get(id, caller));
		},
	};
}

/** Manager wired to a fake registry and spawn, with no real temp dirs by default. */
function manager(options = {}) {
	const calls = [];
	const jobs = fakeJobs();
	const removed = [];
	const gui = createIsolatedWebGui({
		jobs,
		spawn: fakeSpawn(calls),
		launcher: { command: 'dsh', args: [], env: {} },
		pollMs: 5,
		makeHome: async () => join(tmpdir(), `${HOME_PREFIX}test`),
		removeHome: async (home) => {
			removed.push(home);
		},
		...options,
	});
	return { gui, calls, jobs, removed };
}

test('parseLaunchedUrl reads the one announced line', () => {
	assert.equal(parseLaunchedUrl('dsh web: http://127.0.0.1:3080/?token=abc\n'), 'http://127.0.0.1:3080/?token=abc');
	assert.equal(parseLaunchedUrl('booting...\ndsh web: https://gui.example.com/?token=t\n'), 'https://gui.example.com/?token=t');
	assert.equal(parseLaunchedUrl('dsh web: not-a-url\n'), undefined);
	assert.equal(parseLaunchedUrl('dsh web: ftp://127.0.0.1/x\n'), undefined);
	assert.equal(parseLaunchedUrl(''), undefined);
	assert.equal(parseLaunchedUrl(undefined), undefined);
});

test('resolveLauncher prefers the app executable with the desktop-host CLI', () => {
	const launcher = resolveLauncher({
		execPath: 'C:\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
		platform: 'win32',
		exists: () => true,
	});
	assert.equal(launcher.command, 'C:\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe');
	assert.equal(launcher.env.ELECTRON_RUN_AS_NODE, '1');
	// `dirname` treats backslashes as separators only on Windows, so assert the
	// tail rather than a whole path built with the host platform's `join`.
	assert.match(launcher.args.at(-1), /resources[\\/]app\.asar[\\/]dsh[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]cli\.js$/u);
});

test('resolveLauncher falls back to dsh on PATH', () => {
	const win = resolveLauncher({ execPath: 'C:\\node\\node.exe', platform: 'win32', exists: () => false });
	assert.equal(win.command, 'cmd.exe');
	assert.deepEqual(win.args, ['/d', '/s', '/c', 'dsh']);
	const linux = resolveLauncher({ execPath: '/usr/bin/node', platform: 'linux', exists: () => false });
	assert.equal(linux.command, 'dsh');
});

test('ensure registers a tracked job owned by the session id and reuses it', async () => {
	const { gui, calls, jobs } = manager();
	const session = 'session-1';

	const first = await gui.ensure(session);
	assert.equal(first.reused, false);
	assert.equal(first.url, 'http://127.0.0.1:4123/?token=t');
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].args.slice(-4), ['web', '--no-open', '--port', '0']);
	assert.equal(calls[0].options.env.DSH_HOME, join(tmpdir(), `${HOME_PREFIX}test`));
	assert.equal(calls[0].options.stdio[1], 'pipe');

	const record = [...jobs.records.values()][0];
	assert.equal(record.kind, 'web-gui');
	assert.equal(record.label, '临时鉴权 DSH Web（dsh web）');
	assert.equal(record.owner, session, 'the registry owner is the invoking session id string');
	assert.equal(record.status, 'running');

	const second = await gui.ensure(session);
	assert.equal(second.reused, true);
	assert.equal(second.url, first.url);
	assert.equal(calls.length, 1);

	await gui.stop();
	assert.deepEqual(jobs.calls.kill.at(-1), { id: record.id, caller: session, reason: 'stopped by /dsh-web' });
	assert.equal(jobs.calls.wait.at(-1).caller, session);
});

test('each session owns its own instance and starting one stops nothing', async () => {
	const { gui, calls, jobs } = manager();
	const first = await gui.ensure('session-1');
	const second = await gui.ensure('session-2');
	assert.equal(calls.length, 2, 'a second session spawns its own host');
	assert.equal(first.jobId, 'web-gui-1');
	assert.equal(second.jobId, 'web-gui-2');
	assert.deepEqual(jobs.calls.kill, [], 'no other session is stopped');
	assert.equal(jobs.records.get(second.jobId).owner, 'session-2');
	await gui.stop();
});

test('stopping one session leaves the other session running', async () => {
	const { gui, jobs } = manager();
	const first = await gui.ensure('session-1');
	const second = await gui.ensure('session-2');

	assert.equal(await gui.stop('session-1'), true);
	assert.equal(jobs.records.get(first.jobId).status, 'killed');
	assert.equal(jobs.records.get(second.jobId).status, 'running', 'the other session is untouched');

	assert.equal(await gui.stop('session-2'), true);
	assert.equal(jobs.records.get(second.jobId).status, 'killed');
	assert.equal(await gui.stop('session-1'), false, 'already stopped');
});

test('a call without a session id is refused before anything is spawned', async () => {
	const { gui, calls } = manager();
	await assert.rejects(() => gui.ensure(undefined), /session-bound owner/u);
	await assert.rejects(() => gui.ensure(''), /session-bound owner/u);
	assert.equal(calls.length, 0, 'no unowned host is ever created');
});

test('a registry that refuses the ownership binding fails the start', async () => {
	const calls = [];
	const jobs = fakeJobs();
	jobs.start = () => {
		throw new Error('session "session-1" has no live agent (background job owner must be live)');
	};
	const removed = [];
	const gui = createIsolatedWebGui({
		jobs,
		spawn: fakeSpawn(calls),
		launcher: { command: 'dsh', args: [], env: {} },
		pollMs: 5,
		makeHome: async () => join(tmpdir(), `${HOME_PREFIX}refused`),
		removeHome: async (home) => {
			removed.push(home);
		},
	});
	await assert.rejects(() => gui.ensure('session-1'), /no live agent/u);
	assert.equal(calls.length, 0, 'nothing degrades to an unowned job');
	assert.deepEqual(removed, [join(tmpdir(), `${HOME_PREFIX}refused`)], 'the prepared home is cleaned up');
});

test('a composition without the job registry refuses to create a manager', () => {
	assert.throws(() => createIsolatedWebGui({}), /session job registry/u);
	assert.throws(() => createIsolatedWebGui({ jobs: {} }), /session job registry/u);
});

test('a non-ownership registry error still fails the command', async () => {
	const jobs = fakeJobs();
	jobs.start = () => {
		throw new Error('background job limit reached for this owner');
	};
	const gui = createIsolatedWebGui({
		jobs,
		spawn: fakeSpawn([]),
		launcher: { command: 'dsh', args: [], env: {} },
		pollMs: 5,
		makeHome: async () => join(tmpdir(), `${HOME_PREFIX}limit`),
		removeHome: async () => {},
	});
	await assert.rejects(() => gui.ensure('session-1'), /limit reached/u);
});

test('a host that exits before announcing a URL fails and cleans its home', async () => {
	const { gui, removed } = manager({ spawn: fakeSpawn([], { fail: true }) });
	await assert.rejects(() => gui.ensure('session-1'), /exited before announcing a URL/u);
	assert.ok(removed.includes(join(tmpdir(), `${HOME_PREFIX}test`)));
});

test('a silent host times out, is killed, and cleaned up', async () => {
	const calls = [];
	const { gui, removed } = manager({
		spawn: (command, args, options) => {
			const child = fakeChild();
			calls.push({ command, args, options, child });
			return child;
		},
		startTimeoutMs: 20,
	});
	await assert.rejects(() => gui.ensure('session-1'), /did not announce a URL/u);
	assert.equal(calls[0].child.killed, true);
	assert.ok(removed.includes(join(tmpdir(), `${HOME_PREFIX}test`)));
});

test('a tracked instance whose job record vanished is still stopped and cleaned', async () => {
	const { gui, jobs, calls, removed } = manager();
	await gui.ensure('session-1');
	const record = [...jobs.records.values()][0];
	jobs.records.delete(record.id);

	await gui.stop();
	assert.equal(calls[0].child.killed, true, 'the backstop kills a child the registry already dropped');
	assert.ok(removed.includes(join(tmpdir(), `${HOME_PREFIX}test`)), 'its temporary home is removed');
});

test('a stale instance is settled before a new one starts', async () => {
	const { gui, jobs, calls } = manager();
	await gui.ensure('session-1');
	const first = [...jobs.records.values()][0];
	jobs.records.delete(first.id);

	const outcome = await gui.ensure('session-1');
	assert.equal(outcome.reused, false);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].child.killed, true, 'the previous child is not left running');
	await gui.stop();
});

test('dispose cancels the job like stop', async () => {
	const { gui, jobs, removed } = manager();
	await gui.ensure('session-1');
	await gui.dispose();
	const record = [...jobs.records.values()][0];
	assert.equal(record.status, 'killed');
	assert.ok(removed.includes(join(tmpdir(), `${HOME_PREFIX}test`)));
	assert.equal(await gui.stop(), false, 'already stopped');
});

test('a host ended on request settles as killed, not failed', async () => {
	const { gui, jobs } = manager();
	const first = await gui.ensure('session-1');
	await gui.stop('session-1');
	const record = jobs.records.get(first.jobId);
	assert.equal(record.outcome.status, 'killed', 'the roster would otherwise label a taskkill as a crash');
	assert.equal(record.status, 'killed');
});

test('a new host is refused once the instance cap is reached', async () => {
	const { gui, calls } = manager({ maxInstances: 2 });
	await gui.ensure('session-1');
	await gui.ensure('session-2');
	await assert.rejects(() => gui.ensure('session-3'), /limit reached: 2 of 2/u);
	assert.equal(calls.length, 2, 'the refused call spawns nothing');

	await gui.stop('session-1');
	const third = await gui.ensure('session-3');
	assert.equal(third.reused, false);
	assert.equal(calls.length, 3, 'the freed slot admits the next host');
	await gui.stop();
});

test('restart replaces the host but keeps its temporary home', async () => {
	const { gui, calls, jobs, removed } = manager();
	const first = await gui.ensure('session-1');
	const home = calls[0].options.env.DSH_HOME;

	const restarted = await gui.restart('session-1');
	assert.equal(restarted.restarted, true);
	assert.equal(restarted.portKept, true, 'the previous port is reused');
	assert.equal(calls.length, 2, 'a replacement host process is spawned');
	assert.equal(calls[1].options.env.DSH_HOME, home, 'the same temporary home is reused');
	assert.deepEqual(calls[1].args.slice(-2), ['--port', '4123'], 'the restart asks for the previous port');
	assert.notEqual(restarted.jobId, first.jobId, 'the background job is replaced');
	assert.equal(jobs.records.get(first.jobId).status, 'killed', 'the replaced host was settled on request');
	assert.deepEqual(removed, [], 'the home survives the restart');

	await gui.stop('session-1');
	assert.ok(removed.includes(home), 'a normal stop still removes the home');
});

test('a late exit from the replaced host never deletes the restarted home', async () => {
	const calls = [];
	const removed = [];
	// A killed host whose `exit` event has not been delivered yet: the manager
	// proves the exit by the pid disappearing, and the event arrives afterwards.
	const spawn = (command, args, options) => {
		const child = fakeChild();
		// A pid lets the manager prove the exit by the process disappearing while
		// the child's own `exit` event is still in flight.
		child.pid = 987654;
		calls.push({ command, args, options, child });
		child.kill = () => {
			child.killed = true;
			return true;
		};
		process.nextTick(() => {
			child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:4123/?token=t\n'));
		});
		return child;
	};
	const gui = createIsolatedWebGui({
		jobs: fakeJobs(),
		spawn,
		launcher: { command: 'dsh', args: [], env: {} },
		pollMs: 5,
		stopTimeoutMs: 50,
		waitGone: async () => true,
		makeHome: async () => join(tmpdir(), `${HOME_PREFIX}late-exit`),
		removeHome: async (home) => {
			removed.push(home);
		},
	});
	await gui.ensure('session-1');
	const restarted = await gui.restart('session-1');
	assert.deepEqual(removed, [], 'the restarted home survives the replacement');

	// The replaced host's exit lands only now: it must not clean a home the
	// replacement already owns, or the next stop cites a deleted ownership record.
	calls[0].child.emit('exit', 0);
	await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	assert.deepEqual(removed, [], 'a late exit from the replaced host deletes nothing');

	calls[1].child.emit('exit', 0);
	await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	assert.deepEqual(removed, [calls[1].options.env.DSH_HOME], 'the current host still cleans its own home');
	assert.equal(restarted.restarted, true);
});

test('a restart falls back to an OS-assigned port when the old one is unavailable', async () => {
	let call = 0;
	const calls = [];
	const spawn = (command, args, options) => {
		call += 1;
		const child = fakeChild();
		calls.push({ command, args, options, child });
		const port = args[args.indexOf('--port') + 1];
		process.nextTick(() => {
			if (port !== '0') {
				// The fixed port is taken: the host reports the conflict and exits
				// before announcing a URL.
				child.stderr.emit('data', Buffer.from('Error: listen EADDRINUSE: address already in use 127.0.0.1:4123\n'));
				child.exitCode = 1;
				child.emit('exit', 1);
				return;
			}
			// Each OS-assigned attempt lands on a different port.
			child.stdout.emit('data', Buffer.from(`dsh web: http://127.0.0.1:${String(4500 + call)}/?token=t\n`));
		});
		return child;
	};
	const gui = createIsolatedWebGui({
		jobs: fakeJobs(),
		spawn,
		launcher: { command: 'dsh', args: [], env: {} },
		pollMs: 5,
		makeHome: async () => join(tmpdir(), `${HOME_PREFIX}portfallback`),
		removeHome: async () => {},
	});
	await gui.ensure('session-1');
	const restarted = await gui.restart('session-1');
	assert.equal(restarted.portKept, false, 'the busy port is reported as changed');
	assert.match(restarted.url, /:4503\//u, 'the fallback host listens on a new OS-assigned port');
	assert.equal(calls.length, 3, 'one failed attempt on the old port, then a fresh one');
	await gui.stop();
});

test('a restart never retries after an unconfirmed exit', async () => {
	const calls = [];
	const removed = [];
	const root = await mkdtemp(join(tmpdir(), 'dsh-restart-'));
	try {
		const home = join(root, 'kept-home');
		let phase = 0;
		const spawn = () => {
			phase += 1;
			const child = fakeChild();
			calls.push(child);
			if (phase === 1) {
				process.nextTick(() => {
					child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:4123/?token=t\n'));
				});
			} else {
				// The replacement host never announces, never exits and ignores kill.
				child.kill = () => {};
			}
			return child;
		};
		const gui = createIsolatedWebGui({
			jobs: fakeJobs(),
			spawn,
			launcher: { command: 'dsh', args: [], env: {} },
			makeHome: async () => {
				await mkdir(home, { recursive: true });
				return home;
			},
			removeHome: async (path) => removed.push(path),
			pollMs: 5,
			startTimeoutMs: 30,
			stopTimeoutMs: 50,
			waitGone: async () => false,
		});
		await gui.ensure('session-1');
		await assert.rejects(() => gui.restart('session-1'), /exit could not be confirmed/);
		assert.equal(calls.length, 2, 'no second replacement is started after an unconfirmed exit');
		assert.deepEqual(removed, [], 'the preserved home is not deleted');
		assert.ok(existsSync(home), 'the home stays');
		assert.equal(gui.status('session-1').home, home, 'the failed instance stays tracked');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('restart without a running instance is refused', async () => {
	const { gui, calls } = manager();
	await assert.rejects(() => gui.restart('session-1'), /no isolated Web GUI is running/u);
	assert.equal(calls.length, 0, 'nothing is spawned for a restart with no home to keep');
});

test('ensureOrRestart starts when absent and restarts in place when running', async () => {
	const { gui, calls, jobs, removed } = manager();

	const first = await gui.ensureOrRestart('session-1');
	assert.equal(first.restarted, false, 'no instance yet means a fresh start');
	assert.equal(calls.length, 1);

	const home = calls[0].options.env.DSH_HOME;
	const again = await gui.ensureOrRestart('session-1');
	assert.equal(again.restarted, true, 'a running instance takes the restart branch');
	assert.equal(calls.length, 2, 'the host process is replaced');
	assert.equal(calls[1].options.env.DSH_HOME, home, 'the temporary home survives the auto restart');
	assert.notEqual(again.jobId, first.jobId);
	assert.equal(jobs.records.get(first.jobId).status, 'killed');
	assert.deepEqual(removed, [], 'the home is kept by the auto restart');

	await gui.stop();
});

test('a real temporary home is created under the plugin directory and removed on stop', async () => {
	const previous = process.env.DSH_HOME;
	const root = await mkdtemp(join(tmpdir(), 'dsh-home-'));
	process.env.DSH_HOME = root;
	try {
		const calls = [];
		const gui = createIsolatedWebGui({
			jobs: fakeJobs(),
			spawn: fakeSpawn(calls),
			launcher: { command: 'dsh', args: [], env: {} },
			pollMs: 5,
		});
		await gui.ensure('session-1');
		const home = calls[0].options.env.DSH_HOME;
		assert.ok(
			home.startsWith(join(root, 'dsh-gui-auth-url', 'instances')),
			'home lives in the plugin directory inside the Harness home',
		);
		assert.ok(existsSync(home), 'home exists while the instance runs');
		await gui.stop();
		assert.equal(existsSync(home), false, 'home is gone after stop');
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test('the instances root is pinned at construction and survives a $DSH_HOME change', async () => {
	const previous = process.env.DSH_HOME;
	const firstHome = await mkdtemp(join(tmpdir(), 'dsh-home-a-'));
	const secondHome = await mkdtemp(join(tmpdir(), 'dsh-home-b-'));
	process.env.DSH_HOME = firstHome;
	try {
		const calls = [];
		const gui = createIsolatedWebGui({
			jobs: fakeJobs(),
			spawn: fakeSpawn(calls),
			launcher: { command: 'dsh', args: [], env: {} },
			pollMs: 5,
		});
		await gui.ensure('session-1');
		const first = calls[0].options.env.DSH_HOME;
		assert.ok(first.startsWith(join(firstHome, 'dsh-gui-auth-url', 'instances')), 'the first home comes from the initial root');
		await gui.stop();

		process.env.DSH_HOME = secondHome;
		await gui.ensure('session-1');
		const second = calls[1].options.env.DSH_HOME;
		assert.ok(
			second.startsWith(join(firstHome, 'dsh-gui-auth-url', 'instances')),
			'a changed $DSH_HOME does not move an already-pinned manager',
		);
		await gui.stop();
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		await rm(firstHome, { recursive: true, force: true });
		await rm(secondHome, { recursive: true, force: true });
	}
});

test('the instances home is captured at construction, before the first start', async () => {
	const previous = process.env.DSH_HOME;
	const configured = await mkdtemp(join(tmpdir(), 'dsh-home-configured-'));
	const changed = await mkdtemp(join(tmpdir(), 'dsh-home-changed-'));
	process.env.DSH_HOME = configured;
	try {
		const calls = [];
		const gui = createIsolatedWebGui({
			jobs: fakeJobs(),
			spawn: fakeSpawn(calls),
			launcher: { command: 'dsh', args: [], env: {} },
			pollMs: 5,
		});
		// Changed after construction but before the first ensure: the captured
		// configuration must win, otherwise creation and deletion could disagree.
		process.env.DSH_HOME = changed;
		await gui.ensure('session-1');
		assert.ok(
			calls[0].options.env.DSH_HOME.startsWith(join(configured, 'dsh-gui-auth-url', 'instances')),
			'the root comes from the configuration captured at construction',
		);
		await gui.stop();
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		await rm(configured, { recursive: true, force: true });
		await rm(changed, { recursive: true, force: true });
	}
});

test('a resolved API key rides in the child environment only', async () => {
	const { gui, calls } = manager({ resolveApiKey: async () => 'test-key' });
	const outcome = await gui.ensure('session-1');
	assert.equal(outcome.sharedKey, true);
	assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, 'test-key');
	assert.equal(calls[0].options.env.DSH_HOME, join(tmpdir(), `${HOME_PREFIX}test`));
	await gui.stop();
});

test('a failing key resolver still starts the host, without a key', async () => {
	const { gui, calls } = manager({
		resolveApiKey: async () => {
			throw new Error('no key here');
		},
	});
	const outcome = await gui.ensure('session-1');
	assert.equal(outcome.sharedKey, false);
	assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, undefined);
	await gui.stop();
});

test('without a resolver the plugin shares no DeepSeek key', async () => {
	const { gui } = manager();
	const outcome = await gui.ensure('session-1');
	assert.equal(outcome.sharedKey, false);
	await gui.stop();
});

/** Build one disposable home (optionally with a marker) under a fresh temp root. */
async function sweepHome(root, name, marker) {
	const home = join(root, `${HOME_PREFIX}${name}`);
	await mkdir(home, { recursive: true });
	if (marker !== undefined) await writeFile(join(home, MARKER_FILENAME), JSON.stringify(marker), 'utf8');
	return home;
}

test('the startup sweep keeps a home whose host and Desktop process are alive', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const home = await sweepHome(root, 'alive', { pid: 100, parentPid: 200 });
		const removed = [];
		const killed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir: join(root, 'instances-new'),
			isAlive: (pid) => pid === 100 || pid === 200,
			kill: (pid) => killed.push(pid),
			removeHome: async (path) => removed.push(path),
		});
		assert.deepEqual(swept, []);
		assert.deepEqual(removed, []);
		assert.deepEqual(killed, []);
		assert.ok(existsSync(home));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep kills and removes a host whose Desktop process died', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const home = await sweepHome(root, 'orphan', { pid: 100, parentPid: 999, port: 4321 });
		const removed = [];
		const killed = [];
		const verified = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir: join(root, 'instances-new'),
			isAlive: (pid) => pid === 100,
			kill: (pid) => killed.push(pid),
			verifyHost: async (marker) => {
				verified.push(marker?.port);
				return true;
			},
			resolvePortOwner: async () => 100,
			waitGone: async () => true,
			removeHome: async (path) => removed.push(path),
		});
		assert.deepEqual(swept, [home]);
		assert.deepEqual(killed, [100], 'the orphaned host is ended');
		assert.deepEqual(verified, [4321], 'the identity probe reads the recorded port');
		assert.deepEqual(removed, [home]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep removes an orphan home but leaves an unverifiable process alone', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const home = await sweepHome(root, 'recycled', { pid: 100, parentPid: 999, port: 4321 });
		const removed = [];
		const killed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir: join(root, 'instances-new'),
			isAlive: (pid) => pid === 100,
			kill: (pid) => killed.push(pid),
			verifyHost: async () => false,
			resolvePortOwner: async () => 100,
			removeHome: async (path) => removed.push(path),
		});
		assert.deepEqual(swept, [], 'a live process that does not answer as the recorded host is left alone');
		assert.deepEqual(killed, [], 'a process that does not answer as the recorded DSH host is never killed');
		assert.deepEqual(removed, [], 'and its directory is not deleted either');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep removes a home whose host already exited', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const home = await sweepHome(root, 'dead', { pid: 100, parentPid: 200 });
		const removed = [];
		const killed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir: join(root, 'instances-new'),
			isAlive: (pid) => pid === 200,
			kill: (pid) => killed.push(pid),
			removeHome: async (path) => removed.push(path),
		});
		assert.deepEqual(swept, [home]);
		assert.deepEqual(killed, [], 'nothing to kill when the host is already gone');
		assert.deepEqual(removed, [home]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep reclaims a home left by a previous lifecycle of this process', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const home = await sweepHome(root, 'reloaded', { pid: 100, parentPid: process.pid });
		const killed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir: join(root, 'instances-new'),
			isAlive: () => true,
			kill: (pid) => killed.push(pid),
			verifyHost: async () => true,
			resolvePortOwner: async () => 100,
			waitGone: async () => true,
			removeHome: async () => {},
		});
		assert.deepEqual(swept, [home]);
		assert.deepEqual(killed, [100], 'a host from the previous plugin lifecycle is ended');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep leaves fresh marker-less homes and ignores foreign directories', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const legacyFresh = await sweepHome(root, 'legacy-fresh', undefined);
		await mkdir(join(root, 'not-ours'), { recursive: true });
		const removed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir: join(root, 'instances-new'),
			removeHome: async (path) => removed.push(path),
			legacyMaxAgeMs: 60_000,
		});
		assert.deepEqual(swept, []);
		assert.deepEqual(removed, []);
		assert.ok(existsSync(legacyFresh));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a cleanup that fails is not reported as removed', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const home = await sweepHome(root, 'locked', { pid: 100, parentPid: 200 });
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir: join(root, 'instances-new'),
			isAlive: (pid) => pid === 200,
			removeHome: async () => {
				throw new Error('locked');
			},
		});
		assert.deepEqual(swept, [], 'a failed cleanup is not a cleanup');
		assert.ok(existsSync(home), 'the directory is still there');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('port ownership is resolved for the probed endpoint, not just the port', () => {
	const text = [
		'  TCP    127.0.0.2:4321    0.0.0.0:0    LISTENING    100',
		'  TCP    127.0.0.1:4321    0.0.0.0:0    LISTENING    4242',
		'  TCP    127.0.0.1:5000    0.0.0.0:0    LISTENING    4243',
		'  TCP    [::1]:4321    [::]:0    LISTENING    4244',
	].join('\r\n');
	const listeners = parseNetstatListeners(text);
	assert.equal(resolvePortOwnerFrom(listeners, 4321, '127.0.0.1'), 4242, 'the probed endpoint decides');
	assert.equal(resolvePortOwnerFrom(listeners, 4321, '127.0.0.2'), 100, 'a sibling address does not');
	assert.equal(resolvePortOwnerFrom(listeners, 9999, '127.0.0.1'), undefined, 'an unused port has no owner');
});

test('ambiguous endpoint ownership is refused', () => {
	const text = [
		'  TCP    0.0.0.0:4321    0.0.0.0:0    LISTENING    100',
		'  TCP    127.0.0.1:4321    0.0.0.0:0    LISTENING    4242',
	].join('\n');
	assert.equal(
		resolvePortOwnerFrom(parseNetstatListeners(text), 4321, '127.0.0.1'),
		undefined,
		'two candidates mean no automatic kill',
	);
});

test('stop keeps the home when the host does not confirm exit', async () => {
	const calls = [];
	const removed = [];
	const jobs = fakeJobs();
	const root = await mkdtemp(join(tmpdir(), 'dsh-stop-'));
	try {
		const gui = createIsolatedWebGui({
			jobs,
			spawn: fakeSpawn(calls),
			launcher: { command: 'dsh', args: [], env: {} },
			makeHome: async () => {
				const home = join(root, 'stuck-home');
				await mkdir(home, { recursive: true });
				return home;
			},
			removeHome: async (path) => removed.push(path),
			pollMs: 5,
			stopTimeoutMs: 50,
			waitGone: async () => false,
		});
		await gui.ensure('session-1');
		const record = [...jobs.records.values()][0];
		// The child neither exits nor becomes observable: cancel is a no-op and the
		// exit promise never settles, so no proof of exit exists anywhere.
		record.hooks.done = new Promise(() => {});
		record.hooks.cancel = () => {};

		await assert.rejects(() => gui.stop(), /did not confirm exit/);
		assert.deepEqual(removed, [], 'an unconfirmed exit must not delete the home');
		assert.ok(existsSync(join(root, 'stuck-home')), 'the home is still there');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a spawn error while the host is still alive does not clean the home', async () => {
	const calls = [];
	const removed = [];
	const jobs = fakeJobs();
	const root = await mkdtemp(join(tmpdir(), 'dsh-err-'));
	try {
		const gui = createIsolatedWebGui({
			jobs,
			spawn: fakeSpawn(calls),
			launcher: { command: 'dsh', args: [], env: {} },
			makeHome: async () => {
				const home = join(root, 'err-home');
				await mkdir(home, { recursive: true });
				return home;
			},
			removeHome: async (path) => removed.push(path),
			pollMs: 5,
			stopTimeoutMs: 50,
			waitGone: async () => false,
		});
		await gui.ensure('session-1');
		const record = [...jobs.records.values()][0];
		record.hooks.cancel = () => {};
		// The job settles as failed, but the process never emitted exit.
		calls[0].child.emit('error', new Error('boom'));

		await assert.rejects(() => gui.stop(), /did not confirm exit/);
		assert.deepEqual(removed, [], 'a job error is not proof the process exited');
		assert.ok(existsSync(join(root, 'err-home')), 'the home stays');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a stop whose home cleanup fails is reported, not swallowed', async () => {
	const calls = [];
	const jobs = fakeJobs();
	const root = await mkdtemp(join(tmpdir(), 'dsh-cleanfail-'));
	try {
		const gui = createIsolatedWebGui({
			jobs,
			spawn: fakeSpawn(calls),
			launcher: { command: 'dsh', args: [], env: {} },
			makeHome: async () => {
				const home = join(root, 'home');
				await mkdir(home, { recursive: true });
				return home;
			},
			removeHome: async () => {
				throw new Error('refusing to delete a directory without an owner marker');
			},
			pollMs: 5,
		});
		await gui.ensure('session-1');
		await assert.rejects(() => gui.stop(), /temporary home could not be removed.*owner marker/s);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a failed stop keeps the instance tracked and retryable', async () => {
	const calls = [];
	const removed = [];
	const jobs = fakeJobs();
	const root = await mkdtemp(join(tmpdir(), 'dsh-retry-'));
	try {
		const home = join(root, 'retry-home');
		const gui = createIsolatedWebGui({
			jobs,
			spawn: fakeSpawn(calls),
			launcher: { command: 'dsh', args: [], env: {} },
			makeHome: async () => {
				await mkdir(home, { recursive: true });
				return home;
			},
			removeHome: async (path) => removed.push(path),
			pollMs: 5,
			stopTimeoutMs: 50,
			waitGone: async () => false,
		});
		await gui.ensure('session-1');
		const record = [...jobs.records.values()][0];
		let resolveExit;
		record.hooks.exited = new Promise((resolveStop) => {
			resolveExit = resolveStop;
		});
		record.hooks.cancel = () => {};

		await assert.rejects(() => gui.stop(), /did not confirm exit/);
		const again = await gui.ensure('session-1');
		assert.equal(again.reused, true, 'the live instance is still tracked');
		assert.equal(calls.length, 1, 'no replacement instance is started');

		resolveExit();
		await gui.stop();
		assert.deepEqual(removed, [home], 'once exit is proven the home is disposable');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a start that fails before the URL keeps a still-live host and its home', async () => {
	const removed = [];
	const root = await mkdtemp(join(tmpdir(), 'dsh-start-'));
	try {
		const gui = createIsolatedWebGui({
			jobs: fakeJobs(),
			spawn: () => {
				const child = fakeChild();
				// Emit after the spawn helper has attached its listeners.
				process.nextTick(() => child.emit('error', new Error('spawn failed')));
				return child;
			},
			launcher: { command: 'dsh', args: [], env: {} },
			makeHome: async () => {
				const home = join(root, 'start-home');
				await mkdir(home, { recursive: true });
				return home;
			},
			removeHome: async (path) => removed.push(path),
			pollMs: 5,
			stopTimeoutMs: 50,
			waitGone: async () => false,
		});
		await assert.rejects(() => gui.ensure('session-1'), /exit could not be confirmed/);
		assert.deepEqual(removed, [], 'a job error is not proof the process exited');
		assert.ok(existsSync(join(root, 'start-home')), 'the home is kept');
		assert.equal(gui.status('session-1').home, join(root, 'start-home'), 'the instance stays tracked for a retry');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a start timeout that cannot end the host keeps the home and the record', async () => {
	const removed = [];
	const root = await mkdtemp(join(tmpdir(), 'dsh-timeout-'));
	try {
		const child = fakeChild();
		child.kill = () => {};
		const gui = createIsolatedWebGui({
			jobs: fakeJobs(),
			spawn: () => child,
			launcher: { command: 'dsh', args: [], env: {} },
			makeHome: async () => {
				const home = join(root, 'timeout-home');
				await mkdir(home, { recursive: true });
				return home;
			},
			removeHome: async (path) => removed.push(path),
			pollMs: 5,
			startTimeoutMs: 30,
			stopTimeoutMs: 50,
			waitGone: async () => false,
		});
		await assert.rejects(() => gui.ensure('session-1'), /did not announce a URL within 30 ms and its exit could not be confirmed/);
		assert.deepEqual(removed, [], 'a kill request is not proof of exit');
		assert.ok(existsSync(join(root, 'timeout-home')), 'the home is kept');
		assert.equal(gui.status('session-1').home, join(root, 'timeout-home'), 'the instance stays tracked');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep never creates the instances root', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const instances = join(root, 'not-there');
		const swept = await sweepStaleHomes({ tmpdir: root, instancesDir: instances });
		assert.deepEqual(swept, []);
		assert.equal(existsSync(instances), false, 'a sweep must not write into the Harness home');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep never signals a process whose owner marker is invalid', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const instancesDir = join(root, 'instances-new');
		const home = join(instancesDir, `${INSTANCE_PREFIX}bad-owner`);
		await mkdir(home, { recursive: true });
		await writeFile(join(home, MARKER_FILENAME), JSON.stringify({ pid: 100, parentPid: 999, port: 4321 }), 'utf8');
		// A record that is not this plugin's format: ownership is unproven.
		await mkdir(join(instancesDir, '.owner-records'), { recursive: true });
		await writeFile(ownerRecordPath(instancesDir, home), JSON.stringify({ version: 99, plugin: 'other' }), 'utf8');

		const killed = [];
		const removed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir,
			isAlive: (pid) => pid === 100,
			kill: (pid) => killed.push(pid),
			verifyHost: async () => true,
			resolvePortOwner: async () => 100,
			waitGone: async () => true,
			removeHome: async (path) => removed.push(path),
		});
		assert.deepEqual(swept, []);
		assert.deepEqual(killed, [], 'an unproven owner is never signalled');
		assert.deepEqual(removed, []);
		assert.ok(existsSync(home));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep never signals a pid that does not own the recorded port', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const instancesDir = join(root, 'instances-new');
		const home = join(instancesDir, `${INSTANCE_PREFIX}recycled-pid`);
		await mkdir(home, { recursive: true });
		await writeFile(join(home, MARKER_FILENAME), JSON.stringify({ pid: 100, parentPid: 999, port: 4321 }), 'utf8');
		await mkdir(join(instancesDir, '.owner-records'), { recursive: true });
		await writeFile(
			ownerRecordPath(instancesDir, home),
			JSON.stringify({
				version: 1,
				plugin: 'dsh-gui-auth-url',
				instanceId: `${INSTANCE_PREFIX}recycled-pid`,
				token: 'token-0123456789abcdef',
				home,
				realHome: resolve(home),
			}),
			'utf8',
		);

		const killed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir,
			isAlive: (pid) => pid === 100,
			kill: (pid) => killed.push(pid),
			verifyHost: async () => true,
			resolvePortOwner: async () => 4242,
			waitGone: async () => true,
			removeHome: async () => {},
		});
		assert.deepEqual(swept, [], 'the port belongs to another process');
		assert.deepEqual(killed, [], 'a pid that does not own the port is never signalled');
		assert.ok(existsSync(home));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep keeps the directory of a live host that does not exit', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const home = await sweepHome(root, 'stubborn', { pid: 100, parentPid: 999 });
		const removed = [];
		const killed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir: join(root, 'instances-new'),
			isAlive: (pid) => pid === 100,
			kill: (pid) => killed.push(pid),
			verifyHost: async () => true,
			resolvePortOwner: async () => 100,
			waitGone: async () => false,
			removeHome: async (path) => removed.push(path),
		});
		assert.deepEqual(swept, [], 'a host that did not exit keeps its directory');
		assert.deepEqual(killed, [100], 'the verified host is asked to stop');
		assert.deepEqual(removed, [], 'but nothing is deleted while it is still alive');
		assert.ok(existsSync(home));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the startup sweep never deletes a marker-less home, however old', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const home = await sweepHome(root, 'legacy-old', undefined);
		const removed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			instancesDir: join(root, 'instances-new'),
			removeHome: async (path) => removed.push(path),
			legacyMaxAgeMs: 0,
			now: () => Date.now() + 1000,
		});
		assert.deepEqual(swept, [], 'age is not evidence of ownership');
		assert.deepEqual(removed, []);
		assert.ok(existsSync(home), 'the unprovable directory stays');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** Spawn stand-in that answers `dsh plugin ... add` with an exit code and the host with a URL. */
function fakeSpawnWithInstall(calls, { url = 'http://127.0.0.1:4123/?token=t', installCode = 0, installOutput = '' } = {}) {
	return (command, args, options) => {
		const child = fakeChild();
		calls.push({ command, args, options, child });
		process.nextTick(() => {
			if (args.includes('plugin')) {
				if (installOutput !== '') child.stderr.emit('data', Buffer.from(installOutput));
				child.exitCode = installCode;
				child.emit('exit', installCode);
				return;
			}
			child.stdout.emit('data', Buffer.from(`dsh web: ${url}\n`));
		});
		return child;
	};
}

test('launch options reach the spawned host and the reported facts', async () => {
	const { gui, calls } = manager({ allowPublic: true });
	const outcome = await gui.ensure('session-1', { host: '192.168.1.5', port: 51234 });
	assert.equal(calls[0].args[calls[0].args.indexOf('--port') + 1], '51234', 'a requested port is honoured');
	assert.deepEqual(calls[0].args.slice(-2), ['--host', '192.168.1.5']);
	assert.equal(outcome.exposed, true);
	assert.equal(typeof outcome.startedAt, 'number');
	assert.deepEqual(outcome.install, []);
	await gui.stop();
});

test('an exposure request is refused before anything is spawned when allowPublic is off', async () => {
	const { gui, calls } = manager();
	await assert.rejects(() => gui.ensure('session-1', { host: '192.168.1.5' }), /allowPublic: true/u);
	assert.equal(calls.length, 0, 'no host is ever spawned for a refused request');
});

test('a profile that turns installs off refuses the install option', async () => {
	const { gui, calls } = manager({ allowInstall: false });
	await assert.rejects(() => gui.ensure('session-1', { install: ['github:you/plugin'] }), /install is disabled/u);
	assert.equal(calls.length, 0);
});

test('installing happens before the host starts, inside the disposable profile', async () => {
	const calls = [];
	const gui = createIsolatedWebGui({
		jobs: fakeJobs(),
		spawn: fakeSpawnWithInstall(calls),
		launcher: { command: 'dsh', args: [], env: {} },
		pollMs: 5,
		makeHome: async () => join(tmpdir(), `${HOME_PREFIX}install`),
		removeHome: async () => {},
	});
	const outcome = await gui.ensure('session-1', { install: ['github:you/plugin'] });
	const installCall = calls.find((call) => call.args.includes('plugin'));
	assert.ok(installCall, 'the package manager ran');
	assert.deepEqual(installCall.args, ['plugin', '--profile', 'web', 'add', 'github:you/plugin']);
	assert.equal(installCall.options.env.DSH_HOME, join(tmpdir(), `${HOME_PREFIX}install`), 'the profile is the disposable one');
	const hostCall = calls.find((call) => call.args.includes('--no-open'));
	assert.ok(hostCall !== undefined, 'the host ran');
	assert.ok(calls.indexOf(installCall) < calls.indexOf(hostCall), 'install precedes the host');
	assert.deepEqual(outcome.install, ['github:you/plugin']);
	await gui.stop();
});

test('a failed install removes the fresh home and never starts a host', async () => {
	const calls = [];
	const removed = [];
	const gui = createIsolatedWebGui({
		jobs: fakeJobs(),
		spawn: fakeSpawnWithInstall(calls, { installCode: 1, installOutput: 'ERR_PNPM_NO_MATCHING_VERSION' }),
		launcher: { command: 'dsh', args: [], env: {} },
		pollMs: 5,
		makeHome: async () => join(tmpdir(), `${HOME_PREFIX}installfail`),
		removeHome: async (home) => removed.push(home),
	});
	await assert.rejects(
		() => gui.ensure('session-1', { install: ['github:you/missing'] }),
		/installing into the temporary profile failed \(exit code 1\)[\s\S]*ERR_PNPM_NO_MATCHING_VERSION/u,
		'the package-manager output is reported',
	);
	assert.equal(calls.filter((call) => call.args.includes('--no-open')).length, 0, 'no host is started');
	assert.deepEqual(removed, [join(tmpdir(), `${HOME_PREFIX}installfail`)]);
});

test('a restart keeps the launch configuration and does not re-run the package manager', async () => {
	const calls = [];
	const gui = createIsolatedWebGui({
		jobs: fakeJobs(),
		spawn: fakeSpawnWithInstall(calls),
		launcher: { command: 'dsh', args: [], env: {} },
		pollMs: 5,
		allowPublic: true,
		makeHome: async () => join(tmpdir(), `${HOME_PREFIX}restartopts`),
		removeHome: async () => {},
	});
	await gui.ensure('session-1', { install: ['github:you/plugin'], host: '192.168.1.5' });
	const installsBefore = calls.filter((call) => call.args.includes('plugin')).length;
	const restarted = await gui.restart('session-1');
	assert.equal(restarted.portKept, true);
	const hostCalls = calls.filter((call) => call.args.includes('--no-open'));
	assert.deepEqual(hostCalls.at(-1).args.slice(-2), ['--host', '192.168.1.5'], 'the bind address survives');
	assert.equal(calls.filter((call) => call.args.includes('plugin')).length, installsBefore, 'nothing is reinstalled');
	assert.equal(restarted.exposed, true);
	await gui.stop();
});

test('a request with real launch options reconfigures a running instance', async () => {
	const { gui, calls, jobs } = manager({ allowPublic: true });
	await gui.ensure('session-1');
	const first = [...jobs.records.values()][0];
	const outcome = await gui.ensure('session-1', { host: '192.168.1.5' });
	assert.equal(outcome.reused, false, 'a reconfigured host is not handed back as a plain reuse');
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].args.slice(-2), ['--host', '192.168.1.5']);
	assert.equal(jobs.records.get(first.id).status, 'killed');
	await gui.stop();
});

test('status reports nothing running before the first start', () => {
	const { gui } = manager();
	assert.throws(() => gui.status(undefined), /session-bound owner/u);
	assert.deepEqual(gui.status('session-1'), { running: false, runningCount: 0, maxInstances: 4 });
});

test('status reports the running instance, its facts and the global counters', async () => {
	const { gui } = manager({ allowPublic: true });
	await gui.ensure('session-1', { host: '192.168.1.5' });
	const status = gui.status('session-1');
	assert.equal(status.running, true);
	assert.equal(status.jobStatus, 'running');
	assert.equal(status.url, 'http://127.0.0.1:4123/?token=t');
	assert.equal(status.port, 4123);
	assert.equal(status.exposed, true);
	assert.equal(status.sharedKey, false);
	assert.equal(status.runningCount, 1);
	assert.equal(status.maxInstances, 4);
	assert.ok(status.home.startsWith(join(tmpdir(), HOME_PREFIX)));
	assert.equal(typeof status.startedAt, 'number');

	await gui.stop('session-1');
	assert.equal(gui.status('session-1').running, false, 'a stopped instance is not running');
	assert.equal(gui.status('session-1').runningCount, 0);
});
test('killTree captures the process tree before the root is killed on Windows', () => {
	const events = [];
	const child = { pid: 4242, kill: () => events.push('direct') };
	const killer = new EventEmitter();
	killTree(child, {
		platform: 'win32',
		spawn: (command, args) => {
			events.push(command + ' ' + args.join(' '));
			return killer;
		},
	});
	assert.deepEqual(events, ['taskkill /PID 4242 /T /F'], 'the tree kill starts while the root is still alive');
	killer.emit('exit', 0);
	assert.deepEqual(events, ['taskkill /PID 4242 /T /F', 'direct'], 'the direct kill only follows the tree kill');
});

test('killTree kills the child directly off Windows', () => {
	const events = [];
	killTree({ pid: 4242, kill: () => events.push('direct') }, {
		platform: 'linux',
		spawn: () => { throw new Error('must not spawn taskkill off Windows'); },
	});
	assert.deepEqual(events, ['direct']);
});

test('killTree falls back to the direct kill when taskkill cannot start', () => {
	const events = [];
	killTree({ pid: 4242, kill: () => events.push('direct') }, {
		platform: 'win32',
		spawn: () => { throw new Error('taskkill missing'); },
	});
	assert.deepEqual(events, ['direct']);
});

test('killTree falls back to the direct kill when the tree kill errors', () => {
	const events = [];
	const child = { pid: 4242, kill: () => events.push('direct') };
	const killer = new EventEmitter();
	killTree(child, { platform: 'win32', spawn: () => killer });
	killer.emit('error', new Error('denied'));
	assert.deepEqual(events, ['direct'], 'a failed tree kill still ends the child');
});

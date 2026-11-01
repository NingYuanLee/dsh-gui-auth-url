import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	HOME_PREFIX,
	MARKER_FILENAME,
	createIsolatedWebGui,
	parseLaunchedUrl,
	resolveLauncher,
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
				// The fixed port is taken: the host exits before announcing a URL.
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

test('a real temporary home is created and removed on stop', async () => {
	const calls = [];
	const gui = createIsolatedWebGui({
		jobs: fakeJobs(),
		spawn: fakeSpawn(calls),
		launcher: { command: 'dsh', args: [], env: {} },
		pollMs: 5,
	});
	await gui.ensure('session-1');
	const home = calls[0].options.env.DSH_HOME;
	assert.ok(home.startsWith(join(tmpdir(), HOME_PREFIX)), 'home lives under the temp dir with our prefix');
	assert.ok(existsSync(home), 'home exists while the instance runs');
	await gui.stop();
	assert.equal(existsSync(home), false, 'home is gone after stop');
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
			isAlive: (pid) => pid === 100,
			kill: (pid) => killed.push(pid),
			verifyHost: async (marker) => {
				verified.push(marker?.port);
				return true;
			},
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
			isAlive: (pid) => pid === 100,
			kill: (pid) => killed.push(pid),
			verifyHost: async () => false,
			removeHome: async (path) => removed.push(path),
		});
		assert.deepEqual(swept, [home]);
		assert.deepEqual(killed, [], 'a process that does not answer as the recorded DSH host is never killed');
		assert.deepEqual(removed, [home]);
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
			isAlive: () => true,
			kill: (pid) => killed.push(pid),
			verifyHost: async () => true,
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

test('the startup sweep removes an old marker-less home', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-sweep-'));
	try {
		const home = await sweepHome(root, 'legacy-old', undefined);
		const removed = [];
		const swept = await sweepStaleHomes({
			tmpdir: root,
			removeHome: async (path) => removed.push(path),
			legacyMaxAgeMs: 0,
			now: () => Date.now() + 1000,
		});
		assert.deepEqual(swept, [home]);
		assert.deepEqual(removed, [home]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

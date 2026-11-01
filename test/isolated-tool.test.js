import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	RESTART_TOOL_NAME,
	STATUS_TOOL_NAME,
	STOP_TOOL_NAME,
	executeIsolatedRestart,
	executeIsolatedStart,
	executeIsolatedStatus,
	executeIsolatedStop,
	registerIsolatedRestartTool,
	registerIsolatedStartTool,
	registerIsolatedStatusTool,
	registerIsolatedStopTool,
	sessionIdOf,
} from '../src/isolated-tool.js';

/** Collect registrations from a fake tools service. */
function registeringContext() {
	const registered = [];
	return {
		registered,
		tools: { register: (tool) => { registered.push(tool); return () => {}; } },
	};
}

/** An isolated-instance manager that records the owner it was asked for. */
function fakeGui(outcome = {}) {
	const calls = [];
	const args = [];
	return {
		calls,
		args,
		async ensure(sessionId, launchOptions) {
			calls.push(sessionId);
			args.push(launchOptions);
			return {
				url: 'http://127.0.0.1:41234/?token=abc',
				jobId: 'job-1',
				reused: false,
				sharedKey: true,
				...outcome,
			};
		},
		async restart(sessionId, launchOptions) {
			calls.push(sessionId);
			args.push(launchOptions);
			return {
				url: 'http://127.0.0.1:41234/?token=abc',
				jobId: 'job-2',
				reused: false,
				restarted: true,
				portKept: true,
				sharedKey: true,
				...outcome,
			};
		},
		async stop(sessionId) {
			calls.push(sessionId);
			return outcome.stopped ?? true;
		},
		async status(sessionId) {
			calls.push(sessionId);
			return {
				running: true,
				url: 'http://127.0.0.1:41234/?token=abc',
				jobId: 'job-1',
				startedAt: 1_760_000_000_000,
				home: 'C:\\Temp\\dsh-web-gui-test',
				port: 41234,
				sharedKey: true,
				install: [],
				exposed: false,
				runningCount: 1,
				maxInstances: 4,
				jobStatus: 'running',
				...outcome,
			};
		},
	};
}

test('registers the isolated-start tool with the launch options it understands', () => {
	const ctx = registeringContext();
	assert.equal(registerIsolatedStartTool(ctx, { gui: fakeGui() }), true);
	assert.equal(ctx.registered.length, 1);
	const [tool] = ctx.registered;
	assert.equal(tool.name, 'dsh_web_start');
	assert.equal(tool.parameters.type, 'object');
	assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
		'host',
		'install',
		'port',
		'public_url',
		'tls_cert',
		'tls_key',
		'trusted_host',
	]);
	assert.equal(tool.parameters.properties.install.type, 'array');
	assert.equal(tool.parameters.properties.install.items.type, 'string');
	assert.equal(tool.parameters.properties.trusted_host.type, 'array');
	assert.equal(tool.parameters.properties.port.type, 'integer');
	assert.match(tool.description, /临时鉴权 DSH Web/u);
	assert.match(tool.description, /gui_auth_url/u, 'states the split against the read-only tool');
});

test('a composition without the instance manager registers nothing', () => {
	const ctx = registeringContext();
	assert.equal(registerIsolatedStartTool(ctx, {}), false);
	assert.equal(registerIsolatedStartTool(ctx, { gui: {} }), false);
	assert.equal(ctx.registered.length, 0);
});

test('the call binds the instance to the calling session id', async () => {
	const gui = fakeGui();
	const value = await executeIsolatedStart(gui, { agent: { id: 'session-7' } });
	assert.deepEqual(gui.calls, ['session-7']);
	assert.equal(value.url, 'http://127.0.0.1:41234/?token=abc');
	assert.equal(value.jobId, 'job-1');
});

test('an execution without an agent forwards no owner, which the manager refuses', async () => {
	const gui = fakeGui({ jobId: undefined });
	gui.ensure = async (sessionId) => {
		gui.calls.push(sessionId);
		throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
	};
	await assert.rejects(() => executeIsolatedStart(gui, {}), /session-bound owner/u);
	assert.deepEqual(gui.calls, [undefined]);
});

test('the tool result omits an absent job id', async () => {
	const gui = fakeGui({ jobId: undefined });
	const value = await executeIsolatedStart(gui, { agent: { id: 'session-1' } });
	assert.equal('jobId' in value, false);
});

test('sessionIdOf ignores non-string agent ids', () => {
	assert.equal(sessionIdOf({ agent: { id: 'session-1' } }), 'session-1');
	assert.equal(sessionIdOf({ agent: { id: '' } }), undefined);
	assert.equal(sessionIdOf({ agent: {} }), undefined);
	assert.equal(sessionIdOf(undefined), undefined);
});

test('the rendered text carries the url, the job stop advice and the split', () => {
	const ctx = registeringContext();
	registerIsolatedStartTool(ctx, { gui: fakeGui() });
	const rendered = ctx.registered[0].output.render({}, {
		url: 'http://127.0.0.1:41234/?token=abc',
		jobId: 'job-1',
		reused: false,
		sharedKey: true,
	});
	const text = rendered[0].text;
	assert.match(text, /http:\/\/127\.0\.0\.1:41234/u);
	assert.match(text, /jobId=job-1/u);
	assert.match(text, /gui_auth_url/u);
});

test('a result without a job id still tells the person where to stop it', () => {
	const ctx = registeringContext();
	registerIsolatedStartTool(ctx, { gui: fakeGui() });
	const rendered = ctx.registered[0].output.render({}, {
		url: 'http://127.0.0.1:1/',
		reused: true,
		sharedKey: false,
	});
	assert.match(rendered[0].text, /「后台任务」列表/u);
});

test('registers the in-place restart tool with the launch options it can replace', () => {
	const ctx = registeringContext();
	assert.equal(registerIsolatedRestartTool(ctx, { gui: fakeGui() }), true);
	assert.equal(ctx.registered.length, 1);
	const [tool] = ctx.registered;
	assert.equal(tool.name, RESTART_TOOL_NAME);
	assert.equal(tool.name, 'dsh_web_restart');
	assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
		'host',
		'install',
		'public_url',
		'tls_cert',
		'tls_key',
		'trusted_host',
	], 'a restart takes no port: it reuses the preserved one');
	assert.match(tool.description, /原地重启/u);
	assert.match(tool.description, /DSH_HOME/u);
});

test('a manager without restart registers no restart tool', () => {
	const ctx = registeringContext();
	assert.equal(registerIsolatedRestartTool(ctx, { gui: { ensure: async () => ({}) } }), false);
	assert.equal(ctx.registered.length, 0);
});

test('the restart call addresses the calling session and reports the new host', async () => {
	const gui = fakeGui();
	const value = await executeIsolatedRestart(gui, { agent: { id: 'session-9' } });
	assert.deepEqual(gui.calls, ['session-9']);
	assert.equal(value.url, 'http://127.0.0.1:41234/?token=abc');
	assert.equal(value.jobId, 'job-2');
	assert.equal(value.restarted, true);
	assert.equal(value.portKept, true, 'the restart reports the port decision');
});

test('the restart rendering says the temporary profile survived', () => {
	const ctx = registeringContext();
	registerIsolatedRestartTool(ctx, { gui: fakeGui() });
	const rendered = ctx.registered[0].output.render({}, {
		url: 'http://127.0.0.1:41234/?token=abc',
		jobId: 'job-2',
		restarted: true,
		portKept: true,
		sharedKey: true,
	});
	const text = rendered[0].text;
	assert.match(text, /原地重启/u);
	assert.match(text, /DSH_HOME 保留/u);
	assert.match(text, /端口沿用原值/u);
	assert.match(text, /jobId=job-2/u);
});

test('launch options reach the manager unchanged', async () => {
	const gui = fakeGui();
	await executeIsolatedStart(gui, { agent: { id: 'session-3' } }, { install: ['github:you/p'] });
	await executeIsolatedRestart(gui, { agent: { id: 'session-3' } }, { host: '192.168.1.5' });
	assert.deepEqual(gui.args, [{ install: ['github:you/p'] }, { host: '192.168.1.5' }]);
});

test('a call without launch options passes an empty request through', async () => {
	const gui = fakeGui();
	await executeIsolatedStart(gui, { agent: { id: 'session-1' } });
	assert.deepEqual(gui.args, [{}]);
});

test('the start rendering reports the install and the exposure', () => {
	const ctx = registeringContext();
	registerIsolatedStartTool(ctx, { gui: fakeGui() });
	const rendered = ctx.registered[0].output.render({}, {
		url: 'http://192.168.1.5:41234/?token=abc',
		jobId: 'job-1',
		reused: false,
		sharedKey: true,
		exposed: true,
		install: ['github:you/plugin', 'file:../plugin'],
	});
	const text = rendered[0].text;
	assert.match(text, /已把 2 个包装进临时 DSH_HOME/u);
	assert.match(text, /github:you\/plugin/u);
	assert.match(text, /非回环地址/u);
	assert.match(text, /dsh_web_stop/u, 'stop advice names the stop tool');
});

test('an unexposed instance does not warn about the network', () => {
	const ctx = registeringContext();
	registerIsolatedStartTool(ctx, { gui: fakeGui() });
	const rendered = ctx.registered[0].output.render({}, {
		url: 'http://127.0.0.1:41234/?token=abc',
		jobId: 'job-1',
		reused: false,
		sharedKey: true,
	});
	assert.doesNotMatch(rendered[0].text, /非回环地址/u);
});

test('registers the stop action as a no-parameter tool', () => {
	const ctx = registeringContext();
	assert.equal(registerIsolatedStopTool(ctx, { gui: fakeGui() }), true);
	assert.equal(ctx.registered.length, 1);
	const [tool] = ctx.registered;
	assert.equal(tool.name, STOP_TOOL_NAME);
	assert.equal(tool.name, 'dsh_web_stop');
	assert.deepEqual(tool.parameters.properties, {});
	assert.match(tool.description, /删除它的临时 DSH_HOME/u);
});

test('the stop action addresses the calling session and reports the outcome', async () => {
	const gui = fakeGui();
	assert.deepEqual(await executeIsolatedStop(gui, { agent: { id: 'session-4' } }), { stopped: true });
	assert.deepEqual(gui.calls, ['session-4']);
	const idle = fakeGui({ stopped: false });
	assert.deepEqual(await executeIsolatedStop(idle, { agent: { id: 'session-4' } }), { stopped: false });
});

test('the stop rendering distinguishes stopping from nothing to stop', () => {
	const ctx = registeringContext();
	registerIsolatedStopTool(ctx, { gui: fakeGui() });
	const { render } = ctx.registered[0].output;
	assert.match(render({}, { stopped: true })[0].text, /已停止/u);
	assert.match(render({}, { stopped: false })[0].text, /没有运行中/u);
});

test('registers the read-only status query as a no-parameter tool', () => {
	const ctx = registeringContext();
	assert.equal(registerIsolatedStatusTool(ctx, { gui: fakeGui() }), true);
	assert.equal(ctx.registered.length, 1);
	const [tool] = ctx.registered;
	assert.equal(tool.name, STATUS_TOOL_NAME);
	assert.equal(tool.name, 'dsh_web_status');
	assert.deepEqual(tool.parameters.properties, {});
	assert.match(tool.description, /只读/u);
});

test('the status query asks the manager about the calling session', async () => {
	const gui = fakeGui();
	const value = await executeIsolatedStatus(gui, { agent: { id: 'session-5' } });
	assert.equal(value.running, true);
	assert.deepEqual(gui.calls, ['session-5']);
});

test('the status rendering describes a running instance and its counters', () => {
	const ctx = registeringContext();
	registerIsolatedStatusTool(ctx, { gui: fakeGui() });
	const value = {
		running: true,
		url: 'http://127.0.0.1:41234/?token=abc',
		jobId: 'job-1',
		startedAt: 1_760_000_000_000,
		home: 'C:\\Temp\\dsh-web-gui-test',
		port: 41234,
		sharedKey: true,
		install: ['github:you/plugin'],
		exposed: true,
		runningCount: 1,
		maxInstances: 4,
		jobStatus: 'running',
	};
	const text = ctx.registered[0].output.render({}, value)[0].text;
	assert.match(text, /jobId=job-1/u);
	assert.match(text, /C:\\Temp\\dsh-web-gui-test/u);
	assert.match(text, /通过 install 安装过：github:you\/plugin/u);
	assert.match(text, /暴露在非回环地址上/u);
	assert.match(text, /1\/4/u);
});

test('the status rendering answers "nothing running" without inventing a url', () => {
	const ctx = registeringContext();
	registerIsolatedStatusTool(ctx, { gui: fakeGui() });
	const text = ctx.registered[0].output.render({}, { running: false, runningCount: 0, maxInstances: 4 })[0].text;
	assert.match(text, /没有运行中的临时鉴权 DSH Web/u);
	assert.match(text, /0\/4/u);
});

test('a manager without stop or status registers neither tool', () => {
	const ctx = registeringContext();
	assert.equal(registerIsolatedStopTool(ctx, { gui: { ensure: async () => ({}) } }), false);
	assert.equal(registerIsolatedStatusTool(ctx, { gui: { ensure: async () => ({}) } }), false);
	assert.equal(ctx.registered.length, 0);
});

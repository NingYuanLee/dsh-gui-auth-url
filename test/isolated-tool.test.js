import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	RESTART_TOOL_NAME,
	executeIsolatedRestart,
	executeIsolatedStart,
	registerIsolatedRestartTool,
	registerIsolatedStartTool,
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
	return {
		calls,
		async ensure(sessionId) {
			calls.push(sessionId);
			return {
				url: 'http://127.0.0.1:41234/?token=abc',
				jobId: 'job-1',
				reused: false,
				sharedKey: true,
				...outcome,
			};
		},
		async restart(sessionId) {
			calls.push(sessionId);
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
	};
}

test('registers the isolated-start tool with no parameters', () => {
	const ctx = registeringContext();
	assert.equal(registerIsolatedStartTool(ctx, { gui: fakeGui() }), true);
	assert.equal(ctx.registered.length, 1);
	const [tool] = ctx.registered;
	assert.equal(tool.name, 'dsh_web_start');
	assert.equal(tool.parameters.type, 'object');
	assert.deepEqual(tool.parameters.properties, {});
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

test('registers the in-place restart tool with no parameters', () => {
	const ctx = registeringContext();
	assert.equal(registerIsolatedRestartTool(ctx, { gui: fakeGui() }), true);
	assert.equal(ctx.registered.length, 1);
	const [tool] = ctx.registered;
	assert.equal(tool.name, RESTART_TOOL_NAME);
	assert.equal(tool.name, 'dsh_web_restart');
	assert.deepEqual(tool.parameters.properties, {});
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

#!/usr/bin/env node
/**
 * End-to-end smoke for the isolated Web GUI: start a REAL `dsh web` host,
 * restart it in place, stop it, and prove nothing is left behind.
 *
 * Manual only - never part of `npm test` or CI. Why it exists: the unit tests
 * fake the child process, so real-host behaviour used to be verified with
 * hand-written probes; one interrupted probe left orphan hosts spinning for
 * hours (Windows does not reap a child when its parent dies). This script is
 * that probe with a guaranteed teardown: cleanup runs from a finally block and
 * from a SIGINT handler, and the last assertions are that the instances root is
 * empty and the announced port no longer answers.
 *
 * It uses the production launcher by default (the app executable running
 * `dsh-desktop-host/cli.js` as Node), derived from `where dsh` with existence
 * checks; pass `--launcher=shim` to exercise the PATH launcher a plain Node
 * install uses, which puts cmd.exe between the manager and the host and is the
 * case where killing the root before `taskkill /T` used to orphan the host.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createIsolatedWebGui, resolveLauncher, sweepStaleHomes } from '../src/isolated-web.js';
import { createInstanceRoot, ownerRecordPath } from '../src/instance-home.js';

const START_TIMEOUT_MS = 120000;
const STOP_TIMEOUT_MS = 8000;
const OWNER = 'smoke';

function skip(reason) {
	console.log(`SKIP ${reason}`);
	process.exit(0);
}

/** A host started from an elevated shell cannot be killed by a normal DSH process: refuse before spawning one. */
function isElevated() {
	if (process.platform !== 'win32') return false;
	try {
		return execFileSync('whoami', ['/groups'], { encoding: 'utf8' }).includes('S-1-16-12288');
	} catch {
		return false;
	}
}

/** The launcher production uses, derived from the installed `dsh.cmd` shim. */
function resolveSmokeLauncher() {
	if (process.platform !== 'win32') return undefined;
	let shim;
	try {
		shim = execFileSync('where', ['dsh'], { encoding: 'utf8' }).split(/\r?\n/u)[0].trim();
	} catch {
		return undefined;
	}
	if (shim === '') return undefined;
	const bin = dirname(shim);
	const appExe = resolve(bin, '..', '..', '..', '..', 'DeepSeek Harness.exe');
	// `app.asar` is an archive, not a directory: its inner paths are only visible to
	// Electron's asar layer, so the existence check is on the archive itself.
	const appAsar = resolve(bin, '..', '..', '..', 'app.asar');
	const cli = join(appAsar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
	if (!existsSync(appExe) || !existsSync(appAsar)) return undefined;
	return { command: appExe, args: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** The smallest stand-in for `ctx.jobs` that the manager accepts. */
function inMemoryJobs() {
	const records = new Map();
	let next = 0;
	return {
		start(spec) {
			const id = `smoke-${String(++next)}`;
			const hooks = spec.run();
			const record = { id, owner: spec.owner, status: 'running', hooks };
			records.set(id, record);
			hooks.done.then((outcome) => {
				if (records.has(id)) record.status = record.killed ? 'killed' : outcome.status;
			});
			return id;
		},
		get(id) {
			const record = records.get(id);
			if (record === undefined) throw new Error(`unknown job ${id}`);
			return { ...record };
		},
		kill(id) {
			const record = records.get(id);
			if (record === undefined) throw new Error(`unknown job ${id}`);
			if (record.status !== 'running') return;
			record.killed = true;
			record.hooks.cancel();
		},
		wait(id) {
			const record = records.get(id);
			if (record === undefined) throw new Error(`unknown job ${id}`);
			return record.hooks.done.then(() => this.get(id));
		},
	};
}

/** Status of the GUI root without a token: a healthy host answers 401, an authenticated URL answers 3xx. */
async function rootStatus(url) {
	const response = await fetch(`${new URL(url).origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
	return response.status;
}

async function answered(url) {
	try {
		await fetch(`${new URL(url).origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
		return true;
	} catch {
		return false;
	}
}

async function main() {
	if (process.env.CI) skip('CI environment: the real-host smoke is manual only');
	if (isElevated()) skip('elevated shell: a host started here could not be reaped from a normal DSH process');
	// `--launcher=shim` exercises the PATH launcher a plain Node install uses:
	// it inserts cmd.exe between the manager and the host, which is the case
	// where killing the root before `taskkill /T` used to orphan the host.
	const mode = process.argv.includes('--launcher=shim') ? 'shim' : 'production';
	if (mode === 'shim' && process.platform !== 'win32') skip('the shim launcher only exists on Windows');
	const launcher = mode === 'shim' ? resolveLauncher() : resolveSmokeLauncher();
	if (launcher === undefined) skip(`no ${mode} launcher available (installed dsh.cmd shim with app executable)`);

	// Everything lives under a throwaway DSH_HOME so the user's own instances root is never touched.
	const dshHome = await mkdtemp(join(tmpdir(), 'dsh-smoke-'));
	const instanceRoot = await createInstanceRoot({ dshHome });
	const jobs = inMemoryJobs();
	const gui = createIsolatedWebGui({
		jobs,
		launcher,
		instanceRoot,
		startTimeoutMs: START_TIMEOUT_MS,
		stopTimeoutMs: STOP_TIMEOUT_MS,
	});
	const homes = async () => (await readdir(instanceRoot.root).catch(() => [])).filter((name) => name.startsWith('run-'));
	const records = async () => readdir(join(instanceRoot.root, '.owner-records')).catch(() => []);
	const watchdog = setTimeout(() => {
		console.error('FAIL smoke timed out');
		void gui.stop().finally(() => process.exit(2));
	}, 240000);

	// The teardown must survive Ctrl+C: that interrupted probe is exactly how the orphans appeared.
	const interrupt = () => {
		console.error('interrupted: stopping the host before exit');
		void gui.stop().finally(() => process.exit(130));
	};
	process.once('SIGINT', interrupt);

	let failure;
	let step = 'start';
	let url;
	try {
		console.log(`launcher (${mode}): ${launcher.command} ${launcher.args.join(' ')}`);
		const started = await gui.ensure(OWNER, {});
		url = started.url;
		console.log(`START ${started.url}`);
		assert.equal(new URL(started.url).pathname, '/', 'the announced URL is an origin root');
		assert.equal(await rootStatus(started.url), 401, 'the host answers as an unauthenticated DSH GUI');
		const home = gui.status(OWNER).home;
		assert.ok(existsSync(ownerRecordPath(instanceRoot.root, home)), 'the ownership record exists after start');
		assert.equal((await homes()).length, 1, 'exactly one instance home exists');

		step = 'restart';
		const restarted = await gui.restart(OWNER);
		url = restarted.url;
		console.log(`RESTART ${restarted.url} portKept=${String(restarted.portKept)}`);
		assert.notEqual(restarted.url, started.url, 'a restart announces a new launch token');
		assert.equal(await rootStatus(restarted.url), 401, 'the replacement answers as an unauthenticated DSH GUI');
		assert.ok(existsSync(ownerRecordPath(instanceRoot.root, home)), 'the ownership record survives the restart');
		assert.equal((await homes()).length, 1, 'the restart reuses the same home');

		step = 'stop';
		await gui.stop(OWNER);
		assert.deepEqual(await homes(), [], 'the stop removes the instance home');
		assert.deepEqual(await records(), [], 'the stop removes the ownership record');
		assert.equal(await answered(url), false, 'the stopped host no longer answers');
	} catch (error) {
		failure = error;
	}

	// Teardown runs whether the steps passed or not; it must not mask the first failure.
	await gui.stop().catch((error) => console.error(`teardown stop: ${error?.message ?? error}`));
	await sweepStaleHomes({ instanceRoot }).catch((error) => console.error(`teardown sweep: ${error?.message ?? error}`));
	clearTimeout(watchdog);
	process.removeListener('SIGINT', interrupt);
	await rm(dshHome, { recursive: true, force: true });

	if (failure !== undefined) throw new Error(`smoke failed at ${step}: ${failure?.message ?? String(failure)}`);
	const remaining = await homes();
	if (remaining.length > 0) throw new Error(`smoke left instance homes behind: ${remaining.join(', ')}`);
	console.log('PASS start -> restart -> stop -> clean');
}

try {
	await main();
} catch (error) {
	console.error(`FAIL ${error?.message ?? String(error)}`);
	if (error?.stack) console.error(error.stack);
	process.exitCode = 1;
}

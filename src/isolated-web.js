/**
 * @module dsh-gui-auth-url/isolated-web
 *
 * Start a throwaway Web GUI host for the person at the keyboard, as a *tracked*
 * background job of the calling session.
 *
 * The desktop edition serves its own Host on a random port, and that port is
 * the live session the app is using. A person who wants a browser GUI to poke
 * at (GUI work, plugin debugging, DevTools) without touching the real session
 * needs a different Host: this module spawns `dsh web` with its own temporary
 * `DSH_HOME`, lets the OS pick a free port, reads the one line `dsh web` prints,
 * and hands the URL back. Nothing about the caller's `DSH_HOME`, sessions, or
 * logged-in account is shared; the instance is disposable and removed on stop.
 *
 * Registration goes through `ctx.jobs` so the instance is a first-class session
 * background job: it appears in the GUI's background-task roster, cancelling it
 * there kills the process, and archiving the session counts it as live activity.
 *
 * An instance is only ever created **owned**: the registry owner must be the
 * calling session id, and a composition without a job registry refuses to create
 * one at all. There is deliberately no unowned or untracked fallback — a host
 * nobody owns can neither be attributed to a session nor stopped from a roster,
 * so degrading into that state silently is worse than failing loudly.
 * `ctx.jobs` keys ownership by *session id*, not by an Agent object, so this
 * module only ever passes the string.
 *
 * The launcher mirrors the installed `dsh.cmd`: run the app's own executable as
 * Node (`ELECTRON_RUN_AS_NODE=1`) over the desktop-host CLI, falling back to
 * `dsh` on PATH for a plain Node installation.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { API_KEY_REF } from './api-key.js';
import { createInstanceHome, createInstanceRoot, INSTANCE_PREFIX, openExistingInstanceRoot, readInstanceMarker, reinstateInstanceRecord, removeInstanceHome, removeStaleInstanceHome, resolveDshHome } from './instance-home.js';

const execFileAsync = promisify(execFile);

/** The address the launcher binds and the sweep probes: one value, used by both. */
const PROBE_HOST = '127.0.0.1';

/**
 * Wait until a pid is gone, or the budget expires.
 * @param {number} pid - process id to watch.
 * @param {number} timeoutMs - budget in milliseconds.
 * @returns {Promise<boolean>} whether the process is gone.
 */
async function waitForProcessExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	return !isProcessAlive(pid);
}

/**
 * Parse the LISTENING rows of a Windows `netstat -ano` listing.
 *
 * Each row is reduced to the local endpoint and the owning pid. Keeping this a
 * pure function lets the tests pin the real parsing rules with raw text instead
 * of replacing the whole resolver.
 * @param {string} text - netstat output.
 * @returns {{address: string, port: number, pid: number}[]} listening endpoints.
 */
export function parseNetstatListeners(text) {
	const listeners = [];
	for (const line of String(text).split(/\r?\n/u)) {
		if (!/LISTENING/iu.test(line)) continue;
		const columns = line.trim().split(/\s+/u);
		if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') continue;
		const local = columns[1] ?? '';
		const at = local.lastIndexOf(':');
		if (at <= 0) continue;
		const address = local.slice(0, at).replace(/^\[|\]$/gu, '').toLowerCase();
		const port = Number(local.slice(at + 1));
		const pid = Number(columns[columns.length - 1]);
		if (!Number.isSafeInteger(port) || port <= 0) continue;
		if (!Number.isSafeInteger(pid) || pid <= 0) continue;
		listeners.push({ address, port, pid });
	}
	return listeners;
}

/**
 * Pick the single process listening on one **address and port**.
 *
 * Matching the port alone is not enough: the HTTP probe talks to one specific
 * endpoint, so a listener on `127.0.0.2:PORT` must never be mistaken for it.
 * A wildcard bind counts as a candidate, and any disagreement between
 * candidates yields `undefined` — ambiguity means "do not kill".
 *
 * @param {{address: string, port: number, pid: number}[]} listeners - parsed rows.
 * @param {number} port - port to resolve.
 * @param {string} [address] - probed address.
 * @returns {number | undefined} the owning pid, or undefined when unknown/ambiguous.
 */
export function resolvePortOwnerFrom(listeners, port, address = PROBE_HOST) {
	const wanted = String(address).toLowerCase();
	const matching = listeners.filter((entry) => entry.port === port
		&& (entry.address === wanted || entry.address === '0.0.0.0' || entry.address === '::'));
	const owners = new Set(matching.map((entry) => entry.pid));
	return owners.size === 1 ? [...owners][0] : undefined;
}

/**
 * Which process is listening on the probed endpoint, when the platform can say.
 *
 * A marker records a pid and a port; neither proves the other. Before an
 * automatic kill the sweep asks the operating system who owns that exact
 * endpoint and requires the answer to equal the recorded pid. Platforms that
 * cannot answer return `undefined`, and an unknown owner means no automatic
 * kill.
 * @param {number} port - recorded port.
 * @param {string} [address] - probed address.
 * @returns {Promise<number | undefined>} owning pid, or undefined when unknown.
 */
async function defaultResolvePortOwner(port, address = PROBE_HOST) {
	if (process.platform !== 'win32' || !Number.isSafeInteger(port) || port <= 0) return undefined;
	try {
		const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
			windowsHide: true,
			timeout: 3000,
			maxBuffer: 16 * 1024 * 1024,
		});
		return resolvePortOwnerFrom(parseNetstatListeners(stdout), port, address);
	} catch {
		return undefined;
	}
}
import { hasLaunchOptions, installArgs, isExposed, launchArgs, normalizeLaunchRequest } from './launch-options.js';

/** Prefix of every disposable home this module creates. */
export const HOME_PREFIX = 'dsh-web-gui-';

/** Marker written into each temporary home: which host process owns it and which Desktop process started it. */
export const MARKER_FILENAME = 'instance.json';

/** Background-job kind shown as the row badge in the task roster. */
export const JOB_KIND = 'web-gui';

/** Background-job label shown next to the kind. */
export const JOB_LABEL = '临时鉴权 DSH Web（dsh web）';

/** The sole line `dsh web` prints for a human: `dsh web: <url>`. */
const LAUNCH_PREFIX = 'dsh web:';

/**
 * Remove one home through the guarded deleter.
 * @param {{root: string, realRoot: string}} instanceRoot - pinned instances root.
 * @param {string} home - candidate directory.
 * @returns {Promise<void>} resolves once the home is gone or was never there.
 */
async function removeGuarded(instanceRoot, home) {
	// The normal lifecycle only ever deletes a home this process created, so the
	// creation record and its token are mandatory here. Cross-process leftovers go
	// through sweepStaleHomes' separate, narrower stale path.
	await removeInstanceHome(instanceRoot, home, { requireRecord: true });
}

/** How long one isolated host may take to print its URL (first start may install). */
const START_TIMEOUT_MS = 120000;

/** How long installing package specs into a temporary profile may take. */
const INSTALL_TIMEOUT_MS = 180000;

/** Tail of the installer output kept for the failure message (never the whole log). */
const INSTALL_OUTPUT_CAP = 4000;

/** How long a killed instance may take to settle before its home is removed anyway. */
const STOP_TIMEOUT_MS = 5000;

/** How often the URL scan re-reads captured output while the host starts. */
const POLL_MS = 150;

/** Default cap on simultaneously running isolated hosts across all owners. */
const DEFAULT_MAX_INSTANCES = 4;

/** A registry owner and access caller is a non-empty session-id string; anything else is refused. */
function normalizeOwner(value) {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Whether one PID names a live process.
 * @param {number} pid - process id to probe.
 * @returns {boolean} true when the process exists (EPERM counts as alive).
 */
export function isProcessAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code !== 'ESRCH';
	}
}

/**
 * End one child and everything it started.
 *
 * On Windows the tree must be captured **while its root is still alive**: a
 * launcher shim puts one or two `cmd.exe` processes between this manager and the
 * real host, and killing the root first reparents the descendants, so a
 * `taskkill /T` that starts afterwards walks a tree that no longer exists and
 * leaves the host running. So the direct kill is only issued once `taskkill`
 * exits (or cannot be started at all), never before it.
 *
 * @param {{pid?: number, kill?: Function}|undefined} child - the spawned host.
 * @param {object} [options] - test seams.
 * @param {NodeJS.Platform} [options.platform] - platform override.
 * @param {Function} [options.spawn] - process spawner override.
 */
export function killTree(child, options = {}) {
	if (child === null || child === undefined) return;
	const platform = options.platform ?? process.platform;
	const spawnProcess = options.spawn ?? spawn;
	const pid = Number(child?.pid);
	const directKill = () => {
		try {
			child?.kill?.();
		} catch {
			// Already gone.
		}
	};
	if (platform === 'win32' && Number.isSafeInteger(pid) && pid > 0) {
		try {
			const killer = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
			let settled = false;
			const afterTaskkill = () => {
				if (settled) return;
				settled = true;
				clearTimeout(guard);
				directKill();
			};
			// A taskkill that neither exits nor errors must not strand the child forever.
			const guard = setTimeout(afterTaskkill, 2000);
			guard?.unref?.();
			killer?.once?.('exit', afterTaskkill);
			killer?.once?.('error', afterTaskkill);
			killer?.unref?.();
			return;
		} catch {
			// Fall through to the direct kill below.
		}
	}
	directKill();
}

/** Backstop name kept for the internal call sites: one child, its whole tree. */
function terminateTree(child) {
	killTree(child);
}

/** Record which processes own one temporary home; best-effort, never blocks startup. */
function writeMarker(home, pid, port) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return;
	const marker = JSON.stringify({
		pid,
		parentPid: process.pid,
		startedAt: Date.now(),
		...(Number.isSafeInteger(port) && port > 0 ? { port } : {}),
	});
	void writeFile(join(home, MARKER_FILENAME), marker, 'utf8').catch(() => {});
}

/** The response body a live DSH host returns without its launch token; an identity signature for a recorded port. */
const UNAUTHENTICATED_MARKER = 'dsh web authentication required';

/**
 * Whether one recorded port answers as a DSH Web GUI host. Used before ending an
 * orphan by PID: a recycled PID must never get killed for an old marker.
 * @param {unknown} port - recorded listen port, possibly absent.
 * @returns {Promise<boolean>} true when the loopback port returns the DSH 401 signature.
 */
async function probeDshWeb(port) {
	const value = Number(port);
	if (!Number.isSafeInteger(value) || value <= 0 || value > 65535) return false;
	try {
		const response = await fetch(`http://127.0.0.1:${String(value)}/`, {
			signal: AbortSignal.timeout(800),
			redirect: 'manual',
		});
		if (response.status !== 401) return false;
		return (await response.text()).includes(UNAUTHENTICATED_MARKER);
	} catch {
		return false;
	}
}

/**
 * Remove leftover homes of this plugin and end the hosts that still own them.
 *
 * Every spawned host records `{pid, parentPid, port}` in its home. On plugin
 * mount, a home is stale when its host is gone, when the Desktop process that
 * started it is gone (a crash leaves both behind), or when it was recorded by an
 * earlier lifecycle of this same process (plugin reload). Marker-less homes from
 * older plugin versions are removed only once they are clearly old, so a
 * concurrent instance of this plugin is never disturbed.
 *
 * A stale home is always removed. Its host process is only ended when the
 * recorded port still answers as a DSH GUI: a recycled PID must never be killed
 * for an old marker, so an unverifiable process is left alone.
 *
 * @param {object} [options] - test seams.
 * @param {string} [options.tmpdir] - directory holding the homes.
 * @param {(pid: number) => boolean} [options.isAlive] - process probe override.
 * @param {(pid: number) => void} [options.kill] - process-tree killer override.
 * @param {(marker: object) => Promise<boolean>} [options.verifyHost] - "is this recorded host still the DSH host?" probe.
 * @param {(home: string) => Promise<void>} [options.removeHome] - legacy removal override.
 * @param {{root: string, realRoot: string}} [options.instanceRoot] - pinned instances root.
 * @param {string} [options.instancesDir] - explicit instances root path instead of the pinned one.
 * @returns {Promise<string[]>} the homes that were removed.
 */
export async function sweepStaleHomes(options = {}) {
	const isAlive = options.isAlive ?? isProcessAlive;
	const kill = options.kill ?? ((pid) => terminateTree({ pid }));
	const verifyHost = options.verifyHost ?? ((marker) => probeDshWeb(marker?.port));
	const resolvePortOwner = options.resolvePortOwner ?? defaultResolvePortOwner;
	const killWaitMs = options.killWaitMs ?? 2000;
	const waitGone = options.waitGone ?? (async (pid, timeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!isAlive(pid)) return true;
			await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		}
		return !isAlive(pid);
	});
	const removed = [];

	// The instances root is pinned once per sweep and is only ever opened, never
	// created: a maintenance pass must not write into the user's home.
	const instanceRoot = options.instanceRoot
		?? await openExistingInstanceRoot(options.instancesDir === undefined ? {} : { root: options.instancesDir }).catch(() => undefined);

	if (instanceRoot !== undefined) {
		const entries = await readdir(instanceRoot.root, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith(INSTANCE_PREFIX)) continue;
			const home = join(instanceRoot.root, entry.name);

			// The host marker is written by the launcher once a host exists. A home
			// without one proves nothing about liveness, so it is left alone.
			let hostMarker;
			try {
				hostMarker = JSON.parse(await readFile(join(home, MARKER_FILENAME), 'utf8'));
			} catch {
				continue;
			}
			const pid = Number(hostMarker?.pid);
			const parentPid = Number(hostMarker?.parentPid);
			if (!(Number.isSafeInteger(pid) && pid > 0)) continue;

			// Ownership first. No process is signalled and nothing is deleted until
			// the directory itself is proven to be this plugin's: a marker that fails
			// validation leaves both the process and the directory exactly as they are.
			try {
				await readInstanceMarker(instanceRoot, home);
			} catch {
				continue;
			}

			const hostAlive = isAlive(pid);
			const parentGone = !(Number.isSafeInteger(parentPid) && parentPid > 0 && isAlive(parentPid));
			const previousLifecycle = parentPid === process.pid;
			if (!(parentGone || previousLifecycle || !hostAlive)) continue;

			if (hostAlive) {
				// The recorded pid must be the process actually listening on the
				// recorded port before anything is signalled: a recycled pid would
				// otherwise cost an unrelated process its life.
				const ownerPid = await resolvePortOwner(Number(hostMarker?.port), PROBE_HOST).catch(() => undefined);
				if (ownerPid !== pid) continue;
				if (!(await verifyHost(hostMarker).catch(() => false))) continue;
				kill(pid);
				if (!(await waitGone(pid, killWaitMs))) continue;
			}

			const outcome = await removeStaleInstanceHome(instanceRoot, home).catch(() => undefined);
			if (outcome?.removed === true) removed.push(home);
		}
	}

	// Legacy homes written by plugin versions before 0.7.3 live under %TEMP% and
	// carry no owner token. They are removed only when their host marker exists
	// and that host is provably gone: prefix or age alone deletes nothing.
	const legacyRoot = resolve(options.tmpdir ?? tmpdir());
	const legacyEntries = await readdir(legacyRoot, { withFileTypes: true }).catch(() => []);
	for (const entry of legacyEntries) {
		if (!entry.isDirectory() || !entry.name.startsWith(HOME_PREFIX)) continue;
		const home = join(legacyRoot, entry.name);
		let hostMarker;
		try {
			hostMarker = JSON.parse(await readFile(join(home, MARKER_FILENAME), 'utf8'));
		} catch {
			continue;
		}
		const pid = Number(hostMarker?.pid);
		const parentPid = Number(hostMarker?.parentPid);
		if (!(Number.isSafeInteger(pid) && pid > 0)) continue;
		const hostAlive = isAlive(pid);
		const parentGone = !(Number.isSafeInteger(parentPid) && parentPid > 0 && isAlive(parentPid));
		const previousLifecycle = parentPid === process.pid;
		if (!(parentGone || previousLifecycle || !hostAlive)) continue;
		if (hostAlive) {
			const ownerPid = await resolvePortOwner(Number(hostMarker?.port)).catch(() => undefined);
			if (ownerPid !== pid) continue;
			if (!(await verifyHost(hostMarker).catch(() => false))) continue;
			kill(pid);
			if (!(await waitGone(pid, killWaitMs))) continue;
		}
		try {
			if (options.removeHome === undefined) await rm(home, { recursive: true, force: true, maxRetries: 3 });
			else await options.removeHome(home);
			removed.push(home);
		} catch {
			// A cleanup that failed is not a cleanup that happened: report nothing.
		}
	}

	return removed;
}

/**
 * Extract the authenticated URL from `dsh web` output.
 * @param {string} text - stdout read so far, possibly several lines.
 * @returns {string|undefined} the first absolute http(s) URL announced, if any.
 */
export function parseLaunchedUrl(text) {
	if (typeof text !== 'string' || text === '') return undefined;
	for (const line of text.split(/\r?\n/u)) {
		const trimmed = line.trim();
		const at = trimmed.indexOf(LAUNCH_PREFIX);
		if (at === -1) continue;
		const candidate = trimmed.slice(at + LAUNCH_PREFIX.length).trim();
		if (candidate === '') continue;
		let parsed;
		try {
			parsed = new URL(candidate);
		} catch {
			continue;
		}
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
	}
	return undefined;
}

/**
 * Read the explicit listen port of one announced URL.
 *
 * A restart reuses this port so the browser's auth cookie — bound to
 * `host:port` and signed with a secret kept in the temporary `DSH_HOME` — keeps
 * an already-open tab working across the restart.
 *
 * @param {string|undefined} url - absolute URL, possibly without a port.
 * @returns {number|undefined} the port, or undefined when absent or unparseable.
 */
export function portOf(url) {
	if (typeof url !== 'string' || url === '') return undefined;
	try {
		const parsed = new URL(url);
		const port = Number(parsed.port);
		return Number.isSafeInteger(port) && port > 0 ? port : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve how to start another `dsh web` from this process.
 *
 * @param {object} [options] - test seams.
 * @param {string} [options.execPath] - `process.execPath` override.
 * @param {string} [options.platform] - `process.platform` override.
 * @param {(path: string) => boolean} [options.exists] - existence probe override.
 * @returns {{command: string, args: string[], env: Record<string, string>}} launcher argv prefix.
 */
export function resolveLauncher(options = {}) {
	const execPath = options.execPath ?? process.execPath;
	const platform = options.platform ?? process.platform;
	const exists = options.exists ?? existsSync;
	const cli = join(
		dirname(execPath),
		'resources',
		'app.asar',
		'dsh',
		'node_modules',
		'@deepseek-ai',
		'dsh-desktop-host',
		'lib',
		'cli.js',
	);
	if (exists(cli)) {
		return { command: execPath, args: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
	}
	if (platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'dsh'], env: {} };
	return { command: 'dsh', args: [], env: {} };
}

/**
 * Create the per-owner manager behind the human command and the agent tool.
 *
 * `ensure(sessionId)` starts a tracked job on first use and reuses *that owner's*
 * running instance afterwards; `stop(sessionId)` cancels one owner's instance and
 * `stop()` cancels them all (used on teardown). The owner is the calling *session
 * id* — the registry's own ownership key — so the job is listed in that session's
 * task roster and the Workspace archive admission sees it while it runs. Each
 * owner owns its own host: a second session never reuses or stops the first
 * session's instance, so concurrent sessions cannot disturb each other. The
 * temporary home is removed when the child exits — however it exits, including a
 * kill from the task roster — so a killed row leaves nothing behind.
 *
 * @param {object} options - job registry, spawn seams, and tuning.
 * @param {{start: Function, get: Function, kill: Function, wait: Function}} options.jobs - the session job registry (`ctx.jobs`); required, because an instance that is not a tracked job cannot be stopped from any roster.
 * @param {string} [options.kind] - job kind; defaults to {@link JOB_KIND}.
 * @param {string} [options.label] - job label; defaults to {@link JOB_LABEL}.
 * @param {Function} [options.spawn] - `node:child_process` spawn override.
 * @param {Function} [options.makeHome] - temporary-home factory override.
 * @param {Function} [options.removeHome] - recursive removal override.
 * @param {object} [options.launcher] - launcher override (see {@link resolveLauncher}).
 * @param {number} [options.startTimeoutMs] - start deadline.
 * @param {number} [options.stopTimeoutMs] - settle deadline after a kill.
 * @param {number} [options.pollMs] - URL scan period.
 * @param {number} [options.maxInstances] - cap on simultaneously running hosts across all owners; defaults to {@link DEFAULT_MAX_INSTANCES}.
 * @param {Function} [options.resolveApiKey] - optional async resolver whose value becomes the child's `DEEPSEEK_API_KEY`.
 * @returns {{ensure: Function, stop: Function, dispose: Function}} the manager.
 */
export function createIsolatedWebGui(options = {}) {
	const jobs = options.jobs;
	if (jobs === undefined || typeof jobs.start !== 'function' || typeof jobs.kill !== 'function') {
		throw new Error('isolated Web GUI requires the session job registry (ctx.jobs)');
	}
	const spawnProcess = options.spawn ?? spawn;
	// The instances root is resolved once and reused for every create and delete
	// this manager performs. Re-resolving per call would let a changed $DSH_HOME
	// point creation and deletion at different trees. It is also created lazily:
	// a caller that injects both makeHome and removeHome (every test does) must
	// not cause a real directory to appear in the user's home.
	// The path configuration is captured here, at construction, so a later
	// environment change cannot move the root between two calls. Only the
	// filesystem work is deferred (that is what keeps injected test doubles from
	// touching the real home).
	const capturedHome = options.instanceRoot === undefined ? resolveDshHome() : undefined;
	let instanceRootPromise;
	const instanceRoot = () => {
		instanceRootPromise ??= options.instanceRoot !== undefined
			? Promise.resolve(options.instanceRoot)
			: createInstanceRoot({ dshHome: capturedHome });
		instanceRootPromise.catch(() => {});
		return instanceRootPromise;
	};
	const makeHome = options.makeHome ?? (async () => (await createInstanceHome(await instanceRoot())).home);
	const removeHome = options.removeHome ?? (async (home) => {
		await removeGuarded(await instanceRoot(), home);
	});
	const launcher = options.launcher ?? resolveLauncher();
	const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
	const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
	const pollMs = options.pollMs ?? POLL_MS;
	const waitExit = options.waitGone ?? waitForProcessExit;
	const maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES;
	const resolveApiKey = options.resolveApiKey;
	const allowPublic = options.allowPublic === true;
	const allowInstall = options.allowInstall !== false;
	const installTimeoutMs = options.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
	const kind = options.kind ?? JOB_KIND;
	const label = options.label ?? JOB_LABEL;
	/** One instance per owner (session id), so concurrent sessions never preempt each other. */
	const instances = new Map();
	/**
	 * Homes an in-place restart wants to keep while the old child exits. Keyed by
	 * the resolved path; the spawn layer asks this set at exit time, so the
	 * decision cannot be lost to closure timing.
	 */
	const retainedHomes = new Set();
	/**
	 * Which child currently owns each home, keyed like retainedHomes. A replaced
	 * host's `exit` event can arrive after its replacement is already running:
	 * confirmed exit is satisfied by the pid disappearing first, and the manager
	 * releases retention as soon as the replacement announces its URL. Without a
	 * lease, that late exit deletes the live replacement's home - and the
	 * ownership record the next stop must cite - leaving a host nobody can prove.
	 */
	const homeLeases = new Map();

	/** Job status, or `gone` when the registry no longer knows it (or fences the caller out). */
	function statusOf(id, caller) {
		try {
			return jobs.get(id, caller).status;
		} catch {
			return 'gone';
		}
	}

	/** Whether one instance is still running. */
	function live(instance) {
		if (instance === null) return false;
		const status = statusOf(instance.id, instance.owner);
		return status === 'running' || status === 'stopping';
	}

	/**
	 * Spawn the child once and expose the hooks a tracked job needs.
	 * @param {Record<string, string>} env - child environment.
	 * @param {{text: string, cursor: number}} captured - stdout capture.
	 * @param {string} home - this instance's temporary `DSH_HOME`.
	 * @param {{value: boolean}} retain - flipped before an in-place restart so the exit handler leaves the home on disk.
	 * @param {number} [port] - fixed listen port; `0`/absent lets the OS choose one.
	 * @param {string[]} [extraArgs] - exposure flags (`--host`, `--public-url`, `--trusted-host`, TLS).
	 */
	function spawnInstance(env, captured, home, shouldRetain, port, extraArgs = []) {
		const child = spawnProcess(
			launcher.command,
			[...launcher.args, 'web', '--no-open', '--port', String(port ?? 0), ...extraArgs],
			{
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		// Claim this home for this child before any exit can be delivered.
		const homeKey = resolve(home).toLowerCase();
		const lease = Symbol('home-lease');
		homeLeases.set(homeKey, lease);
		writeMarker(home, child?.pid);
		child?.stdout?.on?.('data', (chunk) => {
			captured.text += chunk.toString();
		});
		// stderr is not URL output, but it is where a busy-port conflict is
		// reported; keep it for the retryability check only.
		child?.stderr?.on?.('data', (chunk) => {
			captured.stderr = (captured.stderr ?? '') + chunk.toString();
		});
		// A host this module ended on request settles as `killed`, not `failed`:
		// the registry's roster labels that state "cancelled", while a taskkill
		// exit code alone would read as a crash.
		let cancelled = false;
		// `done` is the job outcome and settles on exit *or* error; `exited` is
		// evidence and settles only on the child's `exit` event. A spawn error says
		// nothing about the process having gone away, so it must not satisfy the
		// proof that the home is disposable.
		let markExited;
		const exited = new Promise((resolveExit) => {
			markExited = resolveExit;
		});
		const done = new Promise((resolve) => {
			child?.once?.('exit', (code) => {
				markExited();
				if (cancelled) {
					resolve({ status: 'killed', detail: 'isolated Web GUI stopped' });
					return;
				}
				resolve({
					status: code === 0 ? 'completed' : 'failed',
					detail: code === null || code === undefined ? 'terminated' : `exit code: ${String(code)}`,
				});
			});
			child?.once?.('error', (error) => resolve({
				status: 'failed',
				detail: String(error?.message ?? error),
			}));
		});
		// Retention is a manager-level decision, not a flag captured at spawn time:
		// an in-place restart keeps the home for the *old* child while the new one
		// still owns its own lifecycle.
		void exited.then(() => {
			// Only the child that still owns this home may clean it. A replaced host's
			// exit lands after the replacement claimed the lease; deleting then would
			// remove a running host's home and its ownership record.
			if (homeLeases.get(homeKey) !== lease) return;
			homeLeases.delete(homeKey);
			if (!shouldRetain()) removeHome(home).catch(() => {});
		});
		return {
			child,
			cancel: () => {
				cancelled = true;
				terminateTree(child);
			},
			/** Kept for callers that still ask; retention itself lives in the manager. */
			retainHome: () => {},
			done,
			exited,
			readOutput: () => {
				const delta = captured.text.slice(captured.cursor);
				captured.cursor = captured.text.length;
				return delta;
			},
		};
	}

	/**
	 * Install package specs into one temporary profile before its host starts.
	 *
	 * `dsh plugin --profile web add` is the sanctioned way to put a plugin into a
	 * profile; with `DSH_HOME` pointed at the disposable home it writes only there,
	 * so a plugin can be exercised before it ever touches the real profile. The
	 * command forwards to pnpm, so it runs third-party install scripts as this
	 * user — that is why `launch-options.js` restricts the specs to a conservative
	 * character set and the plugin config can refuse the option entirely.
	 *
	 * Failure is terminal for the start: a profile with half its packages
	 * installed would produce a host whose behaviour nobody can attribute.
	 *
	 * @param {string} home - the instance's temporary `DSH_HOME`.
	 * @param {string[]} specs - validated package specs.
	 * @param {Record<string, string>} env - the child environment (carries `DSH_HOME`).
	 * @returns {Promise<void>} resolves when the package manager exits 0.
	 */
	function installInto(home, specs, env) {
		const argv = installArgs(launcher, specs);
		return new Promise((resolve, reject) => {
			let output = '';
			let timedOut = false;
			let settled = false;
			let timer;
			const settle = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error === undefined) resolve();
				else reject(error);
			};
			let child;
			try {
				child = spawnProcess(argv.command, argv.args, {
					env,
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
				});
			} catch (error) {
				settle(new Error(`installing into the temporary profile could not start: ${String(error?.message ?? error)}`));
				return;
			}
			const collect = (chunk) => {
				output = (output + chunk.toString()).slice(-INSTALL_OUTPUT_CAP);
			};
			child?.stdout?.on?.('data', collect);
			child?.stderr?.on?.('data', collect);
			timer = setTimeout(() => {
				timedOut = true;
				try {
					terminateTree(child);
				} catch {
					// A child that already exited needs no kill.
				}
			}, installTimeoutMs);
			child?.once?.('exit', (code) => {
				if (timedOut) {
					settle(new Error(`installing into the temporary profile timed out after ${String(installTimeoutMs)} ms`));
					return;
				}
				if (code === 0) {
					settle();
					return;
				}
				const detail = output.trim();
				settle(new Error(`installing into the temporary profile failed (exit code ${String(code)})`
					+ (detail === '' ? '' : `: ${detail}`)));
			});
			child?.once?.('error', (error) => settle(
				new Error(`installing into the temporary profile failed: ${String(error?.message ?? error)}`),
			));
		});
	}

	/**
	 * Spawn one host for one owner and wait for its announced URL.
	 * @param {unknown} sessionId - the owning session id.
	 * @param {string} [existingHome] - a preserved temporary home to recreate the host in (in-place restart).
	 * @param {number} [port] - fixed listen port for an in-place restart; absent/0 lets the OS choose.
	 * @param {object} [request] - validated launch request ({@link import('./launch-options.js').normalizeLaunchRequest}).
	 */
	async function start(sessionId, existingHome, port, request) {
		const owner = normalizeOwner(sessionId);
		if (owner === undefined) throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
		const freshHome = existingHome === undefined;
		const home = existingHome ?? await makeHome();
		// Retention is decided by the manager (see retainedHomes): an in-place
		// restart marks this home as kept before killing the old child.
		const homeKey = () => resolve(home).toLowerCase();
		const apiKey = resolveApiKey === undefined ? undefined : await resolveApiKey().catch(() => undefined);
		// The child is its own Harness instance: it must not inherit the caller's
		// DSH_* identity (profile dir, session id, web url, shell marker). Leaking
		// DSH_PROFILE_DIR in particular makes the isolated host load the real
		// desktop profile — and every plugin mounted there — inside the disposable
		// home. Only DSH_HOME crosses the boundary, and it is set below.
		const inherited = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')),
		);
		const env = { ...inherited, ...launcher.env, DSH_HOME: home };
		if (typeof apiKey === 'string' && apiKey !== '') env[API_KEY_REF] = apiKey;
		const sharedKey = typeof apiKey === 'string' && apiKey !== '';
		// Packages go in before the host starts, so the first announced URL already
		// belongs to a profile that has them. A failure removes the fresh home: a
		// half-installed profile would start a host nobody can attribute.
		const specs = request?.install ?? [];
		if (specs.length > 0) {
			try {
				await installInto(home, specs, env);
			} catch (error) {
				if (freshHome) await removeHome(home).catch(() => {});
				throw error;
			}
		}
		const captured = { text: '', cursor: 0 };
		const outputTail = () => `${captured.text}\n${captured.stderr ?? ''}`.trim().slice(-1500);
		const extraArgs = launchArgs(request);
		// The record exists before the spawn so every failure path below can keep
		// it when the child's exit cannot be proven.
		const instance = {
			id: undefined,
			home,
			url: undefined,
			sharedKey,
			owner,
			hooks: undefined,
			request: request ?? { install: [], trustedHost: [] },
			startedAt: Date.now(),
		};
		let hooks;
		const spec = {
			kind,
			label,
			owner,
			run: () => {
				hooks = spawnInstance(env, captured, home, () => retainedHomes.has(homeKey()), port, extraArgs);
				instance.hooks = hooks;
				return hooks;
			},
		};

		let id;
		try {
			id = jobs.start(spec);
			instance.id = id;
		} catch (error) {
			// The registry may have spawned (and then refused) a child: a start
			// failure is not proof that no process exists.
			const failure = new Error(`${error?.message ?? String(error)}`);
			failure.cause = error;
			failure.exitConfirmed = hooks === undefined ? true : await confirmedExit(hooks);
			failure.portRetryable = false;
			failure.output = outputTail();
			if (!failure.exitConfirmed) {
				instances.set(owner, instance);
				failure.message = `${failure.message}; the host exit could not be confirmed, keeping ${home}`;
				throw failure;
			}
			if (freshHome) await removeHome(home).catch(() => {});
			throw failure;
		}

		const deadline = Date.now() + startTimeoutMs;
		while (Date.now() < deadline) {
			const url = parseLaunchedUrl(captured.text);
			if (url !== undefined) {
				instance.url = url;
				try {
					const parsed = new URL(url);
					const port = Number(parsed.port);
					writeMarker(home, hooks?.child?.pid, Number.isSafeInteger(port) && port > 0 ? port : (parsed.protocol === 'https:' ? 443 : 80));
				} catch {
					// Keep the spawn-time marker; the sweep then only clears this home.
				}
				// The host owns its home and may have cleared entries; re-assert the
				// ownership record now that the host is up, so a later stop can still
				// prove the directory is ours.
				await reinstateInstanceRecord(await instanceRoot(), home, { pid: hooks?.child?.pid }).catch(() => {});
				return instance;
			}
			const status = statusOf(id, owner);
			if (status !== 'running' && status !== 'stopping') {
				// A settled job is a job outcome, not an exit proof: the child may
				// still be alive after an `error`.
				const failure = new Error(`dsh web exited before announcing a URL (${status})`);
				failure.exitConfirmed = await confirmedExit(hooks);
				const logs = `${captured.text}\n${captured.stderr ?? ''}`;
				failure.portRetryable = failure.exitConfirmed && /EADDRINUSE|address already in use/iu.test(logs);
				failure.output = outputTail();
				if (!failure.exitConfirmed) {
					instances.set(owner, instance);
					failure.message = `${failure.message} and its exit could not be confirmed; keeping ${home}`;
					throw failure;
				}
				if (freshHome) await removeHome(home).catch(() => {});
				throw failure;
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}

		try {
			jobs.kill(id, owner, 'start timed out');
		} catch {
			// A job that vanished on its own needs no kill.
		}
		const timeoutFailure = new Error(`dsh web did not announce a URL within ${String(startTimeoutMs)} ms`);
		timeoutFailure.exitConfirmed = await confirmedExit(hooks);
		timeoutFailure.portRetryable = false;
		timeoutFailure.output = outputTail();
		if (!timeoutFailure.exitConfirmed) {
			instances.set(owner, instance);
			timeoutFailure.message = `${timeoutFailure.message} and its exit could not be confirmed; keeping ${home}`;
			throw timeoutFailure;
		}
		if (freshHome) await removeHome(home).catch(() => {});
		throw timeoutFailure;
	}

	/**
	 * Prove that a spawned host has actually exited.
	 *
	 * Only two things count: the child's `exit` event, or its pid disappearing
	 * from the process table. A settled job, a spawn `error`, or a timeout says
	 * nothing about whether the process is still alive.
	 * @param {object} hooks - spawn hooks.
	 * @returns {Promise<boolean>} whether exit is proven.
	 */
	async function confirmedExit(hooks) {
		const timeoutFalse = new Promise((resolveWait) => setTimeout(() => resolveWait(false), stopTimeoutMs));
		const settled = hooks?.exited === undefined
			? false
			: await Promise.race([hooks.exited.then(() => true, () => true), timeoutFalse]);
		if (settled) return true;
		const pid = Number(hooks?.child?.pid);
		if (!Number.isSafeInteger(pid) || pid <= 0) return false;
		return await waitExit(pid, stopTimeoutMs);
	}

	/**
	 * Cancel one instance; drop its temporary home unless the caller keeps it.
	 * @param {object} instance - the instance to settle.
	 * @param {object} [options] - retention choice.
	 * @param {boolean} [options.keepHome] - keep the home on disk (in-place restart).
	 */
	async function stopInstance(instance, options = {}) {
		const keepHome = options.keepHome === true;
		const homeKey = resolve(instance.home).toLowerCase();
		// Registered before the kill: the child's exit handler reads this set, and
		// it can run before this function resumes.
		// A restart holds the home for its whole operation (the old child, the
		// replacement, and any port-fallback retry); the caller releases it once a
		// replacement is running. A normal stop releases it immediately.
		if (keepHome) retainedHomes.add(homeKey);
		else retainedHomes.delete(homeKey);
		try {
			jobs.kill(instance.id, instance.owner, keepHome ? 'restarted in place' : 'stopped by /dsh-web');
		} catch {
			// Already settled; the exit check below still decides.
		}
		try {
			// Bounded even though the registry takes a timeout: a registry that
			// never answers must not hang the stop forever.
			await Promise.race([
				jobs.wait(instance.id, stopTimeoutMs, instance.owner),
				new Promise((resolveWait) => setTimeout(resolveWait, stopTimeoutMs)),
			]);
		} catch {
			// Not being able to observe the settlement is not proof of exit; the
			// direct evidence below decides.
		}
		// Backstop: a record the registry already dropped cannot cancel the producer,
		// so settle the child directly instead of leaving an orphan and its home.
		try {
			instance.hooks?.cancel?.();
		} catch {
			// Killing an already-dead child changes nothing.
		}

		// The home is only disposable once the process is provably gone.
		const exited = await confirmedExit(instance.hooks);
		if (!exited) {
			// Keep the directory and the mapping untouched: deleting it now could
			// race the still-running host, and a restart would make two processes
			// share one home.
			throw new Error(`the isolated host did not confirm exit; keeping ${instance.home} and refusing to continue`);
		}
		// This manager settled the child itself; a later exit event must not be able
		// to clean a home that (on a restart) a replacement now owns.
		homeLeases.delete(homeKey);
		// The child has exited: a normal stop releases the home and disposes of it;
		// a restart keeps the retention until its replacement is running.
		if (!keepHome) {
			retainedHomes.delete(homeKey);
			try {
				await removeHome(instance.home);
			} catch (error) {
				// The host is gone but the directory is not: reporting "stopped"
				// while the home survives would hide a leaked temporary profile.
				throw new Error(`the isolated host exited but its temporary home could not be removed: ${error?.message ?? String(error)}`);
			}
		}
	}

	/** Drop one owner's map entry and stop its instance. */
	async function stopKey(key) {
		const instance = instances.get(key);
		if (instance === undefined) return false;
		// The record is dropped only once the stop is proven. A failed stop keeps
		// the live instance addressable, so the caller can inspect and retry it
		// instead of leaking an untracked host.
		await stopInstance(instance);
		instances.delete(key);
		return true;
	}

	/**
	 * Stop one owner's instance, or every instance when no owner is given.
	 * @param {unknown} [sessionId] - owner to stop; omitted stops every instance.
	 * @returns {Promise<boolean>} whether anything was stopped.
	 */
	async function stop(sessionId) {
		if (sessionId !== undefined) {
			const owner = normalizeOwner(sessionId);
			return owner === undefined ? false : stopKey(owner);
		}
		let stopped = false;
		for (const key of [...instances.keys()]) {
			if (await stopKey(key)) stopped = true;
		}
		return stopped;
	}

	/** Map one instance to the public facts the command and the tool both read. */
	function facts(instance, reused) {
		return {
			url: instance.url,
			jobId: instance.id,
			reused,
			sharedKey: instance.sharedKey,
			startedAt: instance.startedAt,
			port: portOf(instance.url),
			install: [...(instance.request?.install ?? [])],
			exposed: isExposed(instance.request),
		};
	}

	/**
	 * Reuse this owner's running instance, or start one bound to this session id.
	 *
	 * Each owner gets its own instance: a second session never stops or reuses the
	 * first session's host, so concurrent sessions (one person at the keyboard, an
	 * agent in another) cannot disturb each other.
	 *
	 * An instance cannot exist without an owner. A call with no session id is
	 * refused here instead of degrading to an unowned host that no roster could
	 * stop, and a registry refusal of the ownership binding is propagated the same
	 * way — the failure is reported, never silently downgraded.
	 *
	 * A request that carries real launch options (an install list, a bind address,
	 * TLS, an advertised root) is a request for a *differently configured* host, so
	 * a running instance is restarted in place with them instead of being handed
	 * back stale. A bare request keeps the cheap reuse path.
	 *
	 * Starting a host is expensive (a whole `dsh web` process and its
	 * `DSH_HOME`), so a new one is refused once {@link maxInstances} hosts are
	 * already running across all owners; reusing an owner's own live host is
	 * always allowed.
	 *
	 * The command refuses to call this for a blank Session: DSH filters blank
	 * Sessions out of the session list, so an owned job would lose its only roster
	 * and become unstoppable once the person switches away.
	 *
	 * @param {unknown} sessionId - invoking session id; required.
	 * @param {object} [launchRequest] - model-facing launch options (see `launch-options.js`).
	 * @returns {Promise<object>} the instance facts; `jobId` lets the caller stop it through the job registry.
	 */
	async function ensure(sessionId, launchRequest) {
		const owner = normalizeOwner(sessionId);
		if (owner === undefined) throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
		const request = normalizeLaunchRequest(launchRequest, { allowPublic, allowInstall });
		const existing = instances.get(owner);
		if (existing !== undefined && live(existing)) {
			// A port-only request cannot be honoured by a running host, so it does not
			// count as "reconfigure this instance"; everything else does.
			if (hasLaunchOptions(request) && request.port === undefined) {
				return { ...await restart(owner, request), reused: false };
			}
			return facts(existing, true);
		}
		// Settle this owner's stale instance (its job settled or vanished) before starting over.
		if (existing !== undefined) await stopKey(owner);
		if (instances.size >= maxInstances) {
			throw new Error(`isolated Web GUI limit reached: ${String(instances.size)} of ${String(maxInstances)} hosts are already running; stop one before starting another`);
		}
		const instance = await start(owner, undefined, request.port, request);
		instances.set(owner, instance);
		return facts(instance, false);
	}

	/**
	 * Restart this owner's isolated host in place, keeping its temporary `DSH_HOME`.
	 *
	 * This is how something installed into the throwaway profile (a plugin, a
	 * setting that needs a host restart) takes effect without losing it: the host
	 * process and its background job are replaced, while the home directory and
	 * everything installed under it survive. The new host prints its own URL, so
	 * the port and the launch token change and the old address stops working.
	 *
	 * A restart does not count against {@link maxInstances}: the owner's slot is
	 * replaced, not added to. Restarting with no instance running is refused —
	 * start one first, because there is no home to preserve.
	 *
	 * @param {unknown} sessionId - invoking session id; required.
	 * @returns {Promise<{url: string, jobId: string, reused: boolean, sharedKey: boolean, restarted: true}>} the new instance facts.
	 */
	async function restart(sessionId, launchRequest) {
		const owner = normalizeOwner(sessionId);
		if (owner === undefined) throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
		const existing = instances.get(owner);
		if (existing === undefined) throw new Error('no isolated Web GUI is running for this session; start one before restarting');
		const previous = existing.request ?? { install: [], trustedHost: [] };
		const requested = normalizeLaunchRequest(launchRequest, { allowPublic, allowInstall });
		// A restart keeps the configuration the preserved home was started with and
		// replaces only the options this call names. Install specs are never re-run
		// implicitly: they already landed in the home that survives the restart, so
		// repeating the package-manager call would only add time.
		const request = {
			host: requested.host ?? previous.host,
			publicUrl: requested.publicUrl ?? previous.publicUrl,
			tlsCert: requested.tlsCert ?? previous.tlsCert,
			tlsKey: requested.tlsKey ?? previous.tlsKey,
			trustedHost: requested.trustedHost.length > 0 ? requested.trustedHost : [...(previous.trustedHost ?? [])],
			install: requested.install,
			port: requested.port,
		};
		// Stop first: a restart whose old host never confirmed exit must abort with
		// the instance still tracked, not hand the same home to a second process.
		// Hold the home from the first kill until a replacement is running: a
		// replacement that exits during a port fallback must not delete the very
		// home the retry is about to reuse. Released on success (the new host then
		// owns its own cleanup) and deliberately kept on failure (so the home
		// survives for a retry).
		const keepKey = resolve(existing.home).toLowerCase();
		retainedHomes.add(keepKey);
		await stopInstance(existing, { keepHome: true });
		instances.delete(owner);
		// Keep the previous port when possible: the browser's auth cookie is bound
		// to host:port and its signing secret lives in the kept `DSH_HOME`, so an
		// already-open tab keeps working across the restart. A busy port falls back
		// to an OS-assigned one, which is reported as a changed port.
		const port = requested.port ?? portOf(existing.url);
		let instance;
		try {
			instance = await start(owner, existing.home, port, request);
		} catch (error) {
			// Fall back to an OS-assigned port only when the failed attempt is
			// provably gone and the failure was the old port being taken. Starting
			// again on an unconfirmed exit would put two hosts on one home.
			if (port === undefined || error?.exitConfirmed !== true || error?.portRetryable !== true) throw error;
			instance = await start(owner, existing.home, undefined, request);
		}
		retainedHomes.delete(resolve(instance.home).toLowerCase());
		instances.set(owner, instance);
		return { ...facts(instance, false), restarted: true, portKept: port !== undefined && portOf(instance.url) === port };
	}

	/**
	 * Give this owner a usable host in one call: reuse-restart the running one,
	 * or start the first one.
	 *
	 * This is the human command's single-verb behaviour — it decides for the
	 * caller instead of making them choose between start and restart:
	 *
	 * - no instance for this session (or its job settled) → start a fresh host;
	 * - an instance is running → restart it in place, keeping the temporary
	 *   `DSH_HOME` so anything installed into it survives.
	 *
	 * The restart branch is deliberate: a person who repeats the command after
	 * installing a plugin expects the new host, not the stale one. The trade-off
	 * is that repeating it also invalidates the previous URL, so the result says
	 * which branch ran.
	 *
	 * @param {unknown} sessionId - invoking session id; required.
	 * @returns {Promise<{url: string, jobId: string, reused: boolean, sharedKey: boolean, restarted: boolean}>} the instance facts.
	 */
	async function ensureOrRestart(sessionId) {
		const owner = normalizeOwner(sessionId);
		if (owner === undefined) throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
		const existing = instances.get(owner);
		if (existing !== undefined && live(existing)) return { ...await restart(owner), restarted: true };
		return { ...await ensure(owner), restarted: false };
	}

	/**
	 * Report what this owner's instance looks like right now.
	 *
	 * The command and the tools stop through the session's background-task roster,
	 * so "is it still running, and where is it?" has to be answerable without
	 * reading that roster: an agent that started a host to verify a plugin needs to
	 * decide between reusing, restarting and stopping it.
	 *
	 * A record the registry no longer knows is not running, even if this manager
	 * still holds it.
	 *
	 * @param {unknown} sessionId - invoking session id; required.
	 * @returns {object} running flag, live counters, and the instance's own facts when one is recorded.
	 */
	function status(sessionId) {
		const owner = normalizeOwner(sessionId);
		if (owner === undefined) throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
		const records = [...instances.values()];
		const runningCount = records.filter((record) => live(record)).length;
		const summary = { running: false, runningCount, maxInstances };
		const instance = instances.get(owner);
		if (instance === undefined) return summary;
		const running = live(instance);
		return {
			...summary,
			running,
			...(running ? { url: instance.url, jobId: instance.id } : {}),
			startedAt: instance.startedAt,
			home: instance.home,
			port: portOf(instance.url),
			sharedKey: instance.sharedKey,
			install: [...(instance.request?.install ?? [])],
			exposed: isExposed(instance.request),
			jobStatus: statusOf(instance.id, owner),
		};
	}

	return { ensure, ensureOrRestart, restart, stop, status, dispose: stop };
}

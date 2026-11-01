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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { API_KEY_REF } from './api-key.js';

/** Prefix of every disposable home this module creates. */
export const HOME_PREFIX = 'dsh-web-gui-';

/** Marker written into each temporary home: which host process owns it and which Desktop process started it. */
export const MARKER_FILENAME = 'instance.json';

/** A marker-less home (written by an older plugin) is only removed once it is this old. */
const LEGACY_HOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Background-job kind shown as the row badge in the task roster. */
export const JOB_KIND = 'web-gui';

/** Background-job label shown next to the kind. */
export const JOB_LABEL = '临时鉴权 DSH Web（dsh web）';

/** The sole line `dsh web` prints for a human: `dsh web: <url>`. */
const LAUNCH_PREFIX = 'dsh web:';

/** How long one isolated host may take to print its URL (first start may install). */
const START_TIMEOUT_MS = 120000;

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
 * End one child and everything it started. A DSH host may own terminal or
 * helper processes, and `child.kill()` alone leaves those behind on Windows;
 * `taskkill /T` takes the tree down.
 * @param {{pid?: number, kill?: Function}|undefined} child - the spawned host.
 */
function terminateTree(child) {
	if (child === null || child === undefined) return;
	const pid = child?.pid;
	if (process.platform === 'win32' && Number.isSafeInteger(pid) && pid > 0) {
		try {
			const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
			killer?.once?.('error', () => {});
			killer?.unref?.();
		} catch {
			// Fall through to the direct kill below.
		}
	}
	try {
		child?.kill?.();
	} catch {
		// Already gone.
	}
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
 * @param {(home: string) => Promise<void>} [options.removeHome] - removal override.
 * @param {() => number} [options.now] - clock override.
 * @param {number} [options.legacyMaxAgeMs] - age after which a marker-less home is removed.
 * @returns {Promise<string[]>} the homes that were removed.
 */
export async function sweepStaleHomes(options = {}) {
	const root = options.tmpdir ?? tmpdir();
	const isAlive = options.isAlive ?? isProcessAlive;
	const kill = options.kill ?? ((pid) => terminateTree({ pid }));
	const verifyHost = options.verifyHost ?? ((marker) => probeDshWeb(marker?.port));
	const removeHome = options.removeHome ?? ((home) => rm(home, { recursive: true, force: true, maxRetries: 3 }));
	const now = options.now ?? (() => Date.now());
	const legacyMaxAgeMs = options.legacyMaxAgeMs ?? LEGACY_HOME_MAX_AGE_MS;
	const removed = [];

	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return removed;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(HOME_PREFIX)) continue;
		const home = join(root, entry.name);

		let marker;
		try {
			marker = JSON.parse(await readFile(join(home, MARKER_FILENAME), 'utf8'));
		} catch {
			marker = undefined;
		}

		const pid = Number(marker?.pid);
		const parentPid = Number(marker?.parentPid);
		if (Number.isSafeInteger(pid) && pid > 0) {
			const hostAlive = isAlive(pid);
			const parentGone = !(Number.isSafeInteger(parentPid) && parentPid > 0 && isAlive(parentPid));
			const previousLifecycle = parentPid === process.pid;
			if (parentGone || previousLifecycle || !hostAlive) {
				if (hostAlive && await verifyHost(marker).catch(() => false)) kill(pid);
				await removeHome(home).catch(() => {});
				removed.push(home);
			}
			continue;
		}

		// Marker-less home from an older plugin version: only remove what is safely old.
		let age = 0;
		try {
			age = now() - (await stat(home)).mtimeMs;
		} catch {
			age = 0;
		}
		if (age > legacyMaxAgeMs) {
			await removeHome(home).catch(() => {});
			removed.push(home);
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
	const makeHome = options.makeHome ?? (() => mkdtemp(join(tmpdir(), HOME_PREFIX)));
	const removeHome = options.removeHome ?? ((home) => rm(home, { recursive: true, force: true, maxRetries: 3 }));
	const launcher = options.launcher ?? resolveLauncher();
	const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
	const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
	const pollMs = options.pollMs ?? POLL_MS;
	const maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES;
	const resolveApiKey = options.resolveApiKey;
	const kind = options.kind ?? JOB_KIND;
	const label = options.label ?? JOB_LABEL;
	/** One instance per owner (session id), so concurrent sessions never preempt each other. */
	const instances = new Map();

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
	 */
	function spawnInstance(env, captured, home, retain, port) {
		const child = spawnProcess(launcher.command, [...launcher.args, 'web', '--no-open', '--port', String(port ?? 0)], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		writeMarker(home, child?.pid);
		child?.stdout?.on?.('data', (chunk) => {
			captured.text += chunk.toString();
		});
		// A host this module ended on request settles as `killed`, not `failed`:
		// the registry's roster labels that state "cancelled", while a taskkill
		// exit code alone would read as a crash.
		let cancelled = false;
		const done = new Promise((resolve) => {
			child?.once?.('exit', (code) => {
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
		void done.then(() => {
			if (!retain.value) removeHome(home).catch(() => {});
		});
		return {
			child,
			cancel: () => {
				cancelled = true;
				terminateTree(child);
			},
			/** Keep the temporary home when this child exits (in-place restart). */
			retainHome: () => {
				retain.value = true;
			},
			done,
			readOutput: () => {
				const delta = captured.text.slice(captured.cursor);
				captured.cursor = captured.text.length;
				return delta;
			},
		};
	}

	/**
	 * Spawn one host for one owner and wait for its announced URL.
	 * @param {unknown} sessionId - the owning session id.
	 * @param {string} [existingHome] - a preserved temporary home to recreate the host in (in-place restart).
	 * @param {number} [port] - fixed listen port for an in-place restart; absent/0 lets the OS choose.
	 */
	async function start(sessionId, existingHome, port) {
		const owner = normalizeOwner(sessionId);
		if (owner === undefined) throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
		const freshHome = existingHome === undefined;
		const home = existingHome ?? await makeHome();
		// Only the child being replaced during a restart is told to keep its home;
		// the replacement removes the home on its own normal stop.
		const retain = { value: false };
		const apiKey = resolveApiKey === undefined ? undefined : await resolveApiKey().catch(() => undefined);
		const env = { ...process.env, ...launcher.env, DSH_HOME: home };
		if (typeof apiKey === 'string' && apiKey !== '') env[API_KEY_REF] = apiKey;
		const sharedKey = typeof apiKey === 'string' && apiKey !== '';
		const captured = { text: '', cursor: 0 };
		const spec = { kind, label, owner, run: () => (hooks = spawnInstance(env, captured, home, retain, port)) };

		let hooks;
		let id;
		try {
			id = jobs.start(spec);
		} catch (error) {
			if (freshHome) await removeHome(home).catch(() => {});
			throw error;
		}

		const instance = { id, home, url: undefined, sharedKey, owner, hooks };
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
				return instance;
			}
			const status = statusOf(id, owner);
			if (status !== 'running' && status !== 'stopping') {
				if (freshHome) await removeHome(home).catch(() => {});
				throw new Error(`dsh web exited before announcing a URL (${status})`);
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}

		try {
			jobs.kill(id, owner, 'start timed out');
		} catch {
			// A job that vanished on its own needs no kill.
		}
		if (freshHome) await removeHome(home).catch(() => {});
		throw new Error(`dsh web did not announce a URL within ${String(startTimeoutMs)} ms`);
	}

	/**
	 * Cancel one instance; drop its temporary home unless the caller keeps it.
	 * @param {object} instance - the instance to settle.
	 * @param {object} [options] - retention choice.
	 * @param {boolean} [options.keepHome] - keep the home on disk (in-place restart).
	 */
	async function stopInstance(instance, options = {}) {
		const keepHome = options.keepHome === true;
		if (keepHome) instance.hooks?.retainHome?.();
		try {
			jobs.kill(instance.id, instance.owner, keepHome ? 'restarted in place' : 'stopped by /dsh-web');
		} catch {
			// Already settled; removal below still applies.
		}
		try {
			await jobs.wait(instance.id, stopTimeoutMs, instance.owner);
		} catch {
			// A settlement we cannot observe is still a stopped process.
		}
		// Backstop: a record the registry already dropped cannot cancel the producer,
		// so settle the child directly instead of leaving an orphan and its home.
		try {
			instance.hooks?.cancel?.();
		} catch {
			// Killing an already-dead child changes nothing.
		}
		if (!keepHome) await removeHome(instance.home).catch(() => {});
	}

	/** Drop one owner's map entry and stop its instance. */
	async function stopKey(key) {
		const instance = instances.get(key);
		if (instance === undefined) return false;
		instances.delete(key);
		await stopInstance(instance);
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
	 * @returns {Promise<{url: string, jobId: string, reused: boolean, sharedKey: boolean}>} the instance facts; `jobId` lets the caller stop it through the job registry.
	 */
	async function ensure(sessionId) {
		const owner = normalizeOwner(sessionId);
		if (owner === undefined) throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
		const existing = instances.get(owner);
		if (existing !== undefined && live(existing)) return facts(existing, true);
		// Settle this owner's stale instance (its job settled or vanished) before starting over.
		if (existing !== undefined) await stopKey(owner);
		if (instances.size >= maxInstances) {
			throw new Error(`isolated Web GUI limit reached: ${String(instances.size)} of ${String(maxInstances)} hosts are already running; stop one before starting another`);
		}
		const instance = await start(owner);
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
	async function restart(sessionId) {
		const owner = normalizeOwner(sessionId);
		if (owner === undefined) throw new Error('isolated Web GUI requires a session-bound owner (no session id)');
		const existing = instances.get(owner);
		if (existing === undefined) throw new Error('no isolated Web GUI is running for this session; start one before restarting');
		instances.delete(owner);
		await stopInstance(existing, { keepHome: true });
		// Keep the previous port when possible: the browser's auth cookie is bound
		// to host:port and its signing secret lives in the kept `DSH_HOME`, so an
		// already-open tab keeps working across the restart. A busy port falls back
		// to an OS-assigned one, which is reported as a changed port.
		const port = portOf(existing.url);
		let instance;
		try {
			instance = await start(owner, existing.home, port);
		} catch (error) {
			if (port === undefined) throw error;
			instance = await start(owner, existing.home);
		}
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

	return { ensure, ensureOrRestart, restart, stop, dispose: stop };
}

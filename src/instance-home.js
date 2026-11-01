/**
 * @module dsh-gui-auth-url/instance-home
 *
 * Where this plugin's disposable DSH homes live and what must be proved before
 * one is deleted.
 *
 * Location is derived per machine from the caller's Harness home
 * (`$DSH_HOME`, else `~/.dsh`); the plugin owns exactly one directory below it:
 * `<DSH_HOME>/dsh-gui-auth-url/instances/run-<uuid>`.
 *
 * Three properties are enforced here rather than at the call site, because a
 * guard the caller can forget is not a guard:
 *
 * 1. **Fresh only.** A home is created with an exclusive `mkdir` of a random
 *    name and an exclusive marker write; an existing directory is never
 *    adopted as "ours".
 * 2. **Identity, not resemblance.** The marker carries a random token minted at
 *    creation. Live removal compares it against the in-process creation record,
 *    so "a directory with a marker inside" is not enough.
 * 3. **Real location.** Both the instances root and the home are resolved
 *    through `realpath` and refused when they are reparse points (junctions,
 *    symlinks). Comparing literal strings proves nothing about where the bytes
 *    actually are.
 *
 * The check and the delete are separate system calls, so this narrows — but
 * does not formally eliminate — the race between them. Callers that cannot
 * tolerate that should keep their own exclusive handle on the directory.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

/** Directory (inside the Harness home) owned by this plugin. */
export const PLUGIN_DIR = 'dsh-gui-auth-url';

/** Directory (inside {@link PLUGIN_DIR}) holding the disposable homes. */
export const INSTANCES_DIR = 'instances';

/** Prefix of every disposable home created under {@link INSTANCES_DIR}. */
export const INSTANCE_PREFIX = 'run-';

/**
 * Ownership record file name. The records live in {@link RECORDS_DIR} under the
 * instances root — **not** inside the disposable home: the host owns that
 * directory and has been observed removing unknown files from its root on a
 * second boot, which would silently invalidate our proof.
 */
export const OWNER_MARKER = 'owner.json';

/** Directory (under the instances root) holding one record per created home. */
export const RECORDS_DIR = '.owner-records';

/**
 * Path of the ownership record for one home.
 * @param {string|{root: string}} rootOrHome - instances root, or a root object.
 * @param {string} [home] - the disposable home.
 * @returns {string} absolute record path.
 */
export function ownerRecordPath(rootOrHome, home) {
	const root = typeof rootOrHome === 'string' ? rootOrHome : rootOrHome.root;
	const target = home ?? String(rootOrHome);
	return join(root, RECORDS_DIR, `${basename(resolve(target))}.json`);
}

/** Marker format version this module writes and accepts. */
export const MARKER_VERSION = 1;

/** How often creation retries a name collision before giving up. */
const CREATE_ATTEMPTS = 5;

/** Homes created by this process: `realpath` -> creation record. */
const created = new Map();

/** In-flight removals by resolved path, so two cleanups of one home agree. */
const removing = new Map();

/**
 * Expand the tilde forms the Harness itself accepts.
 * @param {string} value - configured path.
 * @param {string} home - operating-system home directory.
 * @returns {string} the expanded value.
 */
function expandHomePath(value, home) {
	if (value === '~') return home;
	if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
	return value;
}

/**
 * Resolve the Harness home the way the host does: a non-blank `$DSH_HOME`
 * wins, blank is treated as unset, the default is `~/.dsh`.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {string} [home] - operating-system home override.
 * @returns {string} the normalized absolute Harness home.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
	const raw = env?.DSH_HOME;
	const configured = typeof raw === 'string' && raw.trim().length > 0 ? raw : join(home, '.dsh');
	return resolve(expandHomePath(configured, home));
}

/**
 * The instances root for an environment. Call it **once** per lifecycle and
 * keep the result: re-resolving later can pick up a different `$DSH_HOME`.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {string} [home] - operating-system home override.
 * @returns {string} the absolute instances root.
 */
export function instancesRoot(env = process.env, home = homedir()) {
	return join(resolveDshHome(env, home), PLUGIN_DIR, INSTANCES_DIR);
}

/**
 * Whether a resolved path is the root itself or below it.
 * @param {string} path - candidate, already absolute.
 * @param {string} root - root, already absolute.
 * @returns {boolean} true when inside (or equal to) the root.
 */
function inside(path, root) {
	const normalize = (value) => resolve(value).toLowerCase().replace(/[\\/]+$/, '');
	const full = normalize(path);
	const base = normalize(root);
	return full === base || full.startsWith(base + sep);
}

/**
 * Walk the plugin's namespace below the Harness home, one component at a time.
 *
 * The Harness home is the trust boundary: the user may legitimately put it on
 * another volume or behind their own link, so its real path is accepted. Every
 * component this plugin owns below it must be a real directory — checked
 * *before* the next level is created or descended into — so a pre-existing
 * junction cannot redirect the plugin's tree somewhere else. Creation and
 * opening share this walk on purpose: a sweep must not accept a root that a
 * start would refuse.
 *
 * @param {object} options - seams: root / dshHome / env / home.
 * @param {{create: boolean}} mode - create missing levels, or require them.
 * @returns {Promise<{root: string, realRoot: string} | undefined>} the root, or undefined when absent in open mode.
 */
async function walkNamespace(options, mode) {
	const home = resolve(options.dshHome ?? resolveDshHome(options.env, options.home));
	if (mode.create) {
		await mkdir(home, { recursive: true });
	} else {
		const homeStat = await lstat(home).catch(() => undefined);
		if (homeStat === undefined) return undefined;
	}
	let current = await realpath(home);
	let literal = home;
	for (const component of [PLUGIN_DIR, INSTANCES_DIR]) {
		literal = join(literal, component);
		if (mode.create) {
			await mkdir(literal).catch((error) => {
				if (error?.code !== 'EEXIST') throw error;
			});
		}
		const stat = await lstat(literal).catch(() => undefined);
		if (stat === undefined) {
			if (mode.create) throw new Error(`could not create the instances namespace: ${literal}`);
			return undefined;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(`a path component below the Harness home is a reparse point, refusing: ${literal}`);
		}
		if (!stat.isDirectory()) {
			throw new Error(`a path component below the Harness home is not a directory: ${literal}`);
		}
		const real = await realpath(literal);
		if (!inside(real, current)) throw new Error(`a path component escapes its parent, refusing: ${literal}`);
		current = real;
	}
	return { root: literal, realRoot: current };
}

/**
 * Create (or take over) the instances root and pin its real location.
 * @param {object} [options] - test seams.
 * @param {string} [options.root] - explicit root (test seam; bypasses the namespace walk).
 * @param {string} [options.dshHome] - already-resolved Harness home.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @param {string} [options.home] - operating-system home override.
 * @returns {Promise<{root: string, realRoot: string}>} the pinned root.
 * @throws when any component below the home is a reparse point or not a directory.
 */
export async function createInstanceRoot(options = {}) {
	if (options.root !== undefined) {
		const root = resolve(options.root);
		await mkdir(root).catch((error) => {
			if (error?.code !== 'EEXIST') throw error;
		});
		const stat = await lstat(root);
		if (stat.isSymbolicLink()) throw new Error(`the instances root is a reparse point, refusing to use it: ${root}`);
		if (!stat.isDirectory()) throw new Error(`the instances root is not a directory: ${root}`);
		return { root, realRoot: await realpath(root) };
	}
	const walked = await walkNamespace(options, { create: true });
	if (walked === undefined) throw new Error('could not create the instances root');
	return walked;
}

/**
 * Open an existing instances root **without creating anything**.
 *
 * Sweeps use this: a background maintenance pass must not invent a directory in
 * the user's home, and it goes through the same component-by-component walk as
 * creation, so an ancestor junction in the plugin namespace is refused here too.
 * @param {object} [options] - test seams.
 * @param {string} [options.root] - explicit root (test seam; bypasses the namespace walk).
 * @param {string} [options.dshHome] - already-resolved Harness home.
 * @param {Record<string, string | undefined>} [options.env] - environment to read.
 * @param {string} [options.home] - operating-system home override.
 * @returns {Promise<{root: string, realRoot: string} | undefined>} the root, or undefined when absent.
 * @throws when a component exists but is a reparse point or not a directory.
 */
export async function openExistingInstanceRoot(options = {}) {
	if (options.root !== undefined) {
		const root = resolve(options.root);
		const stat = await lstat(root).catch(() => undefined);
		if (stat === undefined) return undefined;
		if (stat.isSymbolicLink()) throw new Error(`the instances root is a reparse point, refusing to use it: ${root}`);
		if (!stat.isDirectory()) throw new Error(`the instances root is not a directory: ${root}`);
		return { root, realRoot: await realpath(root) };
	}
	return walkNamespace(options, { create: false });
}

/**
 * Create one fresh disposable home. Never adopts an existing directory.
 * @param {{root: string, realRoot: string}} instanceRoot - pinned root.
 * @returns {Promise<{home: string, realHome: string, token: string, instanceId: string}>} the record.
 * @throws when no fresh name could be claimed or the marker could not be written exclusively.
 */
export async function createInstanceHome(instanceRoot, options = {}) {
	let collision;
	for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
		const instanceId = options.instanceId ?? `${INSTANCE_PREFIX}${randomUUID()}`;
		if (!instanceId.startsWith(INSTANCE_PREFIX) || instanceId.includes('/') || instanceId.includes('\\')) {
			throw new Error(`invalid instance name: ${instanceId}`);
		}
		const home = join(instanceRoot.root, instanceId);
		try {
			await mkdir(home);
		} catch (error) {
			if (error?.code === 'EEXIST') {
				collision = error;
				continue;
			}
			throw error;
		}
		const realHome = await realpath(home);
		if (!inside(realHome, instanceRoot.realRoot)) {
			// Do not clean up a path that already escaped: a recursive delete would
			// follow it to wherever it points. Leave the scene intact and fail.
			throw new Error(`created home resolves outside the instances root; left untouched: ${realHome}`);
		}
		const token = randomUUID();
		const marker = {
			version: MARKER_VERSION,
			plugin: PLUGIN_DIR,
			instanceId,
			token,
			home,
			realHome,
			pid: process.pid,
			createdAt: new Date().toISOString(),
		};
		try {
			const records = join(instanceRoot.root, RECORDS_DIR);
			await mkdir(records, { recursive: true });
			const recordStat = await lstat(records);
			if (recordStat.isSymbolicLink() || !recordStat.isDirectory()) {
				throw new Error(`the ownership record directory is not a real directory: ${records}`);
			}
			await writeFile(ownerRecordPath(instanceRoot.root, home), JSON.stringify(marker), { encoding: 'utf8', flag: 'wx' });
		} catch (error) {
			// This directory was created by the exclusive mkdir just above and its
			// real path was proved to be inside the root, so a non-recursive rmdir
			// is the whole cleanup this needs.
			await rmdir(home).catch(() => {});
			throw new Error(`could not write the owner marker exclusively: ${error?.message ?? String(error)}`);
		}
		const record = { home, realHome, token, instanceId };
		created.set(realHome.toLowerCase(), record);
		return record;
	}
	throw new Error(`could not claim a fresh instance name under ${instanceRoot.root}: ${collision?.message ?? 'collision'}`);
}

/**
 * Read and validate one home's marker without deleting anything.
 *
 * Validation covers the marker shape, this plugin's identity, and the fact that
 * the directory's real location is still the one the marker was written for —
 * a directory moved elsewhere, or reached through a junction, fails here.
 *
 * @param {{root: string, realRoot: string}} instanceRoot - pinned root.
 * @param {string} home - candidate home.
 * @returns {Promise<object>} the validated marker.
 * @throws when the home is a reparse point, outside the root, unmarked, or mismatched.
 */
export async function readInstanceMarker(instanceRoot, home) {
	const literal = resolve(home);
	const stat = await lstat(literal);
	if (stat.isSymbolicLink()) throw new Error(`the home is a reparse point, refusing: ${literal}`);
	if (!stat.isDirectory()) throw new Error(`the home is not a directory: ${literal}`);
	const realHome = await realpath(literal);
	if (realHome.toLowerCase() === instanceRoot.realRoot.toLowerCase()) {
		throw new Error(`refusing to treat the instances root itself as a home: ${realHome}`);
	}
	if (!inside(realHome, instanceRoot.realRoot)) {
		throw new Error(`the home resolves outside the instances root ${instanceRoot.realRoot}: ${realHome}`);
	}
	if (!basename(literal).startsWith(INSTANCE_PREFIX)) {
		throw new Error(`the directory name is not an instance name: ${literal}`);
	}
	let marker;
	try {
		marker = JSON.parse(await readFile(ownerRecordPath(instanceRoot.root, literal), 'utf8'));
	} catch {
		throw new Error(`the home has no readable owner marker: ${literal}`);
	}
	if (marker?.version !== MARKER_VERSION || marker?.plugin !== PLUGIN_DIR) {
		throw new Error(`the owner marker is not this plugin's format: ${literal}`);
	}
	if (typeof marker.token !== 'string' || marker.token.length < 16) {
		throw new Error(`the owner marker carries no usable token: ${literal}`);
	}
	if (resolve(marker.home) !== literal) {
		throw new Error(`the owner marker names another literal path: ${literal}`);
	}
	if (resolve(marker.realHome).toLowerCase() !== realHome.toLowerCase()) {
		throw new Error(`the owner marker names another real path: ${literal}`);
	}
	return marker;
}

/**
 * Delete one home this process created, after proving it is still that home.
 * @param {{root: string, realRoot: string}} instanceRoot - pinned root.
 * @param {string} home - the home to remove.
 * @param {object} [options] - test seams.
 * @param {boolean} [options.requireRecord] - refuse when this process has no creation record.
 * @param {string} [options.expectToken] - token the marker must carry.
 * @returns {Promise<{removed: boolean, reason?: string}>} outcome; a missing home is not an error.
 * @throws when the target cannot be proven to be this plugin's fresh home.
 */
export async function removeInstanceHome(instanceRoot, home, options = {}) {
	const literal = resolve(home);
	const pending = removing.get(literal.toLowerCase());
	if (pending !== undefined) return pending;
	const task = removeInstanceHomeOnce(instanceRoot, literal, options).finally(() => {
		removing.delete(literal.toLowerCase());
	});
	removing.set(literal.toLowerCase(), task);
	return task;
}

/**
 * One removal, without the concurrent-call coalescing.
 * @param {{root: string, realRoot: string}} instanceRoot - pinned root.
 * @param {string} home - the home to remove.
 * @param {object} options - seams.
 * @returns {Promise<{removed: boolean, reason?: string}>} outcome.
 */
async function removeInstanceHomeOnce(instanceRoot, home, options = {}) {
	const literal = resolve(home);
	const exists = await lstat(literal).then(() => true, () => false);
	if (!exists) return { removed: false, reason: 'missing' };

	let marker;
	try {
		marker = await readInstanceMarker(instanceRoot, literal);
	} catch (error) {
		// The host's own exit handler may remove the home between the existence
		// check and this read; a disappeared home is already clean.
		if (error?.code === 'ENOENT') return { removed: false, reason: 'missing' };
		throw error;
	}
	const realHome = await realpath(literal).catch(() => '');
	if (realHome === '') return { removed: false, reason: 'missing' };
	const record = created.get(realHome.toLowerCase());
	if (record !== undefined) {
		if (marker.token !== record.token) throw new Error(`the owner token does not match the creation record: ${literal}`);
		if (options.expectToken !== undefined && record.token !== options.expectToken) {
			throw new Error(`the home belongs to a different creation record: ${literal}`);
		}
	} else if (options.requireRecord !== false) {
		// The normal lifecycle path never gets here: a home it deletes was created
		// by this process. Allowing a record-less delete would reduce ownership to
		// "a marker file exists", which an external writer can fabricate.
		throw new Error(`no creation record for this home in this process: ${literal}`);
	}

	// Re-check immediately before the delete: narrows, but cannot eliminate, the
	// window between validation and removal.
	const finalStat = await lstat(literal);
	if (finalStat.isSymbolicLink()) throw new Error(`the home became a reparse point before deletion: ${literal}`);
	await rm(literal, { recursive: true, force: true, maxRetries: 3 });
	await rm(ownerRecordPath(instanceRoot.root, literal), { force: true }).catch(() => {});
	created.delete((await realpath(literal).catch(() => literal)).toLowerCase());
	return { removed: true };
}

/**
 * Delete a home left behind by a *previous* process.
 *
 * There is no creation record to compare against, so this is deliberately a
 * separate, narrower entry point: the marker must be this plugin's format, the
 * directory must still resolve to the real path the marker recorded, and the
 * caller is responsible for having proved the host is gone. It is never used by
 * the normal start/stop lifecycle.
 * @param {{root: string, realRoot: string}} instanceRoot - pinned root.
 * @param {string} home - the stale home.
 * @returns {Promise<{removed: boolean, reason?: string}>} outcome.
 * @throws when the marker or the real path does not match.
 */
export async function removeStaleInstanceHome(instanceRoot, home) {
	const literal = resolve(home);
	const exists = await lstat(literal).then(() => true, () => false);
	if (!exists) return { removed: false, reason: 'missing' };
	await readInstanceMarker(instanceRoot, literal);
	const finalStat = await lstat(literal);
	if (finalStat.isSymbolicLink()) throw new Error(`the home became a reparse point before deletion: ${literal}`);
	await rm(literal, { recursive: true, force: true, maxRetries: 3 });
	await rm(ownerRecordPath(instanceRoot.root, literal), { force: true }).catch(() => {});
	return { removed: true };
}

/**
 * Re-assert the ownership record for a home this process created.
 *
 * The disposable home belongs to the host, which has been observed clearing
 * unknown entries from it; the record lives outside that home but a restart can
 * still leave it missing. Rewriting it after the host announces its URL makes
 * "created here" survive that, without ever granting ownership to a directory
 * this process did not create: the token comes from the in-process record.
 *
 * @param {{root: string, realRoot: string}} instanceRoot - pinned root.
 * @param {string} home - the home to re-assert.
 * @param {object} [options] - seams.
 * @param {number} [options.pid] - host pid to record.
 * @returns {Promise<{restored: boolean, reason?: string, replaced?: boolean}>} outcome.
 */
export async function reinstateInstanceRecord(instanceRoot, home, options = {}) {
	const literal = resolve(home);
	const realHome = await realpath(literal).catch(() => '');
	if (realHome === '') return { restored: false, reason: 'missing-home' };
	const record = created.get(realHome.toLowerCase());
	if (record === undefined) return { restored: false, reason: 'no-record' };
	const marker = {
		version: MARKER_VERSION,
		plugin: PLUGIN_DIR,
		instanceId: record.instanceId,
		token: record.token,
		home: literal,
		realHome,
		pid: Number.isSafeInteger(options.pid) && options.pid > 0 ? options.pid : process.pid,
		createdAt: new Date().toISOString(),
	};
	await mkdir(join(instanceRoot.root, RECORDS_DIR), { recursive: true });
	const path = ownerRecordPath(instanceRoot.root, literal);
	try {
		await writeFile(path, JSON.stringify(marker), { encoding: 'utf8', flag: 'wx' });
		return { restored: true };
	} catch (error) {
		if (error?.code !== 'EEXIST') throw error;
		try {
			await readInstanceMarker(instanceRoot, literal);
			return { restored: false, reason: 'present' };
		} catch {
			await writeFile(path, JSON.stringify(marker), 'utf8');
			return { restored: true, replaced: true };
		}
	}
}

/** Test-only: forget every creation record. */
export function __resetCreationRecords() {
	created.clear();
}

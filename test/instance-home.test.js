import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	INSTANCE_PREFIX,
	OWNER_MARKER,
	__resetCreationRecords,
	createInstanceHome,
	createInstanceRoot,
	openExistingInstanceRoot,
	ownerRecordPath,
	reinstateInstanceRecord,
	readInstanceMarker,
	removeInstanceHome,
	removeStaleInstanceHome,
	resolveDshHome,
} from '../src/instance-home.js';

/** A throwaway Harness home and its pinned instances root. */
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'dsh-ih-'));
	const instanceRoot = await createInstanceRoot({ root: join(home, 'instances') });
	return { home, instanceRoot };
}

test('the Harness home follows $DSH_HOME, then ~/.dsh', async () => {
	const home = await mkdtemp(join(tmpdir(), 'dsh-ih-'));
	try {
		assert.equal(resolveDshHome({}, home), resolve(home, '.dsh'), 'unset falls back to ~/.dsh');
		assert.equal(resolveDshHome({ DSH_HOME: '' }, home), resolve(home, '.dsh'), 'blank is treated as unset');
		assert.equal(resolveDshHome({ DSH_HOME: '   ' }, home), resolve(home, '.dsh'), 'whitespace is treated as unset');
		const elsewhere = join(home, 'custom');
		assert.equal(resolveDshHome({ DSH_HOME: elsewhere }, home), resolve(elsewhere), 'explicit wins');
		assert.equal(resolveDshHome({ DSH_HOME: '~' }, home), resolve(home), 'a bare tilde is the OS home');
		assert.equal(resolveDshHome({ DSH_HOME: '~/nested' }, home), resolve(home, 'nested'), '~/ expands');
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('a created home is marked, fresh, and removable once', async () => {
	const { home, instanceRoot } = await fixture();
	try {
		const record = await createInstanceHome(instanceRoot);
		assert.ok(record.home.startsWith(join(instanceRoot.root, INSTANCE_PREFIX)), 'home keeps the prefixed name');
		assert.ok(existsSync(ownerRecordPath(instanceRoot.root, record.home)), 'the owner record exists outside the home');
		const marker = JSON.parse(await readFile(ownerRecordPath(instanceRoot.root, record.home), 'utf8'));
		assert.equal(marker.token, record.token, 'the marker carries the minted token');
		assert.equal(await readInstanceMarker(instanceRoot, record.home).then((m) => m.token), record.token);

		assert.deepEqual(await removeInstanceHome(instanceRoot, record.home), { removed: true });
		assert.equal(existsSync(record.home), false, 'the home is gone');
		assert.deepEqual(
			await removeInstanceHome(instanceRoot, record.home),
			{ removed: false, reason: 'missing' },
			'a repeated cleanup is a no-op, not an error',
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('an existing directory is never adopted as a fresh home', async () => {
	const { home, instanceRoot } = await fixture();
	try {
		const claimed = `${INSTANCE_PREFIX}already-there`;
		await mkdir(join(instanceRoot.root, claimed), { recursive: true });
		await assert.rejects(
			() => createInstanceHome(instanceRoot, { instanceId: claimed }),
			/could not claim a fresh instance name/,
		);
		const marker = ownerRecordPath(instanceRoot.root, join(instanceRoot.root, claimed));
		assert.equal(existsSync(marker), false, 'the pre-existing directory was not given a marker');
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('the instances root itself is never removable', async () => {
	const { home, instanceRoot } = await fixture();
	try {
		await assert.rejects(
			() => removeInstanceHome(instanceRoot, instanceRoot.root),
			/refusing to treat the instances root itself as a home|not an instance name/,
		);
		assert.ok(existsSync(instanceRoot.root));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('a forged marker is refused', async () => {
	const { home, instanceRoot } = await fixture();
	try {
		const record = await createInstanceHome(instanceRoot);
		const markerPath = ownerRecordPath(instanceRoot.root, record.home);
		const marker = JSON.parse(await readFile(markerPath, 'utf8'));
		marker.token = 'forged-token-000000';
		await writeFile(markerPath, JSON.stringify(marker), 'utf8');

		// Same process, but the token no longer matches the creation record.
		await assert.rejects(
			() => removeInstanceHome(instanceRoot, record.home),
			/token does not match the creation record/,
		);
		assert.ok(existsSync(record.home), 'the forged home survives');

		// A fresh process (no record) still validates the marker shape, not the token.
		__resetCreationRecords();
		await assert.rejects(
			() => removeInstanceHome(instanceRoot, record.home, { requireRecord: true }),
			/no creation record/,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('a marker naming another path is refused', async () => {
	const { home, instanceRoot } = await fixture();
	try {
		const record = await createInstanceHome(instanceRoot);
		const markerPath = ownerRecordPath(instanceRoot.root, record.home);
		const marker = JSON.parse(await readFile(markerPath, 'utf8'));
		marker.home = join(home, 'somewhere-else');
		await writeFile(markerPath, JSON.stringify(marker), 'utf8');
		await assert.rejects(() => removeInstanceHome(instanceRoot, record.home), /names another literal path/);
		assert.ok(existsSync(record.home));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('an ancestor junction is refused', async () => {
	const { home, instanceRoot } = await fixture();
	const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'));
	try {
		const link = join(instanceRoot.root, 'linked');
		try {
			await mkdir(link, { recursive: true });
			await rm(link, { recursive: true, force: true });
			await fs_symlink(outside, link);
		} catch (error) {
			if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOSYS') return;
			throw error;
		}
		const escaped = join(link, `${INSTANCE_PREFIX}escaped`);
		await mkdir(escaped, { recursive: true });
		const marker = {
			version: 1,
			plugin: 'dsh-gui-auth-url',
			instanceId: `${INSTANCE_PREFIX}escaped`,
			token: 'token-from-outside-000',
			home: escaped,
			realHome: resolve(escaped),
			pid: process.pid,
			createdAt: new Date().toISOString(),
		};
		await mkdir(join(instanceRoot.root, '.owner-records'), { recursive: true });
		await writeFile(ownerRecordPath(instanceRoot.root, escaped), JSON.stringify(marker), 'utf8');
		await assert.rejects(
			() => removeInstanceHome(instanceRoot, escaped),
			/resolves outside the instances root|reparse point/,
		);
		assert.ok(existsSync(escaped), 'the escaped directory survives');
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test('a root that is itself a reparse point is refused', async () => {
	const home = await mkdtemp(join(tmpdir(), 'dsh-ih-'));
	const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'));
	try {
		const link = join(home, 'instances');
		try {
			await fs_symlink(outside, link);
		} catch (error) {
			if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOSYS') return;
			throw error;
		}
		await assert.rejects(
			() => createInstanceRoot({ root: link }),
			/the instances root is a reparse point/,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test('opening the root applies the same namespace checks as creating it', async () => {
	const home = await mkdtemp(join(tmpdir(), 'dsh-ih-'));
	const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'));
	try {
		try {
			await fs_symlink(outside, join(home, 'dsh-gui-auth-url'));
		} catch (error) {
			if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOSYS') return;
			throw error;
		}
		await assert.rejects(
			() => openExistingInstanceRoot({ env: { DSH_HOME: home } }),
			/a path component below the Harness home is a reparse point/,
			'a sweep must not accept a root that a start would refuse',
		);
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test('a normal delete requires the creation record, and the stale path does not', async () => {
	const { home, instanceRoot } = await fixture();
	try {
		const record = await createInstanceHome(instanceRoot);
		__resetCreationRecords();
		await assert.rejects(
			() => removeInstanceHome(instanceRoot, record.home),
			/no creation record/,
			'a record-less delete is not allowed on the normal path',
		);
		assert.ok(existsSync(record.home), 'the home survives');
		const outcome = await removeStaleInstanceHome(instanceRoot, record.home);
		assert.deepEqual(outcome, { removed: true }, 'the explicit stale path still works after a restart');
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('a record removed after creation is reinstated from the in-process token', async () => {
	const { home, instanceRoot } = await fixture();
	try {
		const record = await createInstanceHome(instanceRoot);
		const recordPath = ownerRecordPath(instanceRoot.root, record.home);
		await rm(recordPath, { force: true });
		await assert.rejects(() => removeInstanceHome(instanceRoot, record.home), /no readable owner marker/);
		const restored = await reinstateInstanceRecord(instanceRoot, record.home);
		assert.deepEqual(restored, { restored: true }, 'the record is written again');
		const marker = await readInstanceMarker(instanceRoot, record.home);
		assert.equal(marker.token, record.token, 'the same token proves ownership');
		assert.deepEqual(await removeInstanceHome(instanceRoot, record.home), { removed: true });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('reinstating a record for a directory this process did not create does nothing', async () => {
	const { home, instanceRoot } = await fixture();
	try {
		const foreign = join(instanceRoot.root, `${INSTANCE_PREFIX}foreign`);
		await mkdir(foreign, { recursive: true });
		assert.deepEqual(
			await reinstateInstanceRecord(instanceRoot, foreign),
			{ restored: false, reason: 'no-record' },
			'no token, no ownership',
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('a pre-existing junction in the plugin namespace is refused', async () => {
	const home = await mkdtemp(join(tmpdir(), 'dsh-ih-'));
	const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'));
	try {
		try {
			await fs_symlink(outside, join(home, 'dsh-gui-auth-url'));
		} catch (error) {
			if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOSYS') return;
			throw error;
		}
		await assert.rejects(
			() => createInstanceRoot({ env: { DSH_HOME: home } }),
			/a path component below the Harness home is a reparse point/,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

/** symlink helper kept behind a name so the test body reads cleanly. */
async function fs_symlink(target, path) {
	const { symlink } = await import('node:fs/promises');
	await symlink(target, path, 'junction');
}

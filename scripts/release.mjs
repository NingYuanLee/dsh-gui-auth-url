#!/usr/bin/env node
/**
 * Cut a release from a clean `main`: bump the version, commit, tag, push.
 *
 * The bump runs through `npm version`, so the `preversion` hook in package.json
 * runs the full validation chain (tests + syntax + pack) before anything is
 * committed; a red check aborts the release with the tree untouched.
 *
 * Pushing the tag is what publishes: `.github/workflows/publish.yml` runs
 * `npm publish` on any `v*` tag when the repository secret `NPM_TOKEN` exists,
 * and skips cleanly when it does not. Nothing is published from this machine.
 *
 * Usage: npm run release -- <patch|minor|major> [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const USAGE = 'usage: npm run release -- <patch|minor|major> [--dry-run]';
const KINDS = ['patch', 'minor', 'major'];
const bump = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!KINDS.includes(bump)) {
	process.stderr.write(`${USAGE}\n`);
	process.exit(1);
}

/** Run one command in the repository root with inherited stdio. */
function run(command, args) {
	execFileSync(command, args, {
		cwd: process.cwd(),
		stdio: 'inherit',
		shell: process.platform === 'win32',
	});
}

/** Run one command and return its trimmed stdout. */
function output(command, args) {
	return execFileSync(command, args, {
		cwd: process.cwd(),
		encoding: 'utf8',
		shell: process.platform === 'win32',
	}).trim();
}

/** The package version right now. */
function currentVersion() {
	return JSON.parse(readFileSync('package.json', 'utf8')).version;
}

/**
 * Apply one semver kind to a plain `X.Y.Z` version for the dry-run preview.
 * @param {string} version - current version.
 * @param {'patch'|'minor'|'major'} kind - which component moves.
 * @returns {string} the previewed next version.
 */
function previewNext(version, kind) {
	const parts = version.split('.').map(Number);
	if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
		throw new Error(`cannot preview "${version}"; expected X.Y.Z`);
	}
	if (kind === 'major') return `${parts[0] + 1}.0.0`;
	if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
	return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

const branch = output('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') {
	process.stderr.write(`release must run on main, not "${branch}"\n`);
	process.exit(1);
}

if (output('git', ['status', '--porcelain']) !== '') {
	process.stderr.write('working tree is not clean; commit or stash before releasing\n');
	process.exit(1);
}

const from = currentVersion();
if (dryRun) {
	process.stdout.write(`dry-run: would run \`npm version ${bump}\` (${from} -> ${previewNext(from, bump)}), then push main and the tag\n`);
	process.exit(0);
}

// `preversion` validates first; a failure leaves the tree unchanged.
run('npm', ['version', bump, '-m', 'chore(release): %s']);
const released = currentVersion();

run('git', ['push', 'origin', 'HEAD']);
run('git', ['push', 'origin', `v${released}`]);

process.stdout.write(`\nreleased v${released}\n`);
process.stdout.write('GitHub Actions publishes it when the repository secret NPM_TOKEN is configured;\n');
process.stdout.write('otherwise the Publish run skips and you can still publish manually.\n');

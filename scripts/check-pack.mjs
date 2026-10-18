#!/usr/bin/env node
/**
 * Verify that `npm pack` ships every runtime and metadata file, and nothing
 * that belongs to development only.
 *
 * Run by `prepublishOnly` and CI so a broken `files` whitelist fails before a
 * release instead of producing a package that loads but shows no metadata.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const REQUIRED = [
	'package.json',
	'README.md',
	'LICENSE',
	'CHANGELOG.md',
	'SECURITY.md',
	'cordis.patch.yml',
	'src/index.js',
	'src/auth-url.js',
	'icon.svg',
	'locale/en.json',
	'locale/zh.json',
];
const FORBIDDEN_PREFIXES = ['test/', 'scripts/', '.github/'];

const result = spawnSync(`${npm} pack --dry-run --json`, {
	cwd: root,
	encoding: 'utf8',
	shell: true,
	maxBuffer: 16 * 1024 * 1024,
});

if (result.status !== 0) {
	process.stderr.write(result.stdout ?? '');
	process.stderr.write(result.stderr ?? '');
	throw new Error(`npm pack --dry-run failed with exit code ${String(result.status)}`);
}

const report = JSON.parse(result.stdout);
const files = new Set((report[0]?.files ?? []).map((file) => file.path));
const problems = [];
for (const required of REQUIRED) {
	if (!files.has(required)) problems.push(`missing from the tarball: ${required}`);
}
for (const path of files) {
	if (FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix))) {
		problems.push(`development-only file shipped: ${path}`);
	}
}
for (const readme of pkg.files?.filter?.((entry) => entry.startsWith('README')) ?? []) {
	if (readme.includes('*')) {
		for (const name of ['README-zh.md', 'README-es.md', 'README-pt.md', 'README-hi.md']) {
			if (!files.has(name)) problems.push(`missing translated README: ${name}`);
		}
	}
}

if (problems.length > 0) {
	process.stderr.write(`check-pack: ${problems.join('\ncheck-pack: ')}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(`check-pack: ok (${String(files.size)} files, ${pkg.name}@${pkg.version})\n`);
}

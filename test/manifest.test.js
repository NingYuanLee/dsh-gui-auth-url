import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, regardless of the directory the test runner starts in. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
const pkg = readJson('package.json');

const LOCALES = ['en', 'zh', 'es', 'pt', 'hi'];
const README_LANGS = ['README.md', 'README-zh.md', 'README-es.md', 'README-pt.md', 'README-hi.md'];
const ICON_MAX_BYTES = 262144;

test('declares an installable bundle with the current manifest version', () => {
	assert.equal(pkg.dsh?.manifestVersion, 1);
	assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
	assert.ok(existsSync(join(root, 'cordis.patch.yml')));
});

test('declares the verified dsh and node ranges', () => {
	assert.equal(pkg.engines?.dsh, '>=0.2.1-rc.2 <0.3.0-0');
	assert.match(pkg.engines?.node ?? '', /22\.19/u);
	assert.equal(pkg.packageManager, 'pnpm@11.7.0');
});

test('declares a dsh-tools peer range for the current generation', () => {
	assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-tools'], '>=0.2.1-0 <0.3.0');
});

test('publishes locale display metadata for every supported language', () => {
	assert.equal(pkg.exports?.['./locale/*.json'], './locale/*.json');
	for (const lang of LOCALES) {
		const meta = readJson(`locale/${lang}.json`);
		assert.equal(typeof meta.meta?.title, 'string', `locale/${lang}.json meta.title`);
		assert.notEqual(meta.meta.title.trim(), '', `locale/${lang}.json meta.title is empty`);
		assert.equal(typeof meta.meta?.description, 'string', `locale/${lang}.json meta.description`);
		assert.notEqual(meta.meta.description.trim(), '', `locale/${lang}.json meta.description is empty`);
	}
});

test('exports an icon within the harness size and format limits', () => {
	assert.equal(pkg.exports?.['./icon'], './icon.svg');
	const icon = join(root, 'icon.svg');
	assert.ok(existsSync(icon), 'icon.svg exists');
	assert.match(icon, /\.(svg|png|jpe?g|webp)$/u);
	assert.ok(statSync(icon).size > 0, 'icon is not empty');
	assert.ok(statSync(icon).size <= ICON_MAX_BYTES, 'icon is at most 256 KiB');
});

test('lists every runtime and metadata file in the files whitelist', () => {
	const files = pkg.files ?? [];
	for (const entry of ['src', 'cordis.patch.yml', 'locale', 'icon.svg', 'SECURITY.md', 'README*.md']) {
		assert.ok(files.includes(entry), `files includes ${entry}`);
	}
});

test('ships all five README languages with matching level-2 headings', () => {
	const headingsOf = (text) => text.split(/\r?\n/u)
		.filter((line) => line.startsWith('## '))
		.map((line) => line.slice(3).trim());
	const base = headingsOf(readFileSync(join(root, 'README.md'), 'utf8'));
	assert.ok(base.length > 0, 'README.md has level-2 headings');
	for (const lang of README_LANGS) {
		const text = readFileSync(join(root, lang), 'utf8');
		assert.notEqual(text.trim(), '', `${lang} is not empty`);
		const headings = headingsOf(text);
		for (const heading of base) assert.ok(headings.includes(heading), `${lang} keeps "## ${heading}"`);
	}
});

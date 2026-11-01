/**
 * Browser half of dsh-gui-auth-url: give the host commands a Chinese row label
 * and a line icon in the composer's "＋" / "/" command menu, and repeat a
 * `/dsh-web` failure in the composer when a blank Session has nowhere to
 * render it.
 *
 * Why a patch: `CommandDefinition` has no label or icon field, the descriptor
 * is rebuilt field by field on the host (`dsh-commands` keeps only name /
 * description / input), `CommandDecoration` exposes no label/icon, and the
 * client's `candidates()` only decorates a fixed whitelist of first-party
 * packages. `dsh-client-ui-commands` registers its slash source with a closure
 * — `candidates: (session, req) => this.candidates(session, req)` — so the
 * method is looked up on the *instance* at call time, and an own-property
 * override shadows the prototype method. That is the only seam available.
 *
 * Degradation (never break the menu):
 *   1. `commandUi` or `commandUi.candidates` missing → warn, install nothing;
 *   2. the patch itself throwing → return the original rows untouched;
 *   3. a row that already carries an icon → pass through (official support
 *      later makes this patch a no-op).
 *
 * The failure notice is separate from the menu patch. A blank Session renders
 * the Hero layout instead of the chat transcript, and a host command's outcome
 * is rendered as a `command/run` + `command/done` flow node inside that
 * transcript only — the composer never echoes a bare command's error result. The
 * blank-Session refusal this plugin returns therefore had no visible surface at
 * all; `command/executed` is the one client event that still fires, and the
 * composer notice channel it feeds exists in every phase.
 *
 * The same trick is documented in `dsh-pet`'s `src/client/command-faces.ts`.
 */
;(() => {
	'use strict';

	const PLUGIN_ID = 'dsh-gui-auth-url';

	/** Row labels per language; `label` is shown instead of the bare name. */
	const LABELS = {
		zh: { 'dsh-web': '临时鉴权 DSH Web' },
		en: { 'dsh-web': 'Temporary Authenticated DSH Web' },
	};

	/** Deprecated command spellings: still executable, hidden from the palette. */
	const HIDDEN_COMMANDS = new Set(['web-gui']);

	/** Host commands whose failure is repeated in a blank Session's composer. */
	const COMMAND_NAMES = new Set(['dsh-web', 'web-gui']);

	/** Icon component names to try; the suffix follows the installed primitives generation. */
	const ICON_NAMES = {
		'dsh-web': ['IconGlobeOutlineRegular', 'IconBrowseOutlineRegular', 'IconLinkOutlineRegular'],
	};

	/** Resolved `@deepseek-ai/dsh-client-ui-primitives` surface, when reachable. */
	let primitives;

	/** Pick the row language from the document, like other client surfaces do. */
	function currentLanguage() {
		const raw = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang)
			|| (typeof navigator !== 'undefined' && navigator.language)
			|| 'en';
		return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en';
	}

	/** One command's label in the current language. */
	function labelOf(commandName) {
		return (LABELS[currentLanguage()] ?? LABELS.en)[commandName];
	}

	/**
	 * Resolve one command's row icon.
	 *
	 * The menu renders `icon` as a component (`<Icon size={14} />`), so this must
	 * return a component type, not an element and not an arbitrary glyph: a
	 * string is interpreted as a reference-icon kind, not as literal text. When
	 * the primitives package is unreachable the row simply keeps no icon.
	 *
	 * @param {string} commandName - host command name.
	 * @returns {unknown} icon component, or undefined for no icon.
	 */
	function iconOf(commandName) {
		for (const candidate of ICON_NAMES[commandName] ?? []) {
			const component = primitives?.[candidate];
			if (component !== undefined && component !== null) return component;
		}
		return undefined;
	}

	/**
	 * Patch `commandUi.candidates` so matching rows gain a label and icon.
	 * @param {object} commandUi - the client commandUi service instance.
	 * @param {Map<string, {label: (() => string) | string, icon: unknown}>} faces - name to face.
	 * @returns {() => void} disposer restoring the original method.
	 */
	function installCommandFaces(commandUi, faces) {
		const original = commandUi.candidates;
		if (typeof original !== 'function') {
			console.warn('[dsh-gui-auth-url] 命令中文名/图标不可用：commandUi.candidates 缺失（命令本身仍可用）');
			return () => {};
		}

		const patched = async (session, req) => {
			const rows = await original.call(commandUi, session, req);
			try {
				if (!Array.isArray(rows)) return rows;
				return rows
					.filter((raw) => !(raw !== null && typeof raw === 'object' && HIDDEN_COMMANDS.has(raw.name)))
					.map((raw) => {
						if (raw === null || typeof raw !== 'object') return raw;
						const face = faces.get(typeof raw.name === 'string' ? raw.name : '');
						if (face === undefined || raw.icon !== undefined) return raw;
						const label = typeof face.label === 'function' ? face.label() : face.label;
						return { ...raw, label, ...(face.icon === undefined ? {} : { icon: face.icon }) };
					});
			} catch (error) {
				console.warn('[dsh-gui-auth-url] 命令面孔补丁异常，本次退回原始菜单行：'
					+ (error instanceof Error ? error.message : String(error)));
				return rows;
			}
		};

		commandUi.candidates = patched;
		return () => {
			if (commandUi.candidates === patched) commandUi.candidates = original;
		};
	}

	/**
	 * Repeat one `/dsh-web` failure in the composer when the Session has no
	 * transcript to render it in.
	 *
	 * `dsh-client-ui-commands` deliberately never echoes a bare command's error
	 * result to the composer: the outcome renders as a persistent flow node built
	 * from the host's `command/run` and `command/done` events. A blank Session
	 * renders the Hero layout instead of the chat transcript, so that node is
	 * never mounted and the blank-Session refusal this plugin returns reached
	 * nobody. `command/executed` is emitted on the client root whatever the phase,
	 * and the composer notice channel is the same one the command runtime uses for
	 * admission failures — so a blank-Session failure is repeated there.
	 *
	 * An ordinary Session already shows the flow node, so it is left alone:
	 * repeating the text there would be noise.
	 *
	 * @param {object} ctx - client plugin context.
	 */
	function installFailureNotice(ctx) {
		if (typeof ctx.on !== 'function') return;
		ctx.on('command/executed', (sessionId, name, result) => {
			if (!COMMAND_NAMES.has(name)) return;
			if (result === null || typeof result !== 'object' || result.kind !== 'error') return;
			const text = typeof result.text === 'string' ? result.text : '';
			if (text === '') return;
			try {
				const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
				if (sessions === undefined || sessions === null) return;
				// An unknown `blank` falls through to the notice: a readable failure
				// beats a silently swallowed one when the snapshot is unavailable.
				const snapshot = typeof sessions.binding === 'function'
					? sessions.binding(sessionId)?.session?.getSnapshot?.()
					: undefined;
				if (snapshot !== undefined && snapshot.blank !== true) return;
				const actx = typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined;
				const input = actx?.get?.('conversation')?.input?.for?.(actx);
				if (typeof input?.notify !== 'function') return;
				input.notify('error', text);
			} catch (error) {
				console.warn('[dsh-gui-auth-url] 空白会话提示回显失败：'
					+ (error instanceof Error ? error.message : String(error)));
			}
		});
	}

	/** Client plugin mounted by the web shell: patch the command rows once. */
	function apply(ctx) {
		installFailureNotice(ctx);
		ctx.effect(() => {
			const commandUi = typeof ctx.get === 'function' ? ctx.get('commandUi') : undefined;
			if (commandUi === undefined || commandUi === null) {
				console.warn('[dsh-gui-auth-url] 命令中文名/图标不可用：commandUi 服务缺失（命令本身仍可用）');
				return () => {};
			}
			const faces = new Map();
			for (const commandName of Object.keys(LABELS.zh)) {
				faces.set(commandName, { label: () => labelOf(commandName), icon: iconOf(commandName) });
			}
			return installCommandFaces(commandUi, faces);
		}, 'gui-auth-url: command faces');
	}

	/** Hand the plugin object to the shell's lazy CJS loader. */
	window.__ModuleLoader__.load({
		id: PLUGIN_ID,
		factory(require) {
			try {
				primitives = require('@deepseek-ai/dsh-client-ui-primitives');
			} catch (error) {
				primitives = undefined;
				console.warn('[dsh-gui-auth-url] primitives 不可用，命令行将没有图标：'
					+ (error instanceof Error ? error.message : String(error)));
			}
			return { name: PLUGIN_ID, inject: ['commandUi'], apply };
		},
	});
})();

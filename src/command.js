/**
 * @module dsh-gui-auth-url/command
 *
 * Human half of the plugin: a `/dsh-web` slash command (the old `/web-gui` spelling stays as an alias) that starts a throwaway
 * Web GUI host — its own process, its own OS-assigned port, its own temporary
 * `DSH_HOME` — and opens it in the system default browser.
 *
 * It deliberately does *not* hand out the desktop edition's own port: that port
 * serves the live session the app is using, so opening it in a browser is not an
 * isolated place to work. See `./isolated-web.js` for the launcher and lifetime.
 *
 * `@deepseek-ai/dsh-commands` is the one human-facing surface every DSH UI
 * adapter shares. Registration is optional: a profile with no `commands` service
 * keeps the agent tool and simply gains no slash command.
 */
import { spawn } from 'node:child_process';

/** Slash command name, without the leading slash. */
export const COMMAND_NAME = 'dsh-web';

/** Deprecated alias kept for one release so old notes and muscle memory still work. */
export const COMMAND_ALIAS = 'web-gui';

/** Discovery text shown by the command palette. */
export const COMMAND_DESCRIPTION = '启动或重启本会话的临时鉴权 DSH Web（独立进程 + 临时数据目录）：没有实例就启动，有实例就原地重启并保留已装插件；用默认浏览器打开。停止在「后台任务」列表里操作（空白会话需先发一条消息）。';

const USAGE = `用法：/${COMMAND_NAME}（没有实例就启动，有实例就原地重启并保留临时数据目录与已装插件）；停止请在会话的「后台任务」列表里操作`;

const BLANK_SESSION_MESSAGE = '当前会话还没有消息，不能启动临时鉴权 DSH Web：DSH 会把这种空白会话从会话列表里过滤掉，'
	+ '切换会话后它会消失，实例也就失去了停止入口。请先在会话里发送任意消息（或切换到已有会话），再执行 /dsh-web。';

const OPEN_TIMEOUT_MS = 3000;

/**
 * Resolve one optional service from a Cordis context without failing when the
 * composition omits it.
 * @param {object} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {any} the service, or undefined.
 */
function service(ctx, name) {
	return ctx.get(name) ?? ctx[name];
}

/**
 * Open a URL through Electron's own shell when this Host runs inside Electron.
 *
 * The Desktop edition's Host process *is* the Electron main process, so
 * `shell.openExternal` is the sanctioned way to hand a URL to the OS. Spawning
 * `cmd.exe start` from a console-less GUI process proved unreliable there: the
 * spawn succeeds while no browser ever appears. Under `ELECTRON_RUN_AS_NODE`
 * (the `dsh web` CLI) the `electron` module resolves to a path string instead of
 * the API, so this returns `undefined` and the platform launchers below run.
 *
 * @param {string} url - absolute http(s) URL to open.
 * @returns {Promise<boolean|undefined>} true when opened, undefined when unavailable.
 */
async function openViaElectron(url) {
	if (process.versions.electron === undefined) return undefined;
	try {
		const electron = await import('electron');
		const shell = electron?.shell ?? electron?.default?.shell;
		if (typeof shell?.openExternal !== 'function') return undefined;
		await shell.openExternal(url);
		return true;
	} catch {
		return undefined;
	}
}

/**
 * Per-platform launcher argv candidates, most reliable first.
 *
 * On Windows `rundll32 url.dll,FileProtocolHandler` goes through the shell's URL
 * handler without needing a console; `start` is the console-bound fallback.
 *
 * @param {string} platform - `process.platform`.
 * @param {string} url - absolute http(s) URL to open.
 * @returns {ReadonlyArray<{command: string, args: string[]}>} launchers to try in order.
 */
function launcherCandidates(platform, url) {
	if (platform === 'win32') {
		return [
			{ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
			// `start` takes its own (empty) title argument, and quoting keeps a `&`
			// or space in the URL inside cmd.exe's single remaining argument.
			{ command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${url.replaceAll('"', '%22')}"`] },
		];
	}
	if (platform === 'darwin') return [{ command: 'open', args: [url] }];
	return [{ command: 'xdg-open', args: [url] }];
}

/**
 * Start one detached launcher and report whether it looks like it worked.
 *
 * `spawn` alone is not proof: a launcher that exits immediately with a failure
 * code (no handler, bad URL) never opened anything, so an early non-zero exit
 * settles as failure. A launcher still running after the settle window counts as
 * opened, as does one that exited 0.
 *
 * @param {{command: string, args: string[]}} launcher - launcher argv.
 * @param {object} options - spawn override, timeout, and settle window.
 * @returns {Promise<boolean>} whether the launcher started without failing.
 */
function launchDetached(launcher, options) {
	const spawnProcess = options.spawn ?? spawn;
	const timeoutMs = options.timeoutMs ?? OPEN_TIMEOUT_MS;
	const settleMs = options.settleMs ?? 600;

	return new Promise((resolve) => {
		let settled = false;
		const settle = (opened) => {
			if (settled) return;
			settled = true;
			resolve(opened);
		};

		let child;
		try {
			child = spawnProcess(launcher.command, launcher.args, { detached: true, stdio: 'ignore', windowsHide: true });
		} catch {
			settle(false);
			return;
		}

		const timeout = setTimeout(() => settle(true), timeoutMs);
		child?.once?.('spawn', () => {
			clearTimeout(timeout);
			const settleTimer = setTimeout(() => settle(true), settleMs);
			child?.once?.('exit', (code) => {
				clearTimeout(settleTimer);
				settle(code === 0 || code === null);
			});
		});
		child?.once?.('error', () => {
			clearTimeout(timeout);
			settle(false);
		});
		try {
			child?.unref?.();
		} catch {
			// An unref failure never changes whether the launcher started.
		}
	});
}

/**
 * Open one URL in the operating system's default handler.
 *
 * Order: Electron `shell.openExternal` inside the Desktop app, then this
 * platform's launcher candidates. Failure of one candidate falls through to the
 * next; the result is false only when nothing plausible started. A headless host
 * has no browser, and the human still gets the URL in the command result.
 *
 * @param {string} url - absolute http(s) URL to open.
 * @param {object} [options] - test seams.
 * @param {string} [options.platform] - `process.platform` override.
 * @param {Function} [options.spawn] - `node:child_process` spawn override.
 * @param {Promise<boolean|undefined>} [options.electronOpen] - Electron shell override.
 * @param {number} [options.timeoutMs] - per-launcher start deadline.
 * @param {number} [options.settleMs] - window after spawn before assuming success.
 * @returns {Promise<boolean>} whether the URL was handed to a browser.
 */
export async function openUrlInBrowser(url, options = {}) {
	const platform = options.platform ?? process.platform;
	const electronOpen = options.electronOpen ?? openViaElectron;

	try {
		const opened = await electronOpen(url);
		if (opened === true) return true;
	} catch {
		// Fall through to the platform launchers.
	}

	for (const launcher of launcherCandidates(platform, url)) {
		if (await launchDetached(launcher, options)) return true;
	}
	return false;
}

/**
 * Read the invoking session id from a command invocation.
 *
 * `@deepseek-ai/dsh-commands` freezes `{ ...agent, ... }` into the invocation, so
 * `invocation.agent` is the live Agent and `agent.id` is its session id — the
 * registry's ownership key (`ctx.jobs` keys owners by that string, never by the
 * Agent object). An instance only ever exists owned, so an invocation dispatched
 * outside a session yields no id here and the start is refused instead of
 * producing an unowned host.
 *
 * @param {{agent?: {id?: unknown}}} [invocation] - the UI's command invocation.
 * @returns {string|undefined} the session id, or undefined when unknown.
 */
function sessionIdOf(invocation) {
	const id = invocation?.agent?.id;
	return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Whether the invoking Session is still blank — no turn has started in it yet.
 *
 * DSH filters blank Sessions out of the session list, so a person who opens a
 * brand-new Session, runs `/dsh-web` without saying anything, then switches away
 * loses that Session's header control. An owned job would then have no reachable
 * roster and could not be stopped; the command refuses such an invocation
 * outright, because there is no unowned fallback to hide behind.
 *
 * @param {object} ctx - plugin context carrying `sessionProjections`.
 * @param {object} [agent] - the receiving Agent (its `session` is inspected).
 * @returns {boolean} true when no turn has started; false when unknown or the service is absent.
 */
export function sessionIsBlank(ctx, agent) {
	const projections = ctx?.get?.('sessionProjections') ?? ctx?.sessionProjections;
	const session = agent?.session;
	if (projections === undefined || typeof projections.stateOf !== 'function' || session === undefined || session === null) {
		return false;
	}
	try {
		const boundary = projections.stateOf(session, 'turnBoundary');
		return boundary === undefined || (boundary.openTurnStartSeq === null && boundary.lastTurn === 0);
	} catch {
		return false;
	}
}

/**
 * Execute one `/dsh-web` invocation.
 *
 * One verb, automatic branch: with no instance for the session it starts one;
 * with a running instance it restarts it in place and keeps the temporary
 * `DSH_HOME`, so anything installed into that throwaway profile survives. The
 * explicit `restart` argument still forces the restart branch (the deprecated
 * `/web-gui restart` spelling routes here too).
 *
 * @param {{ensure: Function, ensureOrRestart: Function, restart: Function, stop: Function}} gui - the isolated-instance manager.
 * @param {{rawInput?: string, agent?: {id?: unknown}}} [invocation] - the UI's command invocation.
 * @param {object} [options] - plugin config plus test seams.
 * @param {boolean} [options.openBrowser] - open the default browser (default true).
 * @param {boolean} [options.shareApiKey] - share this process's DEEPSEEK_API_KEY (default true; `false` opts out).
 * @param {Function} [options.open] - URL opener override.
 * @returns {Promise<{kind: 'success'|'error', text: string}>} the command outcome.
 */
export async function executeWebGuiCommand(gui, invocation, options = {}) {
	const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
	const action = rawInput === '' ? 'auto' : rawInput === 'restart' ? 'restart' : undefined;
	if (action === undefined) return { kind: 'error', text: USAGE };
	const shareApiKey = options.shareApiKey !== false;
	const blank = typeof options.isBlank === 'function' && options.isBlank(invocation?.agent) === true;
	if (blank) return { kind: 'error', text: BLANK_SESSION_MESSAGE };

	let outcome;
	try {
		outcome = action === 'restart'
			? await gui.restart(sessionIdOf(invocation))
			: await gui.ensureOrRestart(sessionIdOf(invocation));
	} catch (error) {
		const detail = error instanceof Error ? error.message : '';
		const verb = action === 'restart' ? '重启临时鉴权 DSH Web 失败' : '启动临时鉴权 DSH Web 失败';
		return { kind: 'error', text: detail === '' ? `${verb}。` : `${verb}：${detail}` };
	}

	let opened = false;
	if (options.openBrowser !== false) {
		const open = typeof options.open === 'function' ? options.open : openUrlInBrowser;
		try {
			opened = (await open(outcome.url)) === true;
		} catch {
			opened = false;
		}
	}

	const restartState = outcome.portKept === true
		? '已原地重启临时鉴权 DSH Web：临时 DSH_HOME 保留（已安装的插件与配置都还在）；端口沿用原值，已打开的旧页面刷新即可继续用，旧链接里的 token 已失效、新客户端请用下面这个新链接。'
		: '已原地重启临时鉴权 DSH Web：临时 DSH_HOME 保留（已安装的插件与配置都还在）；端口已更换（原端口不可用），已有页面需要改用新链接。';
	const state = action === 'restart' || outcome.restarted === true
		? restartState
		: outcome.reused
			? '复用了已启动的临时实例（独立端口 + 临时数据目录，已与当前会话隔离）。'
			: '已启动临时鉴权 DSH Web：独立进程、独立端口、临时数据目录，不共享当前 DSH_HOME；它会一直运行到你在会话顶部的后台任务列表里停止它。';
	const credentials = outcome.sharedKey === true
		? '已把当前桌面端的 DEEPSEEK_API_KEY 复制给隔离实例，可直接对话（消耗同一账号配额）。'
		: shareApiKey
			? '没找到可共享的 DEEPSEEK_API_KEY，隔离实例需要单独登录或添加 Key。'
			: '隔离实例未共享凭据（shareApiKey 已关闭），需要时在里面登录。';
	return {
		kind: 'success',
		text: [
			outcome.url,
			state,
			credentials,
			opened ? '已在默认浏览器打开。' : '未能自动打开浏览器，请复制上面的链接手动打开。',
			'它是本会话的后台任务：桌面端会话顶部会一直显示“运行中”，可以在那里停止；归档这个会话时若它仍在运行，DSH 会提示并可在确认时一并停止。',
		].join('\n'),
	};
}

/**
 * Register the human `/dsh-web` command when this composition has a command
 * registry; a registry-less profile keeps the agent tool untouched. There is
 * deliberately no stop command: the instance is a tracked background job, so
 * the session's task roster is the one place to see and stop it.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [options] - plugin config, the instance manager, and test seams.
 * @returns {boolean} whether the command was registered.
 */
export function registerWebGuiCommand(ctx, options = {}) {
	const commands = service(ctx, 'commands');
	if (commands === undefined || typeof commands.register !== 'function') return false;
	const gui = options.gui;
	if (gui === undefined || typeof gui.ensure !== 'function' || typeof gui.stop !== 'function') return false;

	const isBlank = typeof options.isBlank === 'function'
		? options.isBlank
		: (agent) => sessionIsBlank(ctx, agent);
	const handler = (invocation) => executeWebGuiCommand(gui, invocation, { ...options, isBlank });
	commands.register({
		name: COMMAND_NAME,
		description: COMMAND_DESCRIPTION,
		handler,
	});
	// The previous spelling stays executable for one release; the browser half
	// hides its palette row so only the new name is offered.
	commands.register({
		name: COMMAND_ALIAS,
		description: COMMAND_DESCRIPTION,
		handler,
	});
	return true;
}

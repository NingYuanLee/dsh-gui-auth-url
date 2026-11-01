/**
 * @module dsh-gui-auth-url/isolated-tool
 *
 * Agent-facing half of the temporary authenticated DSH Web: start (or reuse)
 * the throwaway host the human `/dsh-web` command owns, restart it in place,
 * ask what is running, and stop it — all against the same per-session manager.
 *
 * Why these tools instead of widening `gui_auth_url`: the two answer different
 * questions. `gui_auth_url` is read-only and returns *this* process's own
 * authenticated address — the very GUI the person is looking at. An agent that
 * exercises a new plugin, a new transcript surface, or a fresh profile must not
 * do it in the session the person is using, so it needs a separate host with its
 * own `DSH_HOME`, port, and lifecycle. `./isolated-web.js` already provides that
 * for the command; this module adapts the same manager to tool results.
 *
 * The rules are the command's rules: the instance is a tracked background job
 * owned by the calling session, the `shareApiKey` config decides whether this
 * process's `DEEPSEEK_API_KEY` rides along, and the browser is never opened — the
 * agent drives the URL through its own client. There is no unowned fallback: a
 * call with no calling agent is refused, exactly like the command refuses a
 * blank Session.
 *
 * `install` closes the loop the plugin exists for: put the plugin under test into
 * the disposable profile with the package manager, restart the host so it loads,
 * hand back the URL, and stop when done. `host`/`public_url`/`tls_*`/
 * `trusted_host` widen reachability, so they are refused unless the profile sets
 * `allowPublic: true`; `install` is refused when the profile sets
 * `allowInstall: false`.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Tool name exposed to the model. */
export const TOOL_NAME = 'dsh_web_start';

/** Tool name of the in-place restart. */
export const RESTART_TOOL_NAME = 'dsh_web_restart';

/** Tool name of the stop action. */
export const STOP_TOOL_NAME = 'dsh_web_stop';

/** Tool name of the status query. */
export const STATUS_TOOL_NAME = 'dsh_web_status';

/** Launch options shared by the start and the restart tool. */
const LAUNCH_PARAMETERS = {
	install: {
		type: 'array',
		items: { type: 'string' },
		description: '包 spec 列表（如 `github:you/dsh-plugin`、`file:../my-plugin`），先装进实例的临时 DSH_HOME 再启动宿主。'
			+ '仅接受不含空格与 shell 元字符的 spec；该步骤会运行第三方包的生命周期脚本（以当前用户身份执行代码），'
			+ 'profile 里 `allowInstall: false` 可整体关闭。',
	},
	host: {
		type: 'string',
		description: '绑定地址，必须是本机某个具体 IPv4/IPv6 字面量（`dsh web` 拒绝 0.0.0.0 通配）。仅 `allowPublic: true` 时允许。',
	},
	public_url: {
		type: 'string',
		description: '广告根 URL（绝对 http/https、不含账号密码），用于反向代理或 https 入口。仅 `allowPublic: true` 时允许。',
	},
	tls_cert: {
		type: 'string',
		description: 'PEM 服务器证书链路径；必须与 `tls_key` 同时提供。仅 `allowPublic: true` 时允许。',
	},
	tls_key: {
		type: 'string',
		description: '未加密 PEM 私钥路径；必须与 `tls_cert` 同时提供。仅 `allowPublic: true` 时允许。',
	},
	trusted_host: {
		type: 'array',
		items: { type: 'string' },
		description: '/api 浏览器信任栅栏额外接受的 authority（host 或 host:port，可多个）。仅 `allowPublic: true` 时允许。',
	},
};

/** The start tool also accepts a listen port; a restart keeps the previous one. */
const START_PARAMETERS = {
	...LAUNCH_PARAMETERS,
	port: {
		type: 'integer',
		description: '监听端口 0–65535；0 或缺省表示由系统分配。',
	},
};

/** The restart tool takes no port: it reuses the preserved instance port when it can. */
const RESTART_PARAMETERS = { ...LAUNCH_PARAMETERS };

/** Discovery text of the in-place restart. */
export const RESTART_DESCRIPTION = '原地重启本会话的临时鉴权 DSH Web：保留临时 DSH_HOME（已安装的插件、配置、登录态都还在），并尽量沿用原端口——浏览器里的登录 Cookie 绑定 host:port、签名密钥就在这个临时目录里，所以已打开的页面刷新即可继续用；只有原端口被占用时才换端口。返回新的 url 与 jobId。'
	+ '典型用途：在临时实例里装了需要重启才生效的插件之后，用本工具让它生效——不要停掉实例，停掉会删除临时目录、插件也没了。'
	+ '可选参数与 dsh_web_start 一致（install 会再装一次包，host/public_url/tls_cert/tls_key/trusted_host 仅在 allowPublic 开启时可用），未传的参数沿用实例保留下来的配置。'
	+ '旧 url 里的 token 每次都会变。当前会话没有运行中的实例时直接报错，请先调用 dsh_web_start。';

/** Discovery text; also states the split against `gui_auth_url`. */
export const DESCRIPTION = '启动或复用一个临时鉴权 DSH Web 实例（独立进程 + 临时 DSH_HOME + 随机端口），返回可直接交给浏览器或 HTTP 客户端的 url。'
	+ '用途：在不影响当前桌面端正在使用的会话的前提下，验证新插件、新界面或新 profile。'
	+ '与 gui_auth_url 的区别：gui_auth_url 返回当前进程自己的地址（就是你正在看的那个 GUI）；本工具另起一个临时鉴权 DSH Web 实例，两者不是同一个地址。'
	+ '可选参数：install（先装包再启动，用于验证插件）、host/public_url/tls_cert/tls_key/trusted_host（局域网或 https 入口，需 profile 开启 allowPublic）、port。'
	+ '实例按调用方会话绑定为后台任务并返回 jobId：用 dsh_web_stop 停止（会删除临时 DSH_HOME），或用 job_kill 结束；同一会话内重复调用复用该实例，带 install/暴露参数时改为原地重启；不同会话各有独立实例，互不停止。'
	+ '绑不上会话时直接失败，不会留下无主实例。'
	+ '默认把本进程的 DEEPSEEK_API_KEY 通过环境变量复制给实例（Cordis 配置 shareApiKey: false 可关闭），不写临时目录。'
	+ '本工具不会打开浏览器。';

/** Discovery text of the stop action. */
export const STOP_DESCRIPTION = '停止本会话的临时鉴权 DSH Web（dsh_web_start 起的那个），并删除它的临时 DSH_HOME。'
	+ '停止后该目录里安装过的插件与实例内的会话都不再保留；下次 dsh_web_start 会得到一个全新的空 profile。'
	+ '不需要停止时（例如只是想让它继续跑）不要调用。当前会话没有实例时返回 stopped=false，不报错。';

/** Discovery text of the status query. */
export const STATUS_DESCRIPTION = '查询本会话的临时鉴权 DSH Web 状态：是否在运行、url、jobId、临时 DSH_HOME 路径、启动时间、端口、是否装了插件、是否暴露到非回环地址，以及全局运行数/上限。'
	+ '在 dsh_web_start 之前用它确认是否已有可复用实例；在 dsh_web_stop 之前用它确认实例确实在运行。只读，无副作用。';

/**
 * Resolve the calling session id from a tool execution context.
 *
 * `ToolRunContext.agent` is the live Agent the call runs for, and `agent.id` is
 * the session id the job registry keys ownership by — never the Agent object.
 *
 * @param {{agent?: {id?: unknown}}} [exec] - tool execution context.
 * @returns {string|undefined} the session id, or undefined when unknown.
 */
export function sessionIdOf(exec) {
	const id = exec?.agent?.id;
	return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Where to stop this instance.
 * @param {object} value - the tool result value.
 * @returns {string} one sentence of stop advice.
 */
function stopAdvice(value) {
	if (typeof value.jobId === 'string' && value.jobId !== '') {
		return `它是本会话的后台任务（jobId=${value.jobId}）：用 dsh_web_stop 停止并清理临时 DSH_HOME，或到「后台任务」列表取消。`;
	}
	return '注意：没能把实例登记成后台任务，请在会话的「后台任务」列表里手动停止它。';
}

/**
 * The exposure sentence shared by the start and restart renderings.
 * @param {object} value - the tool result value.
 * @returns {string} one sentence, or an empty string when not exposed.
 */
function exposureAdvice(value) {
	return value.exposed === true
		? '该实例绑定/广告到非回环地址：同一网络内的其他机器可以打开这个 url，url 里的 token 就是登录凭据，用完请停止实例。'
		: '';
}

/**
 * The install sentence shared by the start and restart renderings.
 * @param {object} value - the tool result value.
 * @param {string} emptyText - sentence when no specs were involved.
 * @returns {string} one sentence.
 */
function installAdvice(value, emptyText) {
	const specs = Array.isArray(value.install) ? value.install : [];
	if (specs.length === 0) return emptyText;
	return `已把 ${String(specs.length)} 个包装进临时 DSH_HOME：${specs.join('、')}（安装步骤会运行包的生命周期脚本）。`;
}

/** Canonical start value plus its model-facing rendering. */
const isolatedOutput = {
	schema: { type: 'json' },
	render: (_args, value) => [{
		type: 'text',
		text: [
			String(value.url),
			value.reused === true
				? '复用了已启动的临时鉴权 DSH Web（独立进程 + 临时 DSH_HOME + 随机端口，与当前桌面端会话隔离）。'
				: '已启动临时鉴权 DSH Web：独立进程、临时 DSH_HOME、随机端口，不共享当前桌面端的会话与登录态。',
			installAdvice(value, '未安装额外包。'),
			exposureAdvice(value),
			value.sharedKey === true
				? '已把当前进程的 DEEPSEEK_API_KEY 复制给临时实例（仅环境变量，不写临时目录；消耗同一账号配额）。'
				: '临时实例未共享凭据（shareApiKey 关闭或没找到 key），需要时在里面登录。',
			stopAdvice(value),
			'用 url 直接驱动浏览器或 HTTP 客户端；它不是 gui_auth_url 返回的当前进程地址。',
		].filter((line) => line !== '').join('\n'),
	}],
};

/**
 * Start or reuse the isolated host on behalf of one tool call.
 *
 * The manager refuses an execution with no calling agent, so an agent-less call
 * surfaces as a tool error instead of leaving a host nobody owns. Launch options
 * are validated (and refused) by the manager, so an option this profile does not
 * allow fails before any process is spawned.
 *
 * @param {{ensure: Function}} gui - the isolated-instance manager.
 * @param {object} [exec] - tool execution context carrying `agent`.
 * @param {object} [args] - the model's launch options (see `launch-options.js`).
 * @returns {Promise<object>} the tool result value.
 */
export async function executeIsolatedStart(gui, exec, args = {}) {
	const outcome = await gui.ensure(sessionIdOf(exec), args);
	return {
		url: outcome.url,
		...(typeof outcome.jobId === 'string' && outcome.jobId !== '' ? { jobId: outcome.jobId } : {}),
		reused: outcome.reused,
		sharedKey: outcome.sharedKey,
		...(outcome.exposed === true ? { exposed: true } : {}),
		...(Array.isArray(outcome.install) && outcome.install.length > 0 ? { install: outcome.install } : {}),
	};
}

/**
 * Restart the isolated host on behalf of one tool call, keeping its home.
 * @param {{restart: Function}} gui - the isolated-instance manager.
 * @param {object} [exec] - tool execution context carrying `agent`.
 * @param {object} [args] - launch options to replace the preserved ones.
 * @returns {Promise<object>} the tool result value.
 */
export async function executeIsolatedRestart(gui, exec, args = {}) {
	const outcome = await gui.restart(sessionIdOf(exec), args);
	return {
		url: outcome.url,
		...(typeof outcome.jobId === 'string' && outcome.jobId !== '' ? { jobId: outcome.jobId } : {}),
		restarted: true,
		portKept: outcome.portKept === true,
		sharedKey: outcome.sharedKey,
		...(outcome.exposed === true ? { exposed: true } : {}),
		...(Array.isArray(outcome.install) && outcome.install.length > 0 ? { install: outcome.install } : {}),
	};
}

/**
 * Stop this session's isolated host and let the manager remove its home.
 * @param {{stop: Function}} gui - the isolated-instance manager.
 * @param {object} [exec] - tool execution context carrying `agent`.
 * @returns {Promise<{stopped: boolean}>} whether an instance was stopped.
 */
export async function executeIsolatedStop(gui, exec) {
	return { stopped: (await gui.stop(sessionIdOf(exec))) === true };
}

/**
 * Report this session's isolated host and the global running count.
 * @param {{status: Function}} gui - the isolated-instance manager.
 * @param {object} [exec] - tool execution context carrying `agent`.
 * @returns {Promise<object>} the status facts.
 */
export async function executeIsolatedStatus(gui, exec) {
	return gui.status(sessionIdOf(exec));
}

/** Canonical restart value plus its model-facing rendering. */
const restartOutput = {
	schema: { type: 'json' },
	render: (_args, value) => [{
		type: 'text',
		text: [
			String(value.url),
			value.portKept === true
				? '已原地重启临时鉴权 DSH Web：临时 DSH_HOME 保留（插件与配置都在），端口沿用原值——已打开的旧页面刷新即可继续，旧链接里的 token 已失效。'
				: '已原地重启临时鉴权 DSH Web：临时 DSH_HOME 保留（插件与配置都在），但端口已更换（原端口不可用），已有页面需要改用新 url。',
			installAdvice(value, '实例里已安装的插件保留在临时 DSH_HOME 中。'),
			exposureAdvice(value),
			stopAdvice(value),
			'用新的 url 继续驱动浏览器或 HTTP 客户端。',
		].filter((line) => line !== '').join('\n'),
	}],
};

/** Canonical stop value plus its model-facing rendering. */
const stopOutput = {
	schema: { type: 'json' },
	render: (_args, value) => [{
		type: 'text',
		text: value.stopped === true
			? '已停止本会话的临时鉴权 DSH Web，临时 DSH_HOME 已删除（里面装过的插件与实例内会话都不再保留）。'
			: '本会话没有运行中的临时鉴权 DSH Web，无需停止。',
	}],
};

/** Canonical status value plus its model-facing rendering. */
const statusOutput = {
	schema: { type: 'json' },
	render: (_args, value) => {
		const count = `全局运行中 ${String(value.runningCount ?? 0)}/${String(value.maxInstances ?? '?')} 个实例。`;
		if (value.running !== true) {
			return [{
				type: 'text',
				text: `本会话当前没有运行中的临时鉴权 DSH Web。${count}`
					+ (value.jobStatus === 'killed' || value.jobStatus === 'completed' || value.jobStatus === 'failed'
						? `（上一个实例已结束：${String(value.jobStatus)}）`
						: ''),
			}];
		}
		const startedAt = Number.isFinite(value.startedAt) ? new Date(value.startedAt).toISOString() : '未知';
		const specs = Array.isArray(value.install) ? value.install : [];
		return [{
			type: 'text',
			text: [
				String(value.url),
				`jobId=${String(value.jobId ?? '未知')}，状态 ${String(value.jobStatus ?? '未知')}，端口 ${String(value.port ?? '未知')}，启动于 ${startedAt}。`,
				`临时 DSH_HOME：${String(value.home ?? '未知')}`,
				specs.length === 0 ? '该实例没有通过 install 安装过包。' : `通过 install 安装过：${specs.join('、')}。`,
				value.exposed === true ? '该实例暴露在非回环地址上，同一网络内可访问。' : '该实例只在本机回环地址上可达。',
				value.sharedKey === true ? '已共享当前进程的 DEEPSEEK_API_KEY。' : '未共享凭据。',
				count,
				'停止用 dsh_web_stop（会删除临时 DSH_HOME），或到「后台任务」列表取消。',
			].join('\n'),
		}];
	},
};

/**
 * Register the in-place restart tool beside the start tool.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [options] - the isolated-instance manager.
 * @param {{restart: Function}} [options.gui] - manager created by `createIsolatedWebGui`.
 * @returns {boolean} whether the tool was registered.
 */
export function registerIsolatedRestartTool(ctx, options = {}) {
	const gui = options.gui;
	if (gui === undefined || typeof gui.restart !== 'function') return false;
	if (typeof ctx?.tools?.register !== 'function') return false;
	ctx.tools.register(defineTool({
		name: RESTART_TOOL_NAME,
		description: RESTART_DESCRIPTION,
		parameters: RESTART_PARAMETERS,
		output: restartOutput,
		execute(args, exec) {
			return executeIsolatedRestart(gui, exec, args);
		},
	}));
	return true;
}

/**
 * Register the isolated-start tool when this composition has both a tool
 * registry and the isolated-instance manager; a manager-less composition keeps
 * `gui_auth_url` alone.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [options] - the isolated-instance manager.
 * @param {{ensure: Function}} [options.gui] - manager created by `createIsolatedWebGui`.
 * @returns {boolean} whether the tool was registered.
 */
export function registerIsolatedStartTool(ctx, options = {}) {
	const gui = options.gui;
	if (gui === undefined || typeof gui.ensure !== 'function') return false;
	if (typeof ctx?.tools?.register !== 'function') return false;
	ctx.tools.register(defineTool({
		name: TOOL_NAME,
		description: DESCRIPTION,
		parameters: START_PARAMETERS,
		output: isolatedOutput,
		execute(args, exec) {
			return executeIsolatedStart(gui, exec, args);
		},
	}));
	return true;
}

/**
 * Register the stop action when the manager can stop an owned instance.
 *
 * The human command deliberately has no stop verb — the session's background-task
 * roster is where a person stops one. An agent has no roster to click, so it gets
 * an explicit action that goes through the same manager and therefore the same
 * ownership fence and home cleanup.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [options] - the isolated-instance manager.
 * @param {{stop: Function}} [options.gui] - manager created by `createIsolatedWebGui`.
 * @returns {boolean} whether the tool was registered.
 */
export function registerIsolatedStopTool(ctx, options = {}) {
	const gui = options.gui;
	if (gui === undefined || typeof gui.stop !== 'function') return false;
	if (typeof ctx?.tools?.register !== 'function') return false;
	ctx.tools.register(defineTool({
		name: STOP_TOOL_NAME,
		description: STOP_DESCRIPTION,
		parameters: {},
		output: stopOutput,
		execute(_args, exec) {
			return executeIsolatedStop(gui, exec);
		},
	}));
	return true;
}

/**
 * Register the read-only status query when the manager can report one.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [options] - the isolated-instance manager.
 * @param {{status: Function}} [options.gui] - manager created by `createIsolatedWebGui`.
 * @returns {boolean} whether the tool was registered.
 */
export function registerIsolatedStatusTool(ctx, options = {}) {
	const gui = options.gui;
	if (gui === undefined || typeof gui.status !== 'function') return false;
	if (typeof ctx?.tools?.register !== 'function') return false;
	ctx.tools.register(defineTool({
		name: STATUS_TOOL_NAME,
		description: STATUS_DESCRIPTION,
		parameters: {},
		output: statusOutput,
		execute(_args, exec) {
			return executeIsolatedStatus(gui, exec);
		},
	}));
	return true;
}

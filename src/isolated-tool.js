/**
 * @module dsh-gui-auth-url/isolated-tool
 *
 * Agent half of the temporary authenticated DSH Web: start (or reuse) the
 * throwaway host the human `/dsh-web` command owns, and hand the agent its URL
 * instead of opening a browser.
 *
 * Why a second tool instead of widening `gui_auth_url`: the two answer different
 * questions. `gui_auth_url` is read-only and returns *this* process's own
 * authenticated address — the very GUI the person is looking at. An agent that
 * exercises a new plugin, a new transcript surface, or a fresh profile must not
 * do it in the session the person is using, so it needs a separate host with its
 * own `DSH_HOME`, port, and lifecycle. `./isolated-web.js` already provides that
 * for the command; this module adapts the same manager to a tool result.
 *
 * The rules are the command's rules: the instance is a tracked background job
 * owned by the calling session, the `shareApiKey` config decides whether this
 * process's `DEEPSEEK_API_KEY` rides along, and the browser is never opened — the
 * agent drives the URL through its own client. There is no unowned fallback: a
 * call with no calling agent is refused, exactly like the command refuses a
 * blank Session.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Tool name exposed to the model. */
export const TOOL_NAME = 'dsh_web_start';

/** Tool name of the in-place restart. */
export const RESTART_TOOL_NAME = 'dsh_web_restart';

/** Discovery text of the in-place restart. */
export const RESTART_DESCRIPTION = '原地重启本会话的临时鉴权 DSH Web：保留临时 DSH_HOME（已安装的插件、配置、登录态都还在），并尽量沿用原端口——浏览器里的登录 Cookie 绑定 host:port、签名密钥就在这个临时目录里，所以已打开的页面刷新即可继续用；只有原端口被占用时才换端口。返回新的 url 与 jobId。'
	+ '典型用途：在临时实例里装了需要重启才生效的插件之后，用本工具让它生效——不要停掉实例，停掉会删除临时目录、插件也没了。'
	+ '旧 url 里的 token 每次都会变。当前会话没有运行中的实例时直接报错，请先调用 dsh_web_start。';

/** Discovery text; also states the split against `gui_auth_url`. */
export const DESCRIPTION = '启动或复用一个临时鉴权 DSH Web 实例（独立进程 + 临时 DSH_HOME + 随机端口），返回可直接交给浏览器或 HTTP 客户端的 url。'
	+ '用途：在不影响当前桌面端正在使用的会话的前提下，验证新插件、新界面或新 profile。'
	+ '与 gui_auth_url 的区别：gui_auth_url 返回当前进程自己的地址（就是你正在看的那个 GUI）；本工具另起一个临时鉴权 DSH Web 实例，两者不是同一个地址。'
	+ '实例按调用方会话绑定为后台任务并返回 jobId：到「后台任务」列表取消，或调用 job_kill 结束；同一会话内重复调用复用该实例，不同会话各有独立实例，互不停止。'
	+ '绑不上会话时直接失败，不会留下无主实例。'
	+ '默认把本进程的 DEEPSEEK_API_KEY 通过环境变量复制给实例（Cordis 配置 shareApiKey: false 可关闭），不写临时目录。'
	+ '本工具不会打开浏览器。';

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
		return `它是本会话的后台任务（jobId=${value.jobId}）：到「后台任务」列表取消，或调用 job_kill 结束。`;
	}
	return '注意：没能把实例登记成后台任务，请在会话的「后台任务」列表里手动停止它。';
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
			value.sharedKey === true
				? '已把当前进程的 DEEPSEEK_API_KEY 复制给临时实例（仅环境变量，不写临时目录；消耗同一账号配额）。'
				: '临时实例未共享凭据（shareApiKey 关闭或没找到 key），需要时在里面登录。',
			stopAdvice(value),
			'用 url 直接驱动浏览器或 HTTP 客户端；它不是 gui_auth_url 返回的当前进程地址。',
		].join('\n'),
	}],
};

/**
 * Start or reuse the isolated host on behalf of one tool call.
 *
 * The manager refuses an execution with no calling agent, so an agent-less call
 * surfaces as a tool error instead of leaving a host nobody owns.
 *
 * @param {{ensure: Function}} gui - the isolated-instance manager.
 * @param {object} [exec] - tool execution context carrying `agent`.
 * @returns {Promise<{url: string, jobId?: string, reused: boolean, sharedKey: boolean}>} the tool result value.
 */
export async function executeIsolatedStart(gui, exec) {
	const outcome = await gui.ensure(sessionIdOf(exec));
	return {
		url: outcome.url,
		...(typeof outcome.jobId === 'string' && outcome.jobId !== '' ? { jobId: outcome.jobId } : {}),
		reused: outcome.reused,
		sharedKey: outcome.sharedKey,
	};
}

/**
 * Restart the isolated host on behalf of one tool call, keeping its home.
 * @param {{restart: Function}} gui - the isolated-instance manager.
 * @param {object} [exec] - tool execution context carrying `agent`.
 * @returns {Promise<{url: string, jobId?: string, restarted: true, portKept: boolean, sharedKey: boolean}>} the tool result value.
 */
export async function executeIsolatedRestart(gui, exec) {
	const outcome = await gui.restart(sessionIdOf(exec));
	return {
		url: outcome.url,
		...(typeof outcome.jobId === 'string' && outcome.jobId !== '' ? { jobId: outcome.jobId } : {}),
		restarted: true,
		portKept: outcome.portKept === true,
		sharedKey: outcome.sharedKey,
	};
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
			stopAdvice(value),
			'用新的 url 继续驱动浏览器或 HTTP 客户端。',
		].join('\n'),
	}],
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
		parameters: {},
		output: restartOutput,
		execute(_args, exec) {
			return executeIsolatedRestart(gui, exec);
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
		parameters: {},
		output: isolatedOutput,
		execute(_args, exec) {
			return executeIsolatedStart(gui, exec);
		},
	}));
	return true;
}

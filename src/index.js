/**
 * @module dsh-gui-auth-url
 *
 * Expose the running Web GUI's authenticated address to the agent and to the
 * person using that GUI.
 *
 * Why this exists: `dsh --profile web` mints a random launch token per process
 * and prints it once. The Desktop edition starts its own Host process and never
 * prints it, so browser automation opening `http://127.0.0.1:<port>/` fails with
 * `401 dsh web authentication required`. This plugin asks the *official* Host
 * API (`connection.authenticatedUrl`) for the same URL `dsh web` prints, then
 * hands it to the model as a tool result and to a human as the `/gui-auth`
 * slash command (which also opens the default browser).
 *
 * It deliberately never reads the cookie-signing secret in
 * `$DSH_HOME/.credentials.yaml` and never mints a cookie itself: the returned
 * address is a genuine first-party session, bound to this process. A non-loopback
 * address is refused unless this plugin's config sets `allowPublic` to true.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveGuiAuthUrl } from './auth-url.js';
import { resolveDeepSeekApiKey } from './api-key.js';
import { COMMAND_NAME, registerWebGuiCommand } from './command.js';
import {
	RESTART_TOOL_NAME,
	STOP_TOOL_NAME,
	STATUS_TOOL_NAME,
	TOOL_NAME as ISOLATED_TOOL_NAME,
	registerIsolatedRestartTool,
	registerIsolatedStartTool,
	registerIsolatedStatusTool,
	registerIsolatedStopTool,
} from './isolated-tool.js';
import { createIsolatedWebGui, sweepStaleHomes } from './isolated-web.js';

export const name = 'gui-auth-url';

/** Services required before the tool can mint anything. */
export const inject = ['connection', 'tools'];

/**
 * Cordis config. `allowPublic: true` may attach the launch token to a
 * non-loopback advertised host, and it is also the gate for the isolated
 * instance's exposure options (`host`, `public_url`, `tls_*`, `trusted_host`);
 * `openBrowser: false` makes the human command report the URL without opening a
 * browser; `shareApiKey: false` stops the default behaviour of passing this
 * process's DeepSeek API key to the isolated Web GUI (on by default, so the
 * isolated window can talk to the model without a separate login); `maxInstances`
 * caps how many isolated hosts may run at once across sessions (default 4),
 * because every host is a whole `dsh web` process; `allowInstall: false` refuses
 * the `install` option, so no request can make this profile run a package
 * manager (installing a plugin runs its lifecycle scripts as this user).
 * Absent config stays closed, browser-opening, key-sharing, install-allowing and
 * capped at 4.
 */
export const Config = {
	'~standard': {
		version: 1,
		vendor: 'dsh-gui-auth-url',
		validate(value) {
			const defaults = {
				allowPublic: false,
				openBrowser: true,
				shareApiKey: true,
				maxInstances: 4,
				allowInstall: true,
			};
			if (value === undefined || value === null) return { value: defaults };
			if (typeof value !== 'object' || Array.isArray(value)) {
				return { issues: [{ message: 'config must be an object' }] };
			}
			const keys = Object.keys(value);
			for (const key of keys) {
				if (key !== 'allowPublic' && key !== 'openBrowser' && key !== 'shareApiKey'
					&& key !== 'maxInstances' && key !== 'allowInstall') {
					return { issues: [{ message: `unknown config key ${key}`, path: [key] }] };
				}
			}
			if ('allowPublic' in value && typeof value.allowPublic !== 'boolean') {
				return { issues: [{ message: 'allowPublic must be a boolean', path: ['allowPublic'] }] };
			}
			if ('openBrowser' in value && typeof value.openBrowser !== 'boolean') {
				return { issues: [{ message: 'openBrowser must be a boolean', path: ['openBrowser'] }] };
			}
			if ('shareApiKey' in value && typeof value.shareApiKey !== 'boolean') {
				return { issues: [{ message: 'shareApiKey must be a boolean', path: ['shareApiKey'] }] };
			}
			if ('allowInstall' in value && typeof value.allowInstall !== 'boolean') {
				return { issues: [{ message: 'allowInstall must be a boolean', path: ['allowInstall'] }] };
			}
			if ('maxInstances' in value
				&& (!Number.isSafeInteger(value.maxInstances) || value.maxInstances < 1 || value.maxInstances > 32)) {
				return { issues: [{ message: 'maxInstances must be an integer between 1 and 32', path: ['maxInstances'] }] };
			}
			return {
				value: {
					allowPublic: value.allowPublic === true,
					openBrowser: value.openBrowser !== false,
					shareApiKey: value.shareApiKey !== false,
					maxInstances: value.maxInstances ?? 4,
					allowInstall: value.allowInstall !== false,
				},
			};
		},
	},
};

const jsonOutput = {
	schema: { type: 'json' },
	render: (_args, value) => [{ type: 'text', text: String(value.url) }],
};

const DESCRIPTION = '返回当前正在运行的 DeepSeek Harness Web GUI 的合法带 token 地址（第一方会话，非伪造）'
	+ '。当需要打开/刷新/截图/验证本机 GUI、而直接访问 http://127.0.0.1:<port>/ 得到 '
	+ '`401 dsh web authentication required` 时调用本工具，然后把返回的 url 交给浏览器或 HTTP 客户端。'
	+ '无参数。工具结果就是可直接打开的 url 文本；程序化调用另可读到 origin、protocol、host、port、secure 字段。'
	+ '人类用户可在 GUI 输入框里输入 `/' + COMMAND_NAME + '`：插件会按会话起一个临时鉴权 DSH Web（临时 DSH_HOME + 独立端口），没有就启动、有就原地重启，并用默认浏览器打开它。'
	+ '该临时实例登记为当前会话的后台任务：桌面端会话顶部会一直显示“运行中”并可随时停止，归档会话时会提示它仍在运行；'
	+ '并默认把当前桌面端的 DEEPSEEK_API_KEY 复制给实例（配置 shareApiKey: false 可关闭），因此隔离窗口可直接对话。'
	+ '注意：本工具返回的是当前进程这一份地址；`/' + COMMAND_NAME + '` 与 `' + ISOLATED_TOOL_NAME
	+ '` 返回的是另起的临时鉴权 DSH Web 地址，两者不同（需要在不影响当前会话的前提下验证新东西时用它们）。'
	+ '注意：url 内含本进程的临时启动令牌，只在当前进程存活期间有效；不要写入日志或提交到仓库。'
	+ '在临时实例里装了需要重启才生效的插件后，用 `/' + COMMAND_NAME + ' restart`（或 `' + RESTART_TOOL_NAME + '`）原地重启：临时 DSH_HOME 保留，插件与配置不会丢；要「装包 + 重启」一步到位，用 `' + ISOLATED_TOOL_NAME + '` 的 install 参数。'
	+ '临时实例另有 `' + STOP_TOOL_NAME + '`（停止并删除临时 DSH_HOME）与 `' + STATUS_TOOL_NAME + '`（只读查看是否在运行）两个工具。'
	+ '成功调用仍会把该令牌写入会话，并随后续模型请求送出。'
	+ '非回环地址默认拒绝；只有本插件 Cordis 配置显式 allowPublic 为 true 时才返回。';

/**
 * Mount the read-only agent tool, and — when the composition has a job registry
 * — the temporary authenticated DSH Web: the human `/dsh-web` command plus the
 * agent's `dsh_web_start` / `dsh_web_restart` / `dsh_web_stop` /
 * `dsh_web_status` tools, which share one instance manager.
 * @param {object} ctx - Host plugin context.
 * @param {{allowPublic?: boolean, openBrowser?: boolean, shareApiKey?: boolean, maxInstances?: number, allowInstall?: boolean}} [config] - validated plugin config.
 */
export function apply(ctx, config = {}) {
	const allowPublic = config?.allowPublic === true;
	const openBrowser = config?.openBrowser !== false;
	const shareApiKey = config?.shareApiKey !== false;
	const maxInstances = config?.maxInstances;
	const allowInstall = config?.allowInstall !== false;
	ctx.tools.register(defineTool({
		name: 'gui_auth_url',
		description: DESCRIPTION,
		parameters: {},
		output: jsonOutput,
		execute() {
			return resolveGuiAuthUrl(ctx, { allowPublic });
		},
	}));

	const jobs = ctx.get?.('jobs') ?? ctx.jobs;
	if (jobs === undefined || typeof jobs.start !== 'function') return;
	if (typeof ctx.effect === 'function') {
		// Reclaim homes and hosts left behind by a crashed or reloaded Desktop process.
		void sweepStaleHomes().catch(() => {});
	}
	const gui = createIsolatedWebGui({
		jobs,
		allowPublic,
		allowInstall,
		...(shareApiKey ? { resolveApiKey: () => resolveDeepSeekApiKey(ctx) } : {}),
		...(maxInstances === undefined ? {} : { maxInstances }),
	});
	registerWebGuiCommand(ctx, { openBrowser, shareApiKey, gui });
	registerIsolatedStartTool(ctx, { gui });
	registerIsolatedRestartTool(ctx, { gui });
	registerIsolatedStopTool(ctx, { gui });
	registerIsolatedStatusTool(ctx, { gui });
	if (typeof ctx.effect === 'function') {
		ctx.effect(() => () => {
			void gui.dispose();
		}, 'gui-auth-url isolated Web GUI lifecycle');
	}
}

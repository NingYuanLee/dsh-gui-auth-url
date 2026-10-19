/**
 * @module dsh-gui-auth-url
 *
 * Expose the running Web GUI's authenticated address to the agent.
 *
 * Why this exists: `dsh --profile web` mints a random launch token per process
 * and prints it once. The Desktop edition starts its own Host process and never
 * prints it, so browser automation opening `http://127.0.0.1:<port>/` fails with
 * `401 dsh web authentication required`. This plugin asks the *official* Host
 * API (`connection.authenticatedUrl`) for the same URL `dsh web` prints, then
 * hands it to the model as a tool result.
 *
 * It deliberately never reads the cookie-signing secret in
 * `$DSH_HOME/.credentials.yaml` and never mints a cookie itself: the returned
 * address is a genuine first-party session, bound to this process. A non-loopback
 * address is refused unless this plugin's config sets `allowPublic` to true.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveGuiAuthUrl } from './auth-url.js';

export const name = 'gui-auth-url';

/** Services required before the tool can mint anything. */
export const inject = ['connection', 'tools'];

/**
 * Cordis config. Only `allowPublic: true` may attach the launch token to a
 * non-loopback advertised host. Absent config and every other value stay closed.
 */
export const Config = {
	'~standard': {
		version: 1,
		vendor: 'dsh-gui-auth-url',
		validate(value) {
			if (value === undefined || value === null) return { value: { allowPublic: false } };
			if (typeof value !== 'object' || Array.isArray(value)) {
				return { issues: [{ message: 'config must be an object' }] };
			}
			const keys = Object.keys(value);
			for (const key of keys) {
				if (key !== 'allowPublic') {
					return { issues: [{ message: `unknown config key ${key}`, path: [key] }] };
				}
			}
			if ('allowPublic' in value && typeof value.allowPublic !== 'boolean') {
				return { issues: [{ message: 'allowPublic must be a boolean', path: ['allowPublic'] }] };
			}
			return { value: { allowPublic: value.allowPublic === true } };
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
	+ '注意：url 内含本进程的临时启动令牌，只在当前进程存活期间有效；不要写入日志或提交到仓库。'
	+ '成功调用仍会把该令牌写入会话，并随后续模型请求送出。'
	+ '非回环地址默认拒绝；只有本插件 Cordis 配置显式 allowPublic 为 true 时才返回。';

/**
 * Mount the GUI auth URL tool.
 * @param {object} ctx - Host plugin context.
 * @param {{allowPublic?: boolean}} [config] - validated plugin config.
 */
export function apply(ctx, config = {}) {
	const allowPublic = config?.allowPublic === true;
	ctx.tools.register(defineTool({
		name: 'gui_auth_url',
		description: DESCRIPTION,
		parameters: {},
		output: jsonOutput,
		execute() {
			return resolveGuiAuthUrl(ctx, { allowPublic });
		},
	}));
}

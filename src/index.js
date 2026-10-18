/**
 * @module dsh-gui-session
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
 * address is a genuine first-party session, bound to this process.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveGuiSession } from './session.js';

export const name = 'gui-session';

/** Services required before the tool can mint anything. */
export const inject = ['connection', 'tools'];

const jsonOutput = {
	schema: { type: 'json' },
	render: (_args, value) => [{ type: 'text', text: String(value.url) }],
};

const DESCRIPTION = '返回当前正在运行的 DeepSeek Harness Web GUI 的合法带 token 地址（第一方会话，非伪造）'
	+ '。当需要打开/刷新/截图/验证本机 GUI、而直接访问 http://127.0.0.1:<port>/ 得到 '
	+ '`401 dsh web authentication required` 时调用本工具，然后把返回的 url 交给浏览器或 HTTP 客户端。'
	+ '无参数。工具结果就是可直接打开的 url 文本；程序化调用另可读到 origin、protocol、host、port、secure 字段。'
	+ '注意：url 内含本进程的临时启动令牌，只在当前进程存活期间有效；不要写入日志或提交到仓库。';

/**
 * Mount the GUI-session tool.
 * @param {object} ctx - Host plugin context.
 */
export function apply(ctx) {
	ctx.tools.register(defineTool({
		name: 'gui_session_url',
		description: DESCRIPTION,
		parameters: {},
		output: jsonOutput,
		execute() {
			return resolveGuiSession(ctx);
		},
	}));
}

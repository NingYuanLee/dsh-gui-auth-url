/**
 * @module dsh-gui-auth-url/api-key
 *
 * Share the launching process's DeepSeek API key with a spawned isolated host.
 *
 * The credentials seam (`ctx.credentials`, backed by
 * `$DSH_HOME/.credentials.yaml`) layers the inherited process environment above
 * its managed store. That ordering is what makes sharing possible without
 * copying anything: the spawned `dsh web` gets the value as `DEEPSEEK_API_KEY`
 * in its environment, which wins over the fresh, empty credentials document in
 * its temporary `DSH_HOME`. Nothing is written to the child's disk, and no other
 * credential (in particular the Web GUI's cookie-signing secret) is read.
 *
 * The value never leaves this module except as the child's environment entry:
 * it is not logged, not persisted, and not included in any error text.
 */

/** The credential reference the bundled DeepSeek provider defaults to. */
export const API_KEY_REF = 'DEEPSEEK_API_KEY';

/**
 * Resolve the DeepSeek API key this process can offer a child host.
 *
 * Preference: the inherited environment first (the child uses the same layering
 * rule), then the credentials seam. Any failure is treated as "no key": sharing
 * is a convenience, never a reason to refuse starting the isolated host.
 *
 * @param {object} ctx - plugin context that may carry `ctx.credentials`.
 * @param {NodeJS.ProcessEnv} [env] - environment override for tests.
 * @returns {Promise<string|undefined>} the key, or undefined when none is available.
 */
export async function resolveDeepSeekApiKey(ctx, env = process.env) {
	const inherited = env?.[API_KEY_REF];
	if (typeof inherited === 'string' && inherited !== '') return inherited;

	const credentials = ctx?.get?.('credentials') ?? ctx?.credentials;
	if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined;
	try {
		const resolved = await credentials.resolve(API_KEY_REF);
		const value = resolved?.value;
		if (typeof value === 'string' && value !== '') return value;
	} catch {
		// Unconfigured is the common case; a provider failure must not block startup.
	}
	return undefined;
}

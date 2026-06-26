// @ts-check
import http from "node:http";
import https from "node:https";

// Shared keep-alive agents for all upstream calls. Without these, every request
// to api.z.ai / api.anthropic.com / openrouter.ai opens a fresh TCP + TLS
// handshake and closes it — ~100-300ms of handshake per request, paid again on
// every parallel subagent call. Reusing pooled connections removes that cost.
// maxSockets caps concurrent upstream connections so heavy fan-out across
// sessions can't exhaust file descriptors; maxFreeSockets bounds the idle pool.
const KEEP_ALIVE = { keepAlive: true, maxSockets: 128, maxFreeSockets: 16 };

export const httpAgent = new http.Agent(KEEP_ALIVE);
export const httpsAgent = new https.Agent(KEEP_ALIVE);

/**
 * Select the shared agent matching a request's protocol module. Callers compute
 * `proto = url.protocol === "https:" ? https : http`; module identity is stable
 * (Node caches module instances), so identity comparison is safe.
 * @param {typeof http | typeof https} proto
 * @returns {http.Agent}
 */
export function pickAgent(proto) {
	return proto === https ? httpsAgent : httpAgent;
}

/**
 * Socket-inactivity timeout (ms) for upstream requests. Generous by default: a
 * cold, large-context (1M) LLM call can take tens of seconds to first byte, and
 * this is an inactivity timeout (it resets as bytes flow), so streaming token
 * gaps are fine. Read at call time so an env change takes effect without
 * re-import. PROXY_UPSTREAM_TIMEOUT_MS overrides; non-numeric / non-positive
 * values fall back to the default.
 * @returns {number}
 */
export function upstreamTimeoutMs() {
	const v = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : 120000;
}

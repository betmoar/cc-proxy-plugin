#!/usr/bin/env node
// Re-run the vendor measurements that source comments assert.
//
// A comment claiming "Z.ai accepts the suffixed id" is a claim about someone
// else's server. The hermetic suite cannot check it — and that is exactly how
// issue #34 shipped a design decision resting on an unverified premise, which
// a probe later showed was false. This script is the falsifier: it re-issues
// the requests and prints what the vendors do TODAY, so a claim can be
// re-confirmed on demand instead of trusted indefinitely.
//
// MANUAL, never in CI, never in `pnpm check`: it needs real keys and spends
// real quota (a handful of 4-token turns). Run it when touching the routing or
// forwarding path, or when a comment's date looks stale.
//
//   node scripts/probe-vendors.mjs            # all cases
//   node scripts/probe-vendors.mjs --json     # machine-readable
//
// EXIT CODES, because "verified nothing" must not look like "all verified":
//   0  every case ran and matched
//   1  a vendor DISAGREES with a source comment — the signal this tool exists for
//   2  inconclusive: something could not be reached (offline, DNS, timeout)
//   3  nothing ran at all (no keys) — no claim was checked
//
// A single 0/1 split was the first shape, and the review that caught it was
// right: `--json` exists precisely because something else will eventually read
// this, and an exit code that cannot separate "checked and fine" from "checked
// nothing" is one `&& echo verified` away from becoming the silent green this
// whole file was written to prevent.

import { loadEnv } from "../src/env.js";
import { DEFAULT_QWEN_MODELS } from "../src/models.js";
import { ROUTES } from "../src/routes.js";
import { isDirectRun } from "./direct-run.js";

// loadEnv() runs in the CLI guard at the bottom, NOT at import time: the test
// that imports `judge` must not spend real quota or capture the pre-~/.env
// environment mid-import (the scripts/quota.js coupling).

const JSON_OUT = process.argv.includes("--json");

// LM Studio's server is per-user infrastructure, so its URL comes from the same
// env var the provider gates on — a literal here would probe a machine the
// operator does not have.
//
// A case stores this as the FUNCTION, never its result: `CASES` is built at
// module-evaluation time, which is now BEFORE loadEnv() (it moved to the CLI
// guard at the bottom so an importing test spends no quota). Calling it in the
// literal captured the pre-~/.env environment and baked `url: ""` into both LM
// Studio cases — fetch then failed with "Failed to parse URL from", which reads
// like a URL bug and is really an ordering bug. Wrapping the read in a function
// is only half the fix; the CALL has to move too. Resolved in probe(), which
// runs from main(), after loadEnv().
function lmstudioMessagesUrl() {
	const base = process.env.LMSTUDIO_BASE_URL;
	if (!base) return "";
	return `${base.replace(/\/+$/, "")}/v1/messages`;
}

// A case's `url` is either a literal or a thunk deferring an env read.
function caseUrl(c) {
	return typeof c.url === "function" ? c.url() : c.url;
}

/**
 * Each case pins what a source comment claims, WHERE it claims it, and what the
 * vendor must answer for that claim to still hold. `expect` is the status; the
 * optional `bodyMatch` pins the vendor's own error vocabulary, because a 400
 * for the right reason and a 400 for the wrong reason are different facts.
 */
// The suffix these cases probe is the one `stripVariantSuffix` removes — this
// script and the router must agree on what "the bare id" means, or the probe
// would be measuring a spelling the proxy never sends. Executed by
// test/doc-examples.test.js, and deliberately living OUTSIDE src/: it is the
// checked-in proof that the collector walks more than one directory.
//
// @doctest stripVariantSuffix("glm-5.2[1m]") -> "glm-5.2"
const CASES = [
	{
		name: "z.ai accepts a bare id",
		claim: "src/router.js — 'POST api.z.ai … model=glm-5.2 → 200'",
		url: "https://api.z.ai/api/anthropic/v1/messages",
		auth: (k) => ({ "x-api-key": k }),
		key: "GLM_API_KEY",
		model: "glm-5.2",
		expect: 200,
	},
	{
		name: "z.ai REJECTS the [1m] suffix",
		claim: "src/router.js — the whole reason the strip reaches upstream",
		url: "https://api.z.ai/api/anthropic/v1/messages",
		auth: (k) => ({ "x-api-key": k }),
		key: "GLM_API_KEY",
		model: "glm-5.2[1m]",
		expect: 400,
		bodyMatch: /1214|does not exist/i,
	},
	{
		name: "z.ai rejects a suffixed NEW model the same way (glm-5.3)",
		claim: "test/router.test.js — 'not one model's quirk'",
		url: "https://api.z.ai/api/anthropic/v1/messages",
		auth: (k) => ({ "x-api-key": k }),
		key: "GLM_API_KEY",
		model: "glm-5.3[1m]",
		expect: 400,
		bodyMatch: /1214|does not exist/i,
	},
	{
		name: "qwen plan accepts a bare id",
		claim: "src/router.js — 'POST token-plan… model=glm-5.2 → 200'",
		url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages",
		auth: (k) => ({ authorization: `Bearer ${k}` }),
		key: "DASHSCOPE_API_KEY",
		model: "glm-5.2",
		expect: 200,
	},
	{
		name: "qwen plan REJECTS the [1m] suffix",
		claim: "src/router.js — 'InvalidParameter: Model not exist.'",
		url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages",
		auth: (k) => ({ authorization: `Bearer ${k}` }),
		key: "DASHSCOPE_API_KEY",
		model: "glm-5.2[1m]",
		expect: 400,
		bodyMatch: /not exist/i,
	},
	{
		// The measurement the media tunnel rests on. If this stops answering 200,
		// `mediaBaseUrl` is routing at a dead endpoint and the entry in
		// UNUSABLE_MODALITY's comment saying image "works, elsewhere" is a lie.
		name: "qwen plan serves images on the multimodal-generation path",
		claim: "src/providers.js mediaBaseUrl + src/models.js UNUSABLE_MODALITY — issue #40",
		url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
		auth: (k) => ({ authorization: `Bearer ${k}` }),
		key: "DASHSCOPE_API_KEY",
		model: "wan2.7-image",
		// Not the Anthropic Messages shape the default body uses — that is the
		// whole point of the separate endpoint (the skin 400s this model).
		body: (model) => ({
			model,
			input: { messages: [{ role: "user", content: [{ text: "a red cube on white" }] }] },
			parameters: { size: "1024*1024" },
		}),
		expect: 200,
		// Pin the payload shape too: a 200 whose body no longer carries an image URL
		// would be a different fact from the one the comment states.
		bodyMatch: /"image"\s*:\s*"https?:/,
	},
	{
		// A NEGATIVE claim, and the reason to keep re-measuring it: the comment in
		// UNUSABLE_MODALITY says plan TTS is broken vendor-side. If Alibaba fixes
		// it, this case flips to FAIL and the comment gets revisited — which is the
		// only way a "does not work" claim ever gets re-examined.
		name: "qwen plan TTS still fails vendor-side (411)",
		claim: "src/models.js UNUSABLE_MODALITY — audio stays usable:false",
		transport: "ws",
		url: "wss://token-plan.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference",
		auth: (k) => ({ authorization: `Bearer ${k}` }),
		key: "DASHSCOPE_API_KEY",
		model: "qwen-audio-3.0-tts-plus",
		// The task is ACCEPTED (task-started arrives, so model + auth are valid) and
		// then fails in the engine — status records which of the two happened.
		expect: "task-failed",
		bodyMatch: /Engine error \[411\]/,
	},
	{
		// LM Studio's Anthropic skin accepts a Messages body. Keyed on
		// LMSTUDIO_BASE_URL (the same gate the provider uses — the key is optional,
		// server auth is often off, and the dummy token below is what LM Studio's
		// own Claude Code example uses). Skipped when no host is configured, so it
		// never invents reachability for a server this machine does not have.
		// The URL derives from the env var, NOT a literal: the host is per-user
		// infrastructure (a LAN hostname vs an IP vs localhost), so a hardcoded one
		// probes a machine the operator does not have.
		name: "lmstudio answers the Anthropic Messages skin",
		claim: "src/providers.js lmstudio entry — /v1/messages is the one documented endpoint",
		url: lmstudioMessagesUrl,
		// The TOKEN must mirror the provider's own choice (LMSTUDIO_API_KEY, or
		// the docs' dummy) — NOT the base URL. `key` here is the GATE (the env
		// var whose absence skips the case), and LMSTUDIO_BASE_URL being a URL
		// made `Bearer http://…` the header on the first cut — wrong on any
		// auth-ON server, and invisible there because auth-off servers ignore
		// every Bearer value alike (found in the PR #49 adversarial review).
		auth: () => ({
			authorization: `Bearer ${process.env.LMSTUDIO_API_KEY || "lmstudio"}`,
		}),
		key: "LMSTUDIO_BASE_URL",
		model: "openai/gpt-oss-20b",
		// Any loaded model answers; the dummy key satisfies auth-on servers and is
		// ignored by auth-off ones (both measured 2026-08-28 against a live server).
		expect: 200,
		bodyMatch: /"stop_reason"/,
	},
	{
		// The make-or-break claim for a CC session: the skin must return a real
		// `tool_use` block. LM Studio's Anthropic-compat page DOES document the
		// request side (a `get_weather` cURL with `input_schema` and
		// `tool_choice`), but shows no sample RESPONSE — it defers to Anthropic's
		// docs for the shape — so what is unverified without this probe is
		// whether the server actually emits `tool_use`, not whether tools are
		// supported at all. Measured working 2026-08-28; if LM Studio regresses,
		// this fails and the provider needs a re-think. (An earlier version of
		// this comment claimed the docs were silent on tool use. They are not —
		// that was asserted without reading them.)
		name: "lmstudio serves tool_use over the Anthropic skin",
		claim: "src/providers.js lmstudio entry — CC sessions need tool_use",
		url: lmstudioMessagesUrl,
		// Same token rule as the case above: provider's choice, not the URL.
		auth: () => ({
			authorization: `Bearer ${process.env.LMSTUDIO_API_KEY || "lmstudio"}`,
		}),
		key: "LMSTUDIO_BASE_URL",
		model: "openai/gpt-oss-20b",
		body: (model) => ({
			model,
			// 64 was measured too tight: the model sometimes spends the budget on
			// reasoning and returns stop_reason:max_tokens with EMPTY content — a
			// 200 that carries no tool_use, indistinguishable in the gate from a
			// compat regression. 300 held across repeated manual runs; the
			// re-runnable guarantee is this case itself (expect 200 + a
			// `tool_use` bodyMatch), not that recollection.
			max_tokens: 300,
			messages: [{ role: "user", content: "Use the get_weather tool for Tokyo, then stop." }],
			tools: [
				{
					name: "get_weather",
					description: "Get current weather",
					input_schema: {
						type: "object",
						properties: { location: { type: "string" } },
						required: ["location"],
					},
				},
			],
		}),
		expect: 200,
		bodyMatch: /"type"\s*:\s*"tool_use"/,
	},
	{
		// NEGATIVE claim behind the Gemini line (the `google/*` block of MODEL_GRADES in src/models.js, issue #42):
		// Google publishes no Anthropic Messages endpoint, so Gemini reaches this
		// proxy ONLY through OpenRouter. Probed by hand 2026-08-23 (four paths,
		// valid key, all 404 while :generateContent returned 200 the same minute)
		// and again keyless 2026-08-31 (all 404 with an EMPTY body, text/html,
		// while the real API path answers a structured JSON error — that shape
		// split is what tells a routing miss from a live-but-refusing endpoint).
		// One case per candidate path, so a Google change on ANY of them shows
		// its name in the FAIL line instead of averaging into a set.
		name: "google: /v1/messages is a routing miss (404, empty body)",
		claim: "src/models.js MODEL_GRADES — no native Google Anthropic leg (invariant 5)",
		url: "https://generativelanguage.googleapis.com/v1/messages",
		auth: () => ({}),
		key: "GEMINI_API_KEY",
		model: "gemini-2.0-flash",
		expect: 404,
		bodyMatch: /^$/,
	},
	{
		name: "google: /v1beta/messages is a routing miss",
		claim: "src/models.js MODEL_GRADES — no native Google Anthropic leg (invariant 5)",
		url: "https://generativelanguage.googleapis.com/v1beta/messages",
		auth: () => ({}),
		key: "GEMINI_API_KEY",
		model: "gemini-2.0-flash",
		expect: 404,
		bodyMatch: /^$/,
	},
	{
		name: "google: /v1beta/anthropic/v1/messages is a routing miss",
		claim: "src/models.js MODEL_GRADES — no native Google Anthropic leg (invariant 5)",
		url: "https://generativelanguage.googleapis.com/v1beta/anthropic/v1/messages",
		auth: () => ({}),
		key: "GEMINI_API_KEY",
		model: "gemini-2.0-flash",
		expect: 404,
		bodyMatch: /^$/,
	},
	{
		name: "google: /anthropic/v1/messages is a routing miss",
		claim: "src/models.js MODEL_GRADES — no native Google Anthropic leg (invariant 5)",
		url: "https://generativelanguage.googleapis.com/anthropic/v1/messages",
		auth: () => ({}),
		key: "GEMINI_API_KEY",
		model: "gemini-2.0-flash",
		expect: 404,
		bodyMatch: /^$/,
	},
	{
		// The POSITIVE control — the 404s above are only meaningful if the same
		// host can reach the real API. The routing-miss 404s are EMPTY with
		// text/html; the real path answers a structured JSON error instead, so
		// the split stays measurable even on a machine with no key at all
		// (measured 2026-08-31, keyless, empty body → 403 "Method doesn't allow
		// unregistered callers"; a Messages-shaped body → 400 "Unknown name
		// max_tokens"). Either proves the endpoint is live, so the case accepts
		// both via bodyMatch on the structured shape.
		name: "google: the generateContent path answers (positive control)",
		claim: "src/models.js MODEL_GRADES — the 404s are endpoint misses, not a dead host",
		url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
		auth: () => ({}),
		// No `key` gate: a structured error IS the expected live-host signature,
		// and a machine without a key still gets the control for free.
		expect: 400,
		// [\s\S] not dot: the body is pretty-printed across newlines and a bare
		// dot stops at the first one (measured — a `.` regex false-FAILs here).
		bodyMatch: /"error"[\s\S]*"message"/,
	},
];

// A non-2xx expectation without a bodyMatch passes on ANY error with that
// status — a reworded rate limit, an auth failure, a malformed-JSON complaint —
// so the probe would print OK while the claim it backs went untested. The
// convention was followed by every case here and enforced by nothing, which is
// one copy-paste from a real gap.
for (const c of CASES) {
	if (c.expect !== 200 && !c.bodyMatch) {
		console.error(
			`probe-vendors: case "${c.name}" expects ${c.expect} but carries no bodyMatch — a status alone cannot tell the vendor's real objection from an unrelated one.`,
		);
		process.exit(2);
	}
}

/**
 * A DashScope WebSocket task. Its own transport because the audio claim cannot
 * be measured over HTTP at all: every HTTP path 400s with `url error` (measured
 * 2026-08-25), so a probe restricted to fetch() could only record "unreachable"
 * — which reads as "we could not check" rather than the fact it is, that the
 * vendor accepts the task and its engine then fails. `status` is the terminal
 * event name, so a mismatch names which of the two the vendor did.
 */
function probeWebSocketTask(c, key) {
	return new Promise((done) => {
		let ws;
		try {
			ws = new WebSocket(caseUrl(c), { headers: c.auth(key) });
		} catch (err) {
			done({ error: err instanceof Error ? err.message : String(err), reason: "network" });
			return;
		}
		// FIRST RESULT WINS, explicitly. `finish` calls ws.close(), which fires
		// onclose, which calls finish again — so the close handler below would
		// otherwise overwrite a real `task-failed` verdict with "closed before a
		// task result". Promise `resolve` already ignores the second call, but that
		// is a subtlety one refactor away from being wrong, and getting it wrong
		// turns a measured vendor fact into a fake network error.
		let settled = false;
		const finish = (r) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {}
			done(r);
		};
		const timer = setTimeout(
			() => finish({ error: "timed out after 30s", reason: "network" }),
			30_000,
		);
		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					header: { action: "run-task", task_id: "probe", streaming: "out" },
					payload: {
						model: c.model,
						task_group: "audio",
						task: "tts",
						function: "SpeechSynthesizer",
						input: { text: "hello world" },
						parameters: { text_type: "PlainText", voice: "Cherry", format: "wav" },
					},
				}),
			);
		ws.onmessage = (e) => {
			if (typeof e.data !== "string") return; // audio frames, not events
			// PARSE INSIDE A try. This runs in an event-emitter callback, outside the
			// Promise executor's synchronous frame, so a throw here is an unhandled
			// exception that kills the whole probe RUN — and exits 1, which this
			// script's own exit-code contract already spends on "a vendor disagrees
			// with a source comment". A crash would be indistinguishable from the one
			// signal the file exists to deliver, and every case after this one would
			// go unreported while the summary line never printed. Distrusting the
			// vendor's frames is the entire premise; that has to include their shape.
			let msg;
			try {
				msg = JSON.parse(e.data);
			} catch {
				finish({
					error: `unparseable frame: ${e.data.slice(0, 120)}`,
					reason: "network",
				});
				return;
			}
			const event = msg?.header?.event;
			if (event !== "task-failed" && event !== "task-finished") return;
			const body = JSON.stringify(msg.header);
			finish({ status: event, body });
		};
		ws.onerror = (e) =>
			finish({ error: e?.message || String(e?.error || "websocket error"), reason: "network" });
		// A CLEAN CLOSE before any terminal event is its own fact. Without this the
		// promise sits until the 30s timeout and reports "timed out", which reads as
		// "the vendor never answered" when the vendor in fact answered immediately by
		// hanging up — a different thing to debug, and 30s slower to learn.
		ws.onclose = (e) =>
			finish({ error: `closed before a task result (code ${e.code})`, reason: "network" });
	});
}

/**
 * The verdict rule, factored out of `probe()` so the hermetic suite can pin it
 * without a network: a case passes when the status matches AND the body
 * pattern holds against the FULL body — never a truncated one (the 0.8.1
 * audit defect: truncating first made any pattern deeper than 300 chars a
 * false FAIL, exit 1).
 * @param {{status?: number, body?: string, expect: number|string, bodyMatch?: RegExp}} r
 * @returns {boolean}
 */
/**
 * What the printer shows for a result's body — capped for DISPLAY only; the
 * verdict already ran on the full text in `judge()`.
 *
 * Defensive on purpose: a result built by spreading `...c` can carry the case's
 * `body` TEMPLATE FUNCTION instead of a response string (two cases define one),
 * and calling `.replace` on it crashed the whole run with a TypeError that
 * exits 1 — indistinguishable from "a vendor disagrees", the one signal this
 * script exists to send. The catch blocks now clear `body`; this is the second
 * seatbelt, because the next case to define a `body` template will not
 * remember the first.
 * @param {{body?: unknown}} r
 * @returns {string}
 */
export function renderBody(r) {
	return typeof r.body === "string" ? r.body.replace(/\s+/g, " ").slice(0, 160) : "";
}

export function judge(r) {
	if (r.status !== r.expect) return false;
	if (!r.bodyMatch) return true;
	return r.bodyMatch.test(r.body ?? "");
}

async function probe(c) {
	// A case with no `key` gate runs unconditionally — the Google positive
	// control is measurable keyless BY DESIGN (its expected 403 IS the
	// live-host signature; issue #42). `key` stays undefined for it, which is
	// fine: auth is `() => ({})` there.
	const key = c.key ? process.env[c.key] : "keyless-by-design";
	if (c.key && !key) return { ...c, skipped: `${c.key} not set` };
	// Resolved HERE, not in the CASES literal: this runs after loadEnv().
	const url = caseUrl(c);
	if (c.transport === "ws") {
		const r = await probeWebSocketTask(c, key);
		if (r.reason === "network") return { ...c, ...r, body: undefined, ok: false };
		// judge() can throw on a malformed case (a bodyMatch that is not a RegExp),
		// and this branch sits OUTSIDE the try below — an unguarded throw here kills
		// the whole run mid-list, exactly what probeWebSocketTask's JSON.parse guard
		// exists to prevent. A bad case must fail itself, not the other thirteen.
		try {
			const ok = judge({ ...r, expect: c.expect, bodyMatch: c.bodyMatch });
			return { ...c, ...r, ok, reason: ok ? "match" : "mismatch" };
		} catch (err) {
			return {
				...c,
				...r,
				body: undefined,
				ok: false,
				reason: "network",
				error: `case is malformed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), 30_000);
	try {
		const res = await fetch(url, {
			method: "POST",
			signal: ctl.signal,
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				...c.auth(key),
			},
			// The Messages shape is the default because most cases probe the
			// Anthropic skin; a case carrying `body` speaks its endpoint's own schema.
			body: JSON.stringify(
				c.body
					? c.body(c.model)
					: {
							model: c.model,
							max_tokens: 4,
							messages: [{ role: "user", content: "hi" }],
						},
			),
		});
		// bodyMatch runs on the FULL body: truncating first would make a pattern
		// deeper than 300 chars a false FAIL (exit 1) — the audit defect (issue
		// #52). Only the PRINTED body is capped (display, not measurement).
		const body = await res.text();
		const ok = judge({ status: res.status, body, expect: c.expect, bodyMatch: c.bodyMatch });
		return { ...c, status: res.status, body, ok, reason: ok ? "match" : "mismatch" };
	} catch (err) {
		// NOT the same fact as a mismatch: the vendor said nothing, so the claim
		// is unverified rather than refuted. Callers separate these on `reason`;
		// the exit code separates them too (2 vs 1).
		//
		// `fetch` reports every transport failure as the bare string "fetch
		// failed" and puts the actual cause (ECONNREFUSED, ENOTFOUND, a TLS
		// complaint) in `err.cause` — dropping it leaves the operator of a MANUAL
		// diagnostic with nothing to act on.
		const detail = err instanceof Error ? (err.cause?.code ?? err.cause?.message) : null;
		const base = err instanceof Error ? err.message : String(err);
		const message = detail ? `${base}: ${detail}` : base;
		return {
			...c,
			// `...c` would otherwise leak a case's `body` TEMPLATE FUNCTION into the
			// result, and the printer calls `.replace` on a truthy body — a crash
			// that reads as exit 1, indistinguishable from a real vendor
			// disagreement. Two cases carry a body function.
			body: undefined,
			error: ctl.signal.aborted ? `timed out after 30s (${message})` : message,
			reason: "network",
			ok: false,
		};
	} finally {
		clearTimeout(timer);
	}
}

// ── CATALOG DRIFT (issue #37) ─────────────────────────────────────────────────
//
// The hand-owned tables (ROUTES, the static catalogs, CONTEXT_WINDOW) rot
// silently because no test can reach a vendor. This mode prints the
// DISAGREEMENTS between our tables and the vendors' own lists, so rot becomes
// a diff instead of a rediscovery. It never edits anything: backlog item 12
// says ROUTES records probed facts, and the human decides every row.
//
// THREE comparison classes, from the issue's evidence:
//   DRIFT  <id> requested -> <served> served (alias)   — POST /v1/messages
//          answers 200 but the body's model is a DIFFERENT id; the vendor
//          aliases. Per-backend by nature (Z.ai aliases glm-5* onto glm-5.3;
//          the Qwen plan serves REAL glm-5.2 and 400s glm-5.3) — the report
//          is per-provider, never global.
//   DRIFT  <id> routable, absent from ROUTES           — the provider's match()
//          predicate claims the id (so it routes) but ROUTES has no entry;
//          native-first/cheapest ranking then silently does nothing for it.
//   STALE  <endpoint> omits <id>                       — a VENDOR list is
//          behind our tables (the /api/anthropic/v1/models case: it did not
//          know glm-5.3 existed). Informational: the vendor's omission is
//          not our bug, but it IS the trap an auto-resolver would fall into,
//          and it flags which of our ids the skin's own discovery cannot see.
//
// The comparison itself is PURE (diffCatalogs) and exported for the hermetic
// suite; only the fetching is live.

/**
 * The bare glm- / qwen- / deepseek-prefixed ids our registry routes by SHAPE
 * provider (the match() predicates, restated for comparison — the predicates
 * live in providers.js and are not exported; restating the SHAPE here is the
 * drift check, and a divergence between this and providers.js is itself a
 * finding the hermetic suite catches by importing both).
 */
function shapeRoutedIds(providerId) {
	const ids = new Set();
	for (const id of Object.keys(ROUTES)) {
		if (ROUTES[id].some((r) => r.provider === providerId)) ids.add(id);
	}
	return ids;
}

/**
 * Pure comparison: our ROUTES-covered ids for a provider vs that vendor's
 * live list. Returns printable report lines.
 *
 * @param {string} providerId
 * @param {string[]} vendorListed - ids the vendor's own /models endpoint returns
 * @param {string} endpointLabel - for the STALE line
 * @returns {string[]}
 */
export function diffCatalogs(providerId, vendorListed, endpointLabel) {
	const lines = [];
	const ours = shapeRoutedIds(providerId);
	const theirs = new Set(vendorListed);
	// ROUTES records non-200 statuses DELIBERATELY (complete, not curated): the
	// qwen rows for glm-5.3 (400) and glm-5.1/glm-5 (403) document that the plan
	// REFUSES them — so the vendor list omitting those ids is agreement, not
	// staleness. A STALE line fires only for an id we say the provider SERVES
	// (status 200) that its own list cannot see.
	for (const id of ours) {
		const route = ROUTES[id]?.find((r) => r.provider === providerId);
		if (!theirs.has(id) && route?.status === 200) {
			lines.push(`STALE  ${endpointLabel} omits ${id} (ROUTES says ${providerId}:200)`);
		}
	}
	// Vendor lists ids our ROUTES does not cover at all. Not a defect — unlisted
	// ids still route via predicates, ROUTES only adds ranking — so these are
	// INFO, and only for ids the registry would even claim (the provider's
	// predicate shapes: glm-/qwen-prefixed bare ids for glm and qwen; slash ids
	// are OpenRouter's namespace; media/audio ids like wan2.7-image route by
	// PATH, never by shape, so they are not drift).
	for (const id of theirs) {
		if (ours.has(id) || id.includes("/")) continue;
		// qwen-audio-* / wan* are MEDIA namespaces served on the DashScope-native
		// tunnel (path-routed, issue #40), never through the Anthropic skin the
		// drift check compares against — excluded.
		const media = id.startsWith("qwen-audio") || id.startsWith("wan");
		const shapeMatched =
			providerId === "glm"
				? id.startsWith("glm-")
				: providerId === "qwen"
					? !media && (id.startsWith("qwen") || id.startsWith("deepseek-"))
					: false;
		if (shapeMatched) {
			lines.push(
				`INFO   ${id} listed by vendor, absent from ROUTES (routes by shape; no rank entry)`,
			);
		}
	}
	return lines;
}

/**
 * One alias check: POST a minimal message asking for `id` and report when the
 * 200 body names a DIFFERENT model. The response body is ground truth from the
 * request path itself — no catalog involved (issue #37's core finding).
 *
 * @param {{url: string, auth: (k: string) => Record<string, string>, key: string, id: string}} c
 * @returns {Promise<{requested: string, served?: string, status?: number, error?: string}>}
 */
async function probeServedModel(c) {
	const key = process.env[c.key];
	if (!key) return { requested: c.id, error: "no key" };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const res = await fetch(c.url, {
			method: "POST",
			headers: { "content-type": "application/json", ...c.auth(key) },
			body: JSON.stringify({
				model: c.id,
				max_tokens: 4,
				messages: [{ role: "user", content: "ok" }],
			}),
			signal: controller.signal,
		});
		let served;
		try {
			const body = await res.json();
			served = typeof body?.model === "string" ? body.model : undefined;
		} catch {
			served = undefined;
		}
		return { requested: c.id, served, status: res.status };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			requested: c.id,
			error: controller.signal.aborted ? `timed out (${message})` : message,
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Fetch a vendor /models list as bare id strings. */
async function fetchListedIds(url, headers) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const res = await fetch(url, { headers, signal: controller.signal });
		if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status}` };
		const body = await res.json();
		const ids = Array.isArray(body?.data)
			? body.data.map((m) => (typeof m?.id === "string" ? m.id : null)).filter(Boolean)
			: [];
		return { ids };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: controller.signal.aborted ? `timed out (${message})` : message };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The drift pass. Prints its lines and returns { drifts, ran } — drifts feed
 * the exit code (a drift is a disagreement with a source table, exit 1);
 * `ran` false means nothing could be reached (the pass was UNVERIFIED).
 */
async function driftReport() {
	const lines = [];
	let reached = 0;
	let attempted = 0;
	// ANY unreachable leg (list fetch OR alias check) — an UNREACHABLE line
	// printed next to exit 0 would break the contract ("0 = everything ran and
	// matched"), so the exit logic needs this, not just `reached`.
	let unreachableLegs = 0;
	driftReportRan = true;

	// GLM: the Anthropic-skin list (the one /v1/models republishes) — the
	// endpoint the issue measured omitting glm-5.3. SCOPE: only this list; the
	// issue's other two Z.ai endpoints (/api/paas/v4/models, /api/v1/models)
	// are not re-fetched — they disagree with each other, and the served-model
	// checks below are the ground truth that outranks all lists.
	if (process.env.GLM_API_KEY) {
		attempted++;
		const listed = await fetchListedIds("https://api.z.ai/api/anthropic/v1/models", {
			"x-api-key": process.env.GLM_API_KEY,
			"anthropic-version": "2023-06-01",
		});
		if (listed.error) {
			unreachableLegs++;
			lines.push(`UNREACHABLE  glm /api/anthropic/v1/models: ${listed.error}`);
		} else {
			reached++;
			lines.push(...diffCatalogs("glm", listed.ids, "glm /api/anthropic/v1/models"));
		}
		// Alias checks on the multi-version glm ids where the issue measured
		// aliasing (glm-5.2/5.1/5 -> glm-5.3 on Z.ai).
		for (const id of ["glm-5.2", "glm-5.1", "glm-5.3"]) {
			const served = await probeServedModel({
				url: "https://api.z.ai/api/anthropic/v1/messages",
				auth: (k) => ({ "x-api-key": k }),
				key: "GLM_API_KEY",
				id,
			});
			if (served.error) {
				unreachableLegs++;
				lines.push(`UNREACHABLE  glm ${id} served-model check: ${served.error}`);
			} else if (served.status === 200 && served.served && served.served !== served.requested) {
				lines.push(`DRIFT  ${served.requested} requested -> ${served.served} served (alias)`);
			} else if (served.status !== 200) {
				lines.push(
					`DRIFT  ${served.requested} expected 200 (ROUTES says glm:200) got ${served.status}`,
				);
			}
		}
	}

	// Qwen plan: the OpenAI-compatible list the live fetch uses.
	if (process.env.DASHSCOPE_API_KEY) {
		attempted++;
		const listed = await fetchListedIds(
			"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
			{ authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` },
		);
		if (listed.error) {
			unreachableLegs++;
			lines.push(`UNREACHABLE  qwen /compatible-mode/v1/models: ${listed.error}`);
		} else {
			reached++;
			lines.push(...diffCatalogs("qwen", listed.ids, "qwen /compatible-mode/v1/models"));
		}
	}

	// PROSE ONLY in non-JSON mode: --json stdout must stay machine-parseable
	// end to end, and a trailing "catalog drift:" block after the JSON blob
	// would kill every `| jq` downstream.
	if (!JSON_OUT) {
		if (lines.length) {
			console.log("\ncatalog drift:");
			for (const l of lines) console.log(`  ${l}`);
		} else if (attempted) {
			console.log("\ncatalog drift: none — every table agrees with every reachable vendor list");
		}
	}
	return {
		drifts: lines.filter((l) => l.startsWith("DRIFT")).length,
		lines,
		ran: reached > 0,
		unreachableLegs,
	};
}

async function main() {
	const results = [];
	for (const c of CASES) results.push(await probe(c));

	if (JSON_OUT) {
		console.log(JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
	} else {
		console.log(`vendor probe — ${new Date().toISOString()}\n`);
		for (const r of results) {
			if (r.skipped) {
				console.log(`SKIP  ${r.name}\n      ${r.skipped}\n`);
				continue;
			}
			const mark = r.ok ? "OK  " : "FAIL";
			console.log(`${mark}  ${r.name}`);
			console.log(`      model=${r.model} expected=${r.expect} got=${r.status ?? r.error}`);
			console.log(`      claim: ${r.claim}`);
			// A network failure has no body, and the old guard meant it printed LESS
			// detail than a mismatch — backwards, since it is the harder one to read.
			const shown = renderBody(r);
			if (!r.ok && shown) console.log(`      body: ${shown}`);
			if (!r.ok && r.error) console.log(`      unreachable: ${r.error}`);
			console.log();
		}
	}

	const ran = results.filter((r) => !r.skipped);
	const disagreed = ran.filter((r) => !r.ok && r.reason === "mismatch");
	const unreachable = ran.filter((r) => r.reason === "network");
	const skipped = results.length - ran.length;
	// Exit 3 means "no claim was checked", and it used to be `!ran.length`. The
	// keyless Google control (issue #42) runs on every machine BY DESIGN, so
	// ran.length is now permanently >= 1 and that test could never fire again: a
	// machine with zero keys scored exit 0, the silent green this file's header
	// says it exists to prevent. What actually distinguishes the two is whether
	// any KEYED case ran — the control proves the network works, not that a
	// vendor claim was measured.
	const ranKeyed = ran.filter((r) => r.key);

	if (!JSON_OUT) {
		const matched = ran.length - disagreed.length - unreachable.length;
		const parts = [`${matched}/${ran.length} matched`];
		if (unreachable.length) parts.push(`${unreachable.length} unreachable`);
		if (skipped) parts.push(`${skipped} skipped (no key)`);
		console.log(parts.join(", "));
		if (disagreed.length) {
			console.log("\nA vendor no longer behaves the way a source comment says it does.");
			console.log("Update the comment AND re-check the decision that rested on it.");
		}
		if (unreachable.length && !disagreed.length) {
			console.log("\nNothing was refuted — some cases could not be reached at all.");
			console.log("Treat this as UNVERIFIED, not as confirmation.");
		}
		if (!ranKeyed.length) {
			console.log("\nNo keys, so no vendor claim was checked. This is not a pass.");
		}
	}

	// Catalog drift (issue #37): runs in BOTH modes — drift is a disagreement
	// with a source table exactly like a case mismatch, so a plain run must not
	// hide drift. In --json mode the lines ride IN the payload (driftReport
	// prints nothing there), keeping stdout machine-parseable end to end.
	const drift = await driftReport();
	if (JSON_OUT && (drift.lines.length || !driftReportRan)) {
		// Re-emit the whole payload with drift appended — the JSON was already
		// printed above, so the cleanest machine contract is a SECOND object;
		// document it in the header instead of buffering a refactor.
		console.log(JSON.stringify({ drift, probedAt: new Date().toISOString() }, null, 2));
	}

	// Precedence: a real disagreement outranks unreachability, which outranks
	// having run nothing — the most actionable fact wins the exit code. Drift
	// lines sit at the same rank as case disagreements. Any unreachable LEG of
	// the drift pass (list fetch or alias check) sits with unreachable cases:
	// an UNREACHABLE line printed next to exit 0 would break "0 = everything
	// ran and matched".
	if (disagreed.length || drift.drifts) return 1;
	if (unreachable.length || drift.unreachableLegs > 0) return 2;
	if (!ranKeyed.length) return 3;
	return 0;
}

// Whether the drift pass had anything to attempt (keys present); module-level
// so main()'s --json branch can see it after the await. Set inside
// driftReport(). (Exit logic reads drift.unreachableLegs, not this.)
let driftReportRan = false;

// Only run the CLI when invoked directly, not when imported by tests — the
// same guard release-gate.mjs uses. Importing must be free of network calls
// AND of process.exit: test/probe-vendors.test.js imports `judge` and reads
// the CASES table statically, and an import-time probe run would both spend
// real quota and kill the test process with its own exit code.
// (Symlink note: the inline decoded comparison this replaced was still false
// through a symlinked checkout — import.meta.url is the realpath, argv[1] is
// not — so the probe silently did nothing there. isDirectRun realpaths both.)
if (isDirectRun(import.meta.url)) {
	loadEnv();
	process.exit(await main());
}

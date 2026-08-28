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

loadEnv();

const JSON_OUT = process.argv.includes("--json");

// LM Studio's server is per-user infrastructure, so its URL comes from the same
// env var the provider gates on — a literal here would probe a machine the
// operator does not have. Read inside the function, not at module top: an
// import hoisted above a caller's loadEnv() would capture the pre-~/.env
// environment (the scripts/quota.js coupling).
function lmstudioMessagesUrl() {
	const base = process.env.LMSTUDIO_BASE_URL;
	if (!base) return "";
	return `${base.replace(/\/+$/, "")}/v1/messages`;
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
		url: lmstudioMessagesUrl(),
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
		// The make-or-break claim: tool use over the SKIN, which LM Studio's docs
		// do not state (tools are documented only under its OpenAI compat). Claude
		// Code is useless without it. Measured working 2026-08-28; if LM Studio
		// regresses, this fails and the provider needs a re-think.
		name: "lmstudio serves tool_use over the Anthropic skin",
		claim: "src/providers.js lmstudio entry — CC sessions need tool_use",
		url: lmstudioMessagesUrl(),
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
			// compat regression. 300/5/5 gave 5/5 tool_use.
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
			ws = new WebSocket(c.url, { headers: c.auth(key) });
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

async function probe(c) {
	const key = process.env[c.key];
	if (!key) return { ...c, skipped: `${c.key} not set` };
	if (c.transport === "ws") {
		const r = await probeWebSocketTask(c, key);
		if (r.reason === "network") return { ...c, ...r, ok: false };
		const ok = r.status === c.expect && (!c.bodyMatch || c.bodyMatch.test(r.body));
		return { ...c, ...r, ok, reason: ok ? "match" : "mismatch" };
	}
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), 30_000);
	try {
		const res = await fetch(c.url, {
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
		const body = (await res.text()).slice(0, 300);
		const ok = res.status === c.expect && (!c.bodyMatch || c.bodyMatch.test(body));
		return { ...c, status: res.status, body, ok, reason: ok ? "match" : "mismatch" };
	} catch (err) {
		// NOT the same fact as a mismatch: the vendor said nothing, so the claim
		// is unverified rather than refuted. Callers separate these on `reason`;
		// the exit code separates them too (2 vs 1).
		const message = err instanceof Error ? err.message : String(err);
		return {
			...c,
			error: ctl.signal.aborted ? `timed out after 30s (${message})` : message,
			reason: "network",
			ok: false,
		};
	} finally {
		clearTimeout(timer);
	}
}

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
		if (!r.ok && r.body) console.log(`      body: ${r.body.replace(/\s+/g, " ").slice(0, 160)}`);
		if (!r.ok && r.error) console.log(`      unreachable: ${r.error}`);
		console.log();
	}
}

const ran = results.filter((r) => !r.skipped);
const disagreed = ran.filter((r) => !r.ok && r.reason === "mismatch");
const unreachable = ran.filter((r) => r.reason === "network");
const skipped = results.length - ran.length;

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
	if (!ran.length) {
		console.log("\nNo keys, so no claim was checked. This is not a pass.");
	}
}

// Precedence: a real disagreement outranks unreachability, which outranks
// having run nothing — the most actionable fact wins the exit code.
if (disagreed.length) process.exit(1);
if (unreachable.length) process.exit(2);
if (!ran.length) process.exit(3);
process.exit(0);

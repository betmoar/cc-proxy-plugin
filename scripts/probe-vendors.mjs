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
// Exit status is 0 when every case matched its expectation, 1 otherwise — so a
// vendor changing its mind is a loud failure, not a quiet surprise.

import { loadEnv } from "../src/env.js";

loadEnv();

const JSON_OUT = process.argv.includes("--json");

/**
 * Each case pins what a source comment claims, WHERE it claims it, and what the
 * vendor must answer for that claim to still hold. `expect` is the status; the
 * optional `bodyMatch` pins the vendor's own error vocabulary, because a 400
 * for the right reason and a 400 for the wrong reason are different facts.
 */
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
];

async function probe(c) {
	const key = process.env[c.key];
	if (!key) return { ...c, skipped: `${c.key} not set` };
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
			body: JSON.stringify({
				model: c.model,
				max_tokens: 4,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		const body = (await res.text()).slice(0, 300);
		const ok = res.status === c.expect && (!c.bodyMatch || c.bodyMatch.test(body));
		return { ...c, status: res.status, body, ok };
	} catch (err) {
		return { ...c, error: err instanceof Error ? err.message : String(err), ok: false };
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
		if (!r.ok && r.body) console.log(`      body: ${r.body.replace(/\s+/g, " ").slice(0, 160)}`);
		console.log();
	}
}

const ran = results.filter((r) => !r.skipped);
const failed = ran.filter((r) => !r.ok);
const skipped = results.length - ran.length;
if (!JSON_OUT) {
	console.log(
		`${ran.length - failed.length}/${ran.length} matched${skipped ? `, ${skipped} skipped (no key)` : ""}`,
	);
	if (failed.length) {
		console.log("\nA vendor no longer behaves the way a source comment says it does.");
		console.log("Update the comment AND re-check the decision that rested on it.");
	}
}
process.exit(failed.length ? 1 : 0);

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

// A non-2xx expectation without a bodyMatch passes on ANY error with that
// status — a reworded rate limit, an auth failure, a malformed-JSON complaint —
// so the probe would print OK while the claim it backs went untested. The
// convention was followed by every case here and enforced by nothing, which is
// one copy-paste from a real gap.
for (const c of CASES) {
	if (c.expect >= 400 && !c.bodyMatch) {
		console.error(
			`probe-vendors: case "${c.name}" expects ${c.expect} but carries no bodyMatch — a status alone cannot tell the vendor's real objection from an unrelated one.`,
		);
		process.exit(2);
	}
}

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

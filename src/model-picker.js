// @ts-check
/**
 * Generate Claude Code's `modelPicker` rows from cc-proxy's curated model facts
 * (issue #62).
 *
 * THE PROBLEM. Claude Code assumes a 200K context window for any id its
 * built-in catalog does not describe, and auto-compacts there — regardless of
 * what the backend actually serves. Every id cc-proxy routes is such an id.
 * Nine of the sixteen in CONTEXT_WINDOW are >=1M and were being budgeted at a
 * fifth of their real window; all sixteen printed a catalog warning at session
 * start. The plugin already knew the right answer per id and had no channel to
 * say so. `modelPicker` is that channel.
 *
 * THE MEASUREMENT (CC 2.1.263, 2026-09-07; probed with
 * `claude --settings <json> --model <id> -p /context` against a stub Anthropic
 * backend, reading /context's reported window and counting
 * `[claude-code:unrecognized_model]` on stderr. Schema read from the CC
 * binary's own zod validator). The two levers are ORTHOGONAL:
 *
 *   lever                          window                        warning
 *   -----------------------------  ----------------------------  ----------
 *   `[1m]` in the row's `model`    1M (else 200K)                unchanged
 *   `behavesAs` on the row         unchanged                     suppressed
 *   CLAUDE_CODE_MAX_CONTEXT_TOKENS only while CC calls id unknown unchanged
 *
 * With MAX_CONTEXT_TOKENS neutralized: bare `glm-4.6` = 200K with AND without
 * `behavesAs`; `glm-5.3[1m]` = 1M with AND without. The warning is suppressed
 * only by `behavesAs` — a row alone does not suppress it, and `[1m]` alone does
 * not.
 *
 * THE TRAP THAT SHAPES THIS FILE. `behavesAs` makes the id KNOWN, which is
 * exactly what disables CLAUDE_CODE_MAX_CONTEXT_TOKENS (the binary's gate
 * requires a non-`claude-` id that is not catalog-resolvable). So adding
 * `behavesAs` to a config that relied on the global pin silently drops 1M ->
 * 200K — measured: `glm-5.3` + `behavesAs` + MAX_CONTEXT_TOKENS=1048576 gives
 * 200k. `[1m]` is the ONLY window channel that survives `behavesAs`, and the
 * two compose. Hence every row carries `behavesAs`, and the window is expressed
 * solely through the suffix.
 *
 * WHY THE SUFFIX IS SAFE HERE. The proxy strips `[1m]` from the outbound body
 * (invariant 1, third body strip) because both Z.ai and the Qwen plan 400 on a
 * suffixed id. That strip is what makes the suffix usable as a pure CLIENT-SIDE
 * window signal: it reaches CC's window math and never reaches a vendor.
 *
 * Nothing here is on the forwarding path — this module generates a client
 * config artifact and merges it into a settings object. No proxy invariant is
 * involved.
 */

import {
	CONTEXT_WINDOW,
	DEFAULT_OPENROUTER_MODELS,
	DEFAULT_QWEN_MODELS,
	dedupByIdentity,
} from "./models.js";
import { buildProviders } from "./providers.js";
import { rankRoutes } from "./routes.js";

/**
 * The `behavesAs` target every generated row carries.
 *
 * ONE CONSTANT, NOT A PER-ID TABLE, and that is a measurement rather than a
 * shrug: five targets were probed (claude-sonnet-4-5, claude-sonnet-4-6,
 * claude-sonnet-5, claude-opus-5, claude-haiku-4-5) and ALL FIVE yielded the
 * same 200K window and the same warning suppression. The window comes from the
 * `[1m]` suffix, not from this value.
 *
 * UNMEASURED, deliberately recorded: whether the target changes anything BEYOND
 * the warning — CC's own description says it also supplies "prompt profile,
 * capability and effort defaults". A per-id mapping would be inventing
 * precision nobody has verified, and it would create a fourth curated question
 * competing with catalog / ROUTES / ownsId. If someone measures a difference,
 * that is the moment this becomes a table.
 *
 * A suffixed target does nothing: `behavesAs: "claude-sonnet-4-5[1m]"` still
 * gave 200K (measured). The suffix only counts on the row's own `model`.
 */
export const BEHAVES_AS = "claude-sonnet-5";

/**
 * Windows at or above this get the `[1m]` suffix; below it, CC's 200K
 * assumption is what the row gets and there is no channel to say otherwise.
 *
 * KNOWN LIMITATION, accepted and documented rather than worked around: a
 * per-row window BELOW 200K is inexpressible. `glm-4.5` / `glm-4.5-air` are
 * 128K and will be budgeted at 200K. The only sub-200K channel is the global
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS, which `behavesAs` disables on every row — and
 * setting it globally would break the nine 1M ids. Over-budgeting a 128K model
 * means CC declines to compact until 200K and the vendor truncates or errors
 * first; under-budgeting the 1M ids means compacting away 800K of usable
 * context every session. The second is the failure this file exists to fix.
 */
const ONE_M = 1000000;

/**
 * Curated display names, indexed by bare id, from the static catalogs that have
 * one. Only NINE of the sixteen curated windows are covered — every GLM id but
 * `glm-5.2` reaches the user through GLM's LIVE catalog and has no static entry
 * to read a name from — so a derivation is needed for the rest. This map is
 * consulted FIRST so the picker cannot spell a model differently from
 * `/v1/models` and docs/models.html: without it, `deepseek-v4-flash-0731`
 * renders "DeepSeek V4 Flash 0731" here and "DeepSeek V4 Flash (0731)" there.
 *
 * Built through `dedupByIdentity` for the same reason the endpoint does: the
 * Qwen catalog carries foreign ids (glm-5.2, deepseek-v4-pro) that the
 * OpenRouter catalog also names, and a plain concat would let declaration order
 * decide the spelling.
 *
 * @type {ReadonlyMap<string, string>}
 */
const CURATED_LABEL = new Map(
	dedupByIdentity([...DEFAULT_QWEN_MODELS, ...DEFAULT_OPENROUTER_MODELS])
		.filter((e) => e.display_name)
		.map((e) => [e.id, e.display_name]),
);

/**
 * Human label for a curated id: the catalog's own `display_name` when one
 * exists, else derived from the id's shape.
 *
 * @doctest labelFor("glm-5.3") -> "GLM-5.3"
 * @doctest labelFor("glm-4.5-air") -> "GLM-4.5 Air"
 * @doctest labelFor("deepseek-v4-pro") -> "DeepSeek V4 Pro"
 * @doctest labelFor("deepseek-v4-flash-0731") -> "DeepSeek V4 Flash (0731)"
 * @doctest labelFor("qwen3.8-max") -> "Qwen3.8 Max"
 * @doctest labelFor("glm-5-turbo") -> "GLM-5 Turbo"
 * @doctest labelFor("deepseek-v4-flash") -> "DeepSeek V4 Flash"
 *
 * @param {string} id  a bare vendor id (no `<provider>:` lens, no `[1m]`)
 * @returns {string}
 */
export function labelFor(id) {
	const curated = CURATED_LABEL.get(id);
	if (curated) return curated;
	const parts = id.split("-");
	const head = parts[0];
	const tail = parts.slice(1);
	// The vendor's own capitalization for the family, then title-case the rest.
	// `v4` -> `V4`, `air` -> `Air`, `0731` -> `0731`.
	const family = head.startsWith("glm")
		? head.toUpperCase()
		: head.startsWith("deepseek")
			? "DeepSeek"
			: head.startsWith("qwen")
				? `Qwen${head.slice(4)}`
				: head;
	const rest = tail.map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));
	// GLM and DeepSeek spell the version attached ("GLM-5.3", "DeepSeek V4"),
	// which differs: GLM keeps the hyphen, DeepSeek uses a space.
	if (family.startsWith("GLM") && rest.length > 0) {
		return [`GLM-${rest[0]}`, ...rest.slice(1)].join(" ");
	}
	return [family, ...rest].join(" ");
}

/**
 * Every curated id reachable with the given env — i.e. every id in
 * CONTEXT_WINDOW that some REGISTERED provider would actually serve.
 *
 * Reachability is asked of the real router's own tables, never restated here: a
 * ranked route to a registered provider, or (for ids with no ROUTES entry) a
 * registered provider whose `match()` claims it. That second leg is what covers
 * the qwen-only ids, which have no multi-backend ambiguity and so were never
 * given ROUTES rows.
 *
 * WHY GATED ON REGISTRATION. Issue #30: setup once wrote an
 * ANTHROPIC_CUSTOM_MODEL_OPTION for a user who had skipped the GLM key, putting
 * a model in their picker that cannot route — warned about once in speech and
 * never on disk, failing weeks later with nothing to explain why. Sixteen rows
 * is sixteen chances to repeat that.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} curated ids, in CONTEXT_WINDOW's declaration order
 */
export function reachableIds(env = process.env) {
	const providers = buildProviders(env, "claude");
	const registered = new Set(providers.filter((p) => !p.isDefault).map((p) => p.id));
	return Object.keys(CONTEXT_WINDOW).filter((id) => {
		if (rankRoutes(id).some((r) => registered.has(r.provider))) return true;
		return providers.some((p) => !p.isDefault && p.match(id));
	});
}

/**
 * @typedef {{ model: string, label: string, description: string, behavesAs: string }} PickerRow
 */

/**
 * Build the `modelPicker.options` rows for the reachable curated ids.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {PickerRow[]}
 */
export function buildRows(env = process.env) {
	return reachableIds(env).map((id) => {
		const window = CONTEXT_WINDOW[id];
		const oneM = window >= ONE_M;
		const label = labelFor(id);
		return {
			// The suffix goes on the row's `model`, which is the id CC hands to
			// --model and sends on the wire — where the proxy strips it again.
			model: oneM ? `${id}[1m]` : id,
			label: oneM ? `${label} (1M)` : label,
			description: `${formatWindow(window)} context, routed via cc-proxy`,
			behavesAs: BEHAVES_AS,
		};
	});
}

/**
 * Human window string for a row description. Same rounding rule as
 * scripts/list-models.js formatContextWindow() — vendor windows are often
 * powers of two and the vendor's own "128K" means 131072, so rounding keeps the
 * string reading the way the vendor writes it.
 *
 * NOT imported from list-models.js on purpose: that module calls loadEnv() at
 * import time and fetches the proxy, which a pure settings transform must not
 * drag in. The duplication is four tokens wide and locked by
 * test/model-picker.test.js against the original.
 *
 * @doctest formatWindow(128000) -> "128K"
 * @doctest formatWindow(1048576) -> "1M"
 * @param {number} tokens
 * @returns {string}
 */
export function formatWindow(tokens) {
	return tokens >= ONE_M ? `${Math.round(tokens / ONE_M)}M` : `${Math.round(tokens / 1000)}K`;
}

/**
 * Is this row one cc-proxy generated (and may therefore replace)?
 *
 * Keyed on the row's `model` with any variant suffix removed, matched against
 * the ids this plugin curates — NOT against what buildRows() returns right now.
 * The difference is load-bearing: a user who set up with a GLM key and later
 * removed it would otherwise have their nine stale GLM rows become "foreign"
 * and be preserved forever, unroutable, which is precisely issue #30's failure.
 * Ownership is a property of the id, not of the current env.
 *
 * A user who deliberately hand-writes a row for a curated id loses it on the
 * next regeneration. That is the accepted trade: the alternative is never being
 * able to correct a window we published wrong.
 *
 * @doctest isGeneratedRow({"model": "glm-5.3[1m]"}) -> true
 * @doctest isGeneratedRow({"model": "glm-4.6"}) -> true
 * @doctest isGeneratedRow({"model": "my-gateway/claude-opus-5"}) -> false
 * @doctest isGeneratedRow({"model": "claude-opus-5"}) -> false
 * @doctest isGeneratedRow({}) -> false
 *
 * @param {unknown} row
 * @returns {boolean}
 */
export function isGeneratedRow(row) {
	if (!row || typeof row !== "object") return false;
	const model = /** @type {{ model?: unknown }} */ (row).model;
	if (typeof model !== "string") return false;
	// Same shape as router.js stripVariantSuffix — interior `[^[\]]*`, so a
	// malformed id is never rewritten into a real one.
	const m = /^(.+)\[[^[\]]*\]$/.exec(model);
	return Object.hasOwn(CONTEXT_WINDOW, m ? m[1] : model);
}

/**
 * Merge generated rows into a settings object, preserving everything foreign.
 *
 * WHY THIS IS CODE AND NOT SKILL PROSE. `modelPicker` has NO cross-source
 * merging — CC's own description: "the highest-precedence of those that defines
 * modelPicker wins outright (no merging across sources)". So a naive write
 * silently discards a user's hand-written rows with no diagnostic anywhere.
 * Load-bearing map #7 ranks corrupting ~/.claude/settings.json as the worst
 * outcome in this tree; that logic belongs where `pnpm test` reaches it, not in
 * a markdown instruction a model follows differently each time.
 *
 * The merge is:
 *   - generated rows replace the previously-generated ones, IN PLACE (a row's
 *     position is a user-visible ordering choice; appending would reshuffle the
 *     picker on every update);
 *   - foreign rows keep their exact positions and contents;
 *   - new generated rows land after the last previously-generated row, or at
 *     the end when there were none;
 *   - `replaceBuiltInOptions` is set to false only when absent, so a user who
 *     chose `true` keeps it.
 *
 * Returns a NEW object; the input is never mutated (a caller that writes the
 * file must be able to diff before/after).
 *
 * @param {Record<string, unknown>} settings  parsed ~/.claude/settings.json
 * @param {PickerRow[]} rows                  from buildRows()
 * @returns {Record<string, unknown>}
 */
export function mergePicker(settings, rows) {
	const next = { ...settings };
	const existing = /** @type {Record<string, unknown>} */ (
		next.modelPicker && typeof next.modelPicker === "object" && !Array.isArray(next.modelPicker)
			? { ...next.modelPicker }
			: {}
	);
	const oldOptions = Array.isArray(existing.options) ? existing.options : [];

	/** @type {unknown[]} */
	const merged = [];
	const byModel = new Map(rows.map((r) => [r.model, r]));
	// Also index by the BARE id: a regenerated row can change spelling (a window
	// crossing 1M adds the suffix), and matching only on the exact string would
	// leave the old spelling behind as a duplicate.
	const byBare = new Map(rows.map((r) => [bare(r.model), r]));
	const placed = new Set();
	let lastGenerated = -1;

	for (const row of oldOptions) {
		if (!isGeneratedRow(row)) {
			merged.push(row);
			continue;
		}
		lastGenerated = merged.length;
		const model = /** @type {{ model: string }} */ (row).model;
		const replacement = byModel.get(model) ?? byBare.get(bare(model));
		if (replacement && !placed.has(replacement.model)) {
			placed.add(replacement.model);
			merged.push(replacement);
		} else {
			// A previously-generated row for an id that is no longer reachable (the
			// user removed a key) is DROPPED, not preserved — see isGeneratedRow.
			lastGenerated = merged.length - 1;
		}
	}

	const fresh = rows.filter((r) => !placed.has(r.model));
	// Slot new rows in with their siblings rather than after foreign rows the
	// user may have deliberately put last.
	merged.splice(lastGenerated + 1, 0, ...fresh);

	if (merged.length === 0) {
		// Nothing to publish and nothing foreign to protect: leave settings without
		// a modelPicker key rather than writing an empty one. CC rejects an
		// options-less object ("must be an object with an options array"), and an
		// empty array would suppress nothing while looking configured.
		//
		// Rebuilt without the key, NOT `next.modelPicker = undefined`: that leaves
		// the key present (`"modelPicker" in next` stays true) and JSON.stringify
		// then drops it, so the in-memory object and the written file would
		// disagree about whether a picker exists. Biome's noDelete autofix suggests
		// exactly that spelling — it is wrong for an object destined for JSON.
		const { modelPicker: _drop, ...withoutPicker } = next;
		return withoutPicker;
	}

	existing.options = merged;
	if (!("replaceBuiltInOptions" in existing)) existing.replaceBuiltInOptions = false;
	next.modelPicker = existing;
	return next;
}

/**
 * A row's id without its variant suffix.
 * @param {string} model
 * @returns {string}
 */
function bare(model) {
	const m = /^(.+)\[[^[\]]*\]$/.exec(model);
	return m ? m[1] : model;
}

/**
 * The `env` keys setup must remove when it writes a generated picker, with the
 * reason for each. Exported so the skill and the script cannot disagree about
 * the list.
 *
 * ANTHROPIC_CUSTOM_MODEL_OPTION* — with `replaceBuiltInOptions: false` BOTH
 * render, so keeping it duplicates whichever id it names (today `glm-5.3[1m]`,
 * which is now row one of the generated set).
 *
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS is NOT in this list. It is offered for removal
 * interactively instead, never stripped: with rows in place the pin only
 * affects ids that have NO row — typos, subagent pins, OpenRouter slash-ids —
 * where a 1M value is the dangerous guess and CC's 200K default is the safe
 * one. That is a judgement about the user's other tooling, so it is the user's
 * to make.
 *
 * @type {ReadonlyArray<string>}
 */
export const SUPERSEDED_ENV_KEYS = [
	"ANTHROPIC_CUSTOM_MODEL_OPTION",
	"ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
	"ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
];

/**
 * Drop the env keys the generated picker supersedes. Returns a new object;
 * reports what it removed so the caller can tell the user.
 *
 * @param {Record<string, unknown>} settings
 * @returns {{ settings: Record<string, unknown>, removed: string[] }}
 */
export function dropSupersededEnv(settings) {
	const env = settings.env;
	if (!env || typeof env !== "object" || Array.isArray(env)) {
		return { settings: { ...settings }, removed: [] };
	}
	const nextEnv = { ...env };
	const removed = SUPERSEDED_ENV_KEYS.filter((k) => k in nextEnv);
	for (const k of removed) delete nextEnv[k];
	return { settings: { ...settings, env: nextEnv }, removed };
}

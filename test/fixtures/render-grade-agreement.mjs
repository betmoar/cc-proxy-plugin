// Asks the renderer's row-grading path and src/models.js gradeOf() the same
// question in one process, and prints both answers as JSON.
//
// A subprocess is required for the same reason as glm-entry-coercion: BOTH
// modules resolve ~/.claude/cc-proxy/grades.json ONCE at import (gradeOf's
// REFRESHED_GRADES), so the caller's HOME must be in place before the import —
// an in-process env swap comes too late, and the module cache pins whatever the
// first import read.
//
// `undefined` is encoded as null: JSON.stringify drops an undefined-valued key
// entirely, which would make "no grade" indistinguishable from "key missing
// because the fixture forgot it".
import { groupByProvider } from "../../scripts/render-models.js";
import { gradeOf } from "../../src/models.js";

/** The tier the renderer would draw for `id`, via the real grouping path. */
const rendered = (id) => {
	const [card] = groupByProvider([{ id, provider: "deepseek" }]).values();
	return card.models[0].tier;
};

const ask = (id) => ({ rendered: rendered(id), gradeOf: gradeOf(id) ?? null });

process.stdout.write(
	JSON.stringify({
		bare: ask("deepseek-v4-pro"),
		alias: ask("qwen:deepseek-v4-pro"),
		unassessed: ask("vendor/never-assessed"),
	}),
);

// Runs groupByProvider's tier ordering in a SUBPROCESS, so the caller can pin
// HOME before src/models.js binds REFRESHED_GRADES at module import.
//
// The in-process version of this assertion read the DEVELOPER's
// ~/.claude/cc-proxy/grades.json: gradeOf() overlays that file on MODEL_GRADES,
// groupByProvider sorts by grade, and an `env.HOME` swap inside the test process
// arrives too late — the module cache already holds whatever the first import
// read. Measured before this fixture existed: a HOME whose grades.json calls
// glm-5.2 "Specialist" and glm-4.5 "Flagship" inverted the expected order and
// failed the test. Same reason the grade-agreement case in test/models.test.js spawns rather than swaps.
//
// Prints the ordered ids as JSON on stdout; the parent asserts.

import { groupByProvider } from "../../scripts/render-models.js";

const rows = [
	{ id: "glm-5", provider: "glm" },
	{ id: "glm-5.2", provider: "glm" },
	{ id: "glm-5.1", provider: "glm" },
	{ id: "glm-4.5", provider: "glm" },
	{ id: "glm-4.7", provider: "glm" },
];

const ids = groupByProvider(rows)
	.get("glm")
	.models.map((m) => m.id);

process.stdout.write(JSON.stringify({ ids }));

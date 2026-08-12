#!/usr/bin/env node
// Regenerates docs/models.html — the wrapper `pnpm models:html` runs.
//
// WHY A WRAPPER AND NOT `node render-models.js > docs/models.html`:
//
// The renderer computes grades in-process through gradeOf() (render-models.js
// tierFor), and gradeOf() overlays ~/.claude/cc-proxy/grades.json on top of the
// built-in MODEL_GRADES table. So a plain run publishes whatever the OPERATOR
// last benched — the committed artifact shipped glm-5 as Specialist and
// claude-fable-5 as Strong purely because this machine's grades.json said so,
// while src/models.js said Strong and Flagship. A repo artifact must state the
// REPO's grades, not one developer's.
//
// The suite already learned this (9ac2bf2, "isolate HOME so the suite stops
// reading the developer's grades.json"); the release procedure never did.
//
// Isolating the whole HOME is the obvious fix and it is WRONG: src/env.js
// loadEnv() reads ~/.env from the same home, so a blanket override drops every
// third-party API key, every live leg fails to register, and the page silently
// collapses to the Claude card alone (measured: 40 rows -> 3). The isolation has
// to be surgical — hide exactly the grades file, keep the rest of HOME.
//
// So: a temp home containing a SYMLINK to the real ~/.env, and no
// .claude/cc-proxy/grades.json. Keys resolve, grades fall back to the built-in
// table, and the rest of the environment is untouched.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const out = path.join(repo, "docs", "models.html");

const realHome = os.homedir();
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccproxy-render-"));

try {
	// The one thing the renderer needs from a real home: the API keys that decide
	// which legs register. Symlinked, not copied — nothing here should be a second
	// copy of a credential file, however short-lived.
	const realEnv = path.join(realHome, ".env");
	if (fs.existsSync(realEnv)) fs.symlinkSync(realEnv, path.join(tmpHome, ".env"));

	const html = execFileSync(process.execPath, [path.join(here, "render-models.js")], {
		env: { ...process.env, HOME: tmpHome },
		maxBuffer: 64 * 1024 * 1024,
		encoding: "utf8",
	});

	// A collapsed page is the failure mode this wrapper itself introduced once, so
	// it refuses to write one. The floor is deliberately low (a card is dropped
	// when its leg is unregistered, which is legitimate on a machine with fewer
	// keys) — this catches "everything broke", not "one leg is missing".
	const rows = (html.match(/<span class="mname">/g) || []).length;
	if (rows < 10) {
		console.error(`render-html: only ${rows} model rows — refusing to overwrite ${out}.`);
		console.error(
			"Is the proxy running (lsof -nP -iTCP:4000 -sTCP:LISTEN) and are keys in ~/.env?",
		);
		process.exit(1);
	}

	fs.writeFileSync(out, html);
	console.log(`docs/models.html — ${rows} rows, grades from the repo's MODEL_GRADES table.`);
} finally {
	fs.rmSync(tmpHome, { recursive: true, force: true });
}

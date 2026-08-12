// Runs the "GLM entry coercion" scenario end-to-end inside a subprocess whose
// HOME is set by the caller, then prints the resulting `glm:x` entry as JSON.
// Needed because src/models.js reads ~/.claude/cc-proxy/grades.json ONCE at
// module load (REFRESHED_GRADES) — see src/models.js:100-118 and
// test/grades-refresh.test.js:18-20 for why an in-process HOME swap can't
// isolate this from the developer's real grades.json.
import http from "node:http";
import { collectModels } from "../../src/models.js";
import { buildProviders } from "../../src/providers.js";

function startBackend(handler) {
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const { status, headers, body } = handler();
			res.writeHead(status, headers);
			res.end(body);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}

const { server, baseUrl } = await startBackend(() => ({
	status: 200,
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ data: [{}, { id: "x", created: 1700000000 }, { id: "" }] }),
}));

const providers = buildProviders({ GLM_API_KEY: "glm-test" }, "claude");
providers.find((p) => p.id === "glm").baseUrl = baseUrl;

const { data } = await collectModels({
	providers,
	claudeModels: [],
	qwenModels: [],
	openRouterModels: [],
	openRouterModelsExplicit: true,
	modelsTimeoutMs: 2000,
});

server.close();
process.stdout.write(JSON.stringify(data));

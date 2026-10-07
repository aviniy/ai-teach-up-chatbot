import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workerPath = resolve("dist/server/index.js");
const workerModule = await import(`${pathToFileURL(workerPath)}?t=${Date.now()}`);
assert.equal(typeof workerModule.default?.fetch, "function", "Worker must export default.fetch");

const env = { SESSION_SIGNING_SECRET: "validation-secret-at-least-32-characters" };
const page = await workerModule.default.fetch(new Request("https://example.test/"), env, {});
assert.equal(page.status, 200);
assert.match(await page.text(), /AI Teach-Up/);

const config = await workerModule.default.fetch(new Request("https://example.test/api/config"), env, {});
assert.equal(config.status, 200);
const payload = await config.json();
assert.equal(payload.teamModes.length, 3);
assert.equal(typeof payload.sessionId, "string");
assert.ok(payload.sessionId.includes("."));
console.log("Hosted Worker validation passed");

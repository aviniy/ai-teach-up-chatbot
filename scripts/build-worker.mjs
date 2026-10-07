import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [template, html, css, app, manifest] = await Promise.all([
  readFile(resolve(projectRoot, "worker/worker-template.js"), "utf8"),
  readFile(resolve(projectRoot, "public/index.html"), "utf8"),
  readFile(resolve(projectRoot, "public/styles.css"), "utf8"),
  readFile(resolve(projectRoot, "public/app.js"), "utf8"),
  readFile(resolve(projectRoot, ".openai/hosting.json"), "utf8")
]);

const replacements = new Map([
  ["__INDEX_HTML_JSON__", JSON.stringify(html)],
  ["__STYLES_CSS_JSON__", JSON.stringify(css)],
  ["__APP_JS_JSON__", JSON.stringify(app)]
]);

let output = template;
for (const [marker, value] of replacements) output = output.replace(`\"${marker}\"`, value);
if ([...replacements.keys()].some((marker) => output.includes(marker))) {
  throw new Error("Worker asset placeholder replacement failed.");
}

const dist = resolve(projectRoot, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await mkdir(resolve(dist, ".openai"), { recursive: true });
await writeFile(resolve(dist, "server/index.js"), output);
await writeFile(resolve(dist, ".openai/hosting.json"), manifest);
console.log(`Built ${dist}`);

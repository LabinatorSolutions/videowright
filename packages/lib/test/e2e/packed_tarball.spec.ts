/**
 * Packed-tarball smoke test.
 *
 * Everything else runs against this repo, where every src/ file exists. This
 * test runs against what npm actually publishes: it packs the package,
 * installs the tarball into a throwaway consumer project (one segment, one
 * timeline), then drives `videowright dev` in a browser and `videowright
 * render` to an MP4. Any import that reaches outside the shipped files fails
 * here.
 *
 * Needs network access (npm install) and ffmpeg on PATH.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "../..");

// Render launches Chromium through the consumer's own `playwright`. Pin it to
// the version this repo uses so it finds the browser CI already installed.
const PLAYWRIGHT_VERSION = (
	createRequire(import.meta.url)("playwright-core/package.json") as { version: string }
).version;

const VIDEO_SLUG = "smoke";
const SEGMENT_ID = "smoke-card";
const DEV_PORT = 5230;

const CONSUMER_FILES: Record<string, string> = {
	"package.json": JSON.stringify(
		{ name: "vw-packed-smoke", version: "0.0.0", private: true, type: "module" },
		null,
		2,
	),
	"videowright.config.ts": `import { defineConfig } from "videowright";

export default defineConfig({ projectStructure: "v1" });
`,
	[`segments/${SEGMENT_ID}/index.ts`]: `import { defineSegment } from "videowright";

export default defineSegment({
	id: "${SEGMENT_ID}",
	advances: [1.0],
	mount(el) {
		el.innerHTML = '<h1 id="smoke-title" style="color:white">Packed smoke</h1>';
	},
	async play() {},
});
`,
	[`videos/${VIDEO_SLUG}/timeline.ts`]: `import type { Timeline } from "videowright";

const timeline: Timeline = {
	meta: { title: "Packed smoke" },
	segments: [{ id: "${SEGMENT_ID}" }],
};

export default timeline;
`,
};

/**
 * Env for child npm/CLI processes. npm injects the monorepo's local prefix
 * and workspace settings into scripts it runs; a nested `npm install` would
 * otherwise install into the repo instead of the consumer.
 */
function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
	for (const key of Object.keys(env)) {
		if (/^npm_config_(local_prefix|workspaces?|include_workspace_root)$/i.test(key)) {
			delete env[key];
		}
	}
	return env;
}

async function packTarball(destDir: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"npm",
		["pack", "--json", "--ignore-scripts", "--pack-destination", destDir],
		{ cwd: PKG_ROOT, env: childEnv() },
	);
	const [pack] = JSON.parse(stdout) as Array<{ filename: string }>;
	return join(destDir, pack.filename);
}

function writeConsumerProject(root: string): void {
	for (const [path, content] of Object.entries(CONSUMER_FILES)) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
}

/** Start `videowright dev` and resolve with the URL it prints once listening. */
function startDevServer(
	consumerRoot: string,
	bin: string,
): Promise<{ proc: ChildProcess; url: string }> {
	return new Promise((resolvePromise, reject) => {
		const proc = spawn(bin, ["dev", "--port", String(DEV_PORT)], {
			cwd: consumerRoot,
			env: childEnv(),
		});
		let output = "";
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			const match = output.match(/running at (http:\/\/\S+)/);
			if (match) resolvePromise({ proc, url: match[1] });
		};
		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);
		proc.on("exit", (code) => {
			reject(new Error(`videowright dev exited early (code ${code}):\n${output}`));
		});
	});
}

let workDir: string;
let consumerRoot: string;
let bin: string;
let devServer: { proc: ChildProcess; url: string } | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
	test.setTimeout(300_000);

	workDir = mkdtempSync(join(tmpdir(), "vw-packed-smoke-"));
	consumerRoot = join(workDir, "consumer");
	writeConsumerProject(consumerRoot);

	const tarball = await packTarball(workDir);
	await execFileAsync(
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--prefix",
			consumerRoot,
			tarball,
			`playwright@${PLAYWRIGHT_VERSION}`,
		],
		{ cwd: consumerRoot, env: childEnv() },
	);

	bin = join(consumerRoot, "node_modules/.bin/videowright");
	expect(existsSync(bin), "tarball install should provide the videowright bin").toBe(true);
});

test.afterAll(() => {
	devServer?.proc.kill();
	devServer = null;
	if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test("videowright dev boots the player from the installed package", async ({ page }) => {
	test.setTimeout(120_000);
	devServer = await startDevServer(consumerRoot, bin);

	const problems: string[] = [];
	page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
	page.on("response", (res) => {
		if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
	});

	// Every module URL of the library itself, so we can check the entry and
	// the consumer's segment share one copy.
	const libraryModules = new Set<string>();
	page.on("request", (req) => {
		const path = req.url().split("?")[0];
		if (/\/videowright\/dist\/index\.js$|\/deps\/videowright\.js$/.test(path)) {
			libraryModules.add(path);
		}
	});

	await page.goto(`${devServer.url}video/${VIDEO_SLUG}`);
	await page
		.waitForFunction("window.__VW_PLAYER_READY__ === true", undefined, { timeout: 30_000 })
		.catch((err: Error) => {
			throw new Error(`Player never became ready.\n${problems.join("\n")}\n${err.message}`);
		});

	await expect(page.locator("#smoke-title")).toHaveText("Packed smoke");
	expect(problems).toEqual([]);
	expect([...libraryModules]).toHaveLength(1);
});

test("videowright render writes an MP4 from the installed package", async () => {
	test.setTimeout(180_000);
	const output = join(consumerRoot, "smoke.mp4");

	await execFileAsync(
		bin,
		["render", VIDEO_SLUG, "--output", output, "--width", "320", "--height", "180", "--fps", "10"],
		{ cwd: consumerRoot, env: childEnv(), timeout: 150_000 },
	);

	expect(existsSync(output)).toBe(true);
	expect(statSync(output).size).toBeGreaterThan(1000);
});

/**
 * Guard: the published tarball ships some files under src/ as source (the
 * Vite entry in src/cli/entry/). Vite serves them from node_modules as-is, so
 * any relative import that points at a file outside the tarball breaks a
 * clean install even though it works inside this repo.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = resolve(__dirname, "../..");

const SOURCE_FILE_RE = /\.(ts|mts|js|mjs|html)$/;

const SPECIFIER_PATTERNS = [
	/\bfrom\s*["']([^"']+)["']/g,
	/\bimport\s*["']([^"']+)["']/g,
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	/\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/g,
	/\b(?:src|href)\s*=\s*["']([^"']+)["']/g,
];

/** Paths (relative to the package root) that `npm pack` would publish. */
function listPackedFiles(): string[] {
	const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: PKG_ROOT,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
	return pack.files.map((f) => f.path);
}

function relativeSpecifiers(code: string): string[] {
	const specs: string[] = [];
	for (const pattern of SPECIFIER_PATTERNS) {
		for (const match of code.matchAll(pattern)) {
			if (match[1].startsWith("./") || match[1].startsWith("../")) specs.push(match[1]);
		}
	}
	return specs;
}

/** Files a specifier may resolve to, honouring the TS convention that `./x.js` means `./x.ts`. */
function candidatePaths(target: string): string[] {
	if (/\.m?js$/.test(target)) {
		return [target, target.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts")];
	}
	if (posix.extname(target)) return [target];
	return [`${target}.ts`, `${target}.js`, `${target}/index.ts`, `${target}/index.js`];
}

/**
 * Return "<file> -> <specifier>" for every relative import in a shipped
 * src/ file that does not resolve to another shipped file.
 */
function findUnshippedRelativeImports(
	packedFiles: string[],
	readFile: (path: string) => string,
): string[] {
	const shipped = new Set(packedFiles);
	const broken: string[] = [];
	for (const file of packedFiles) {
		if (!file.startsWith("src/") || !SOURCE_FILE_RE.test(file)) continue;
		for (const spec of relativeSpecifiers(readFile(file))) {
			const target = posix.normalize(posix.join(posix.dirname(file), spec));
			if (!candidatePaths(target).some((p) => shipped.has(p))) {
				broken.push(`${file} -> ${spec}`);
			}
		}
	}
	return broken;
}

describe("findUnshippedRelativeImports", () => {
	const files: Record<string, string> = {
		"src/cli/entry/views/video_view.ts": [
			'import { Player } from "../../../index.js";',
			'import { resolveTiming } from "../../../timeline/resolveTiming.js";',
			'import { renderTopBar } from "../components/top_bar.js";',
			'import { defineSegment } from "videowright";',
		].join("\n"),
		"src/cli/entry/components/top_bar.ts": "export const renderTopBar = () => {};",
		"src/cli/entry/virtual.d.ts": '/// <reference path="../../virtual-modules.d.ts" />',
		"src/cli/entry/entry.ts": 'import "./styles/base.css";\nawait import("./lazy.js");',
		"src/cli/entry/render.html": '<script type="module" src="./render_entry.ts"></script>',
		"src/cli/entry/styles/base.css": "",
		"dist/index.js": 'export * from "./not-checked.js";',
	};
	const read = (path: string) => files[path];

	it("flags relative imports and references that leave the shipped files", () => {
		expect(findUnshippedRelativeImports(Object.keys(files), read).sort()).toEqual([
			"src/cli/entry/entry.ts -> ./lazy.js",
			"src/cli/entry/render.html -> ./render_entry.ts",
			"src/cli/entry/views/video_view.ts -> ../../../index.js",
			"src/cli/entry/views/video_view.ts -> ../../../timeline/resolveTiming.js",
			"src/cli/entry/virtual.d.ts -> ../../virtual-modules.d.ts",
		]);
	});

	it("accepts imports that resolve to shipped files and bare package imports", () => {
		const shipped = [
			"src/cli/entry/a.ts",
			"src/cli/entry/b.ts",
			"src/cli/entry/c/index.ts",
			"src/cli/entry/d.css",
		];
		const sources: Record<string, string> = {
			"src/cli/entry/a.ts": [
				'import { b } from "./b.js";',
				'export * from "./c";',
				'import "./d.css";',
				'import { Player } from "videowright";',
			].join("\n"),
			"src/cli/entry/b.ts": "export const b = 1;",
			"src/cli/entry/c/index.ts": "export const c = 1;",
		};
		expect(findUnshippedRelativeImports(shipped, (p) => sources[p] ?? "")).toEqual([]);
	});
});

describe("published package", () => {
	it("ships no source file whose relative imports point outside the tarball", () => {
		const packed = listPackedFiles();
		expect(packed).toContain("src/cli/entry/index.html");

		const broken = findUnshippedRelativeImports(packed, (path) =>
			readFileSync(resolve(PKG_ROOT, path), "utf-8"),
		);
		expect(broken).toEqual([]);
	});
});

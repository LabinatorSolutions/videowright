import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { viteAliases } from "../../src/cli/vite_helpers.js";

let pkgRoot: string;

beforeEach(() => {
	pkgRoot = mkdtempSync(join(tmpdir(), "vw-aliases-"));
});

afterEach(() => {
	rmSync(pkgRoot, { recursive: true, force: true });
});

function libraryAlias(aliases: ReturnType<typeof viteAliases>) {
	return aliases.find((a) => a.find instanceof RegExp && a.find.test("videowright"));
}

describe("viteAliases", () => {
	it("maps @consumer to the consumer root", () => {
		expect(viteAliases("/consumer", pkgRoot)).toContainEqual({
			find: "@consumer",
			replacement: "/consumer",
		});
	});

	it("maps bare videowright to src/index.ts when the source exists (in-repo)", () => {
		mkdirSync(join(pkgRoot, "src"));
		writeFileSync(join(pkgRoot, "src/index.ts"), "");

		const alias = libraryAlias(viteAliases("/consumer", pkgRoot));
		expect(alias?.replacement).toBe(join(pkgRoot, "src/index.ts"));

		const find = alias?.find as RegExp;
		expect(find.test("videowright/cli")).toBe(false);
		expect(find.test("@consumer/videowright")).toBe(false);
	});

	it("adds no videowright alias when src/index.ts is absent (installed package)", () => {
		mkdirSync(join(pkgRoot, "src/cli/entry"), { recursive: true });

		expect(libraryAlias(viteAliases("/consumer", pkgRoot))).toBeUndefined();
	});
});

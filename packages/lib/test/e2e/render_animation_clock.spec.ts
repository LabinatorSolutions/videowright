/**
 * End-to-end render test: CSS and WAAPI animations follow the render clock.
 *
 * Renders a fixture project through the real `runRender` pipeline and reads
 * bar positions back out of the encoded MP4. The repro segment shows three
 * bars looping the same 1s slide: one driven by a CSS @keyframes animation,
 * one by WAAPI (`iterations: Infinity`), and a reference bar positioned from
 * performance.now() in a rAF loop. The time shim controls rAF and
 * performance.now(), so the reference always shows the correct position; the
 * CSS and WAAPI bars must match it in every sampled frame.
 *
 * Needs ffmpeg on PATH.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { runRender } from "../../src/cli/render.js";

const execFileAsync = promisify(execFile);

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

// Geometry of the repro segment's bars: each starts at left:100px and slides
// translateX(0 -> 1600px) once per second. Rows are each bar's vertical center.
const BAR_LEFT_PX = 100;
const SLIDE_PX = 1600;
const BAR_ROWS = { css: 210, waapi: 510, ref: 810 } as const;
type Bar = keyof typeof BAR_ROWS;

// The repro segment's CSS and WAAPI bars start on the browser's first frame
// after play() reads t0 for the reference bar, during boot (real time), so they
// trail it by a fixed, host-dependent lag: typically one 60Hz frame (16ms =
// 26px). Allow up to 100ms of lag for slow hosts, but require it to stay
// constant: a bar that stops looping drifts by hundreds of px.
const MAX_BOOT_LAG_PX = 160;
const MAX_DRIFT_PX = 4;

// Sample one frame every 0.3s across the 4s segment (3+ loops).
const SAMPLE_STEP_FRAMES = 9;
const SAMPLE_FRAMES = Array.from({ length: 13 }, (_, i) => (i + 1) * SAMPLE_STEP_FRAMES);

const REPRO_SEGMENT = `import { defineSegment } from "videowright";

let host: HTMLElement | null = null;

export default defineSegment({
	id: "css-anim-repro",
	advances: [4.0],
	mount(el) {
		host = el;
		el.innerHTML = \`
      <style>
        @keyframes slide { from { transform: translateX(0) } to { transform: translateX(1600px) } }
        .bar { position:absolute; left:100px; width:120px; height:120px }
        .css { top:150px; background:#c33; animation: slide 1s linear infinite }
      </style>
      <div style="position:absolute;inset:0;background:#fff">
        <div class="bar css" data-ref="css"></div>
        <div class="bar" data-ref="waapi" style="top:450px;background:#33c"></div>
        <div class="bar" data-ref="ref" style="top:750px;background:#3a3"></div>
      </div>\`;
	},
	async play(ctx) {
		const root = host;
		if (!root) return;
		const q = (r: string) => root.querySelector(\`[data-ref="\${r}"]\`) as HTMLElement;
		q("waapi").animate(
			[{ transform: "translateX(0)" }, { transform: "translateX(1600px)" }],
			{ duration: 1000, iterations: Infinity, easing: "linear" },
		);
		const t0 = performance.now();
		const tick = () => {
			if (ctx.signal.aborted) return;
			const t = ((performance.now() - t0) % 1000) / 1000;
			q("ref").style.transform = \`translateX(\${t * 1600}px)\`;
			requestAnimationFrame(tick);
		};
		tick();
	},
	unmount() {
		host = null;
	},
});
`;

const FIXTURE_SEGMENTS: Record<string, string> = {
	"css-anim-repro": REPRO_SEGMENT,
};

// Video slug -> ordered segment IDs.
const FIXTURE_TIMELINES: Record<string, string[]> = {
	"repro-first": ["css-anim-repro"],
};

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function writeFixtureProject(root: string): void {
	writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
	writeFile(
		join(root, "videowright.config.ts"),
		`export default { projectStructure: "v1" as const };`,
	);
	for (const [id, source] of Object.entries(FIXTURE_SEGMENTS)) {
		writeFile(join(root, "segments", id, "index.ts"), source);
	}
	for (const [slug, segmentIds] of Object.entries(FIXTURE_TIMELINES)) {
		const segments = segmentIds.map((id) => `{ id: "${id}" }`).join(", ");
		writeFile(
			join(root, "videos", slug, "timeline.ts"),
			`export default { meta: { title: "${slug}" }, segments: [${segments}] };\n`,
		);
	}
}

async function renderVideo(root: string, slug: string): Promise<string> {
	const output = join(root, `${slug}.mp4`);
	await runRender({
		cwd: root,
		positional: slug,
		width: WIDTH,
		height: HEIGHT,
		fps: FPS,
		output,
		audioTrack: "none",
	});
	return output;
}

/** Decode one video frame to raw RGB24 pixels. */
async function decodeFrame(videoPath: string, frameIndex: number): Promise<Buffer> {
	// Seek to the middle of the frame's display interval so rounding can't
	// land on a neighbor.
	const seekSec = (frameIndex + 0.5) / FPS;
	const { stdout } = await execFileAsync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-ss",
			seekSec.toFixed(4),
			"-i",
			videoPath,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgb24",
			"pipe:1",
		],
		{ encoding: "buffer", maxBuffer: WIDTH * HEIGHT * 3 * 2 },
	);
	return stdout;
}

/** translateX of a bar: its left edge on its row (first non-white pixel), minus its CSS left. */
function barOffset(frame: Buffer, bar: Bar): number {
	const row = BAR_ROWS[bar];
	for (let x = 0; x < WIDTH; x++) {
		const i = (row * WIDTH + x) * 3;
		if (Math.min(frame[i], frame[i + 1], frame[i + 2]) < 128) return x - BAR_LEFT_PX;
	}
	throw new Error(`No ${bar} bar found on row ${row}`);
}

/** Distance between two slide offsets, treating the loop's end and start as the same point. */
function loopDistance(a: number, b: number): number {
	const d = Math.abs(a - b) % SLIDE_PX;
	return Math.min(d, SLIDE_PX - d);
}

/** Signed offset of a from b on the loop, in [-SLIDE_PX / 2, SLIDE_PX / 2). */
function loopDelta(a: number, b: number): number {
	return ((((a - b) % SLIDE_PX) + SLIDE_PX * 1.5) % SLIDE_PX) - SLIDE_PX / 2;
}

let fixtureRoot: string;

test.beforeAll(() => {
	// Resolve symlinks in tmpdir (macOS /var -> /private/var) so Vite's
	// server.fs.allow check matches the real paths it resolves internally.
	fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), "vw-anim-clock-"));
	writeFixtureProject(fixtureRoot);
});

test.afterAll(() => {
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

test("CSS and WAAPI loops in the first segment keep looping with the render clock", async () => {
	test.setTimeout(180_000);
	const video = await renderVideo(fixtureRoot, "repro-first");

	let previousRef: number | undefined;
	const firstLag: Partial<Record<Bar, number>> = {};
	for (const frameIndex of SAMPLE_FRAMES) {
		const frame = await decodeFrame(video, frameIndex);
		const at = `frame ${frameIndex} (${(frameIndex / FPS).toFixed(2)}s)`;
		const ref = barOffset(frame, "ref");

		// Sanity: the reference bar advances exactly with the render clock, so
		// the frames sampled here are the ones we think they are.
		if (previousRef !== undefined) {
			const expectedRef = previousRef + (SAMPLE_STEP_FRAMES / FPS) * SLIDE_PX;
			expect(loopDistance(ref, expectedRef), `ref bar step at ${at}`).toBeLessThan(4);
		}
		previousRef = ref;

		for (const bar of ["css", "waapi"] as const) {
			const lag = loopDelta(barOffset(frame, bar), ref);
			firstLag[bar] ??= lag;
			const base = firstLag[bar];
			expect(Math.abs(lag), `${bar} lag behind ref at ${at}`).toBeLessThan(MAX_BOOT_LAG_PX);
			expect(Math.abs(lag - base), `${bar} drift from ref at ${at}`).toBeLessThan(MAX_DRIFT_PX);
		}
	}
});

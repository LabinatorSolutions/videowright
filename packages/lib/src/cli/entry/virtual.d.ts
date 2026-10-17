/**
 * Type declarations for the Vite virtual modules the entry files import.
 *
 * src/cli/entry/** is excluded from the build tsconfig, so tsconfig.test.json
 * lists this file explicitly for tests that import entry modules.
 */

declare module "virtual:vw-globals" {
	export const timelinePath: string;
	export const consumerRoot: string;
	export const audioFile: string | undefined;
	export const resolvedTiming: Record<string, number[]> | undefined;
	export const audioTrackNone: boolean | undefined;
	export const renderFps: number | undefined;
}

declare module "virtual:videowright/project" {
	import type { ProjectInfo } from "videowright";
	const projectInfo: ProjectInfo;
	export default projectInfo;
}

declare module "virtual:vw-segments" {
	const segments: Record<string, () => Promise<unknown>>;
	export default segments;
}

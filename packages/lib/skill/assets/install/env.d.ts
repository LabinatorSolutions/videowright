// Types for the non-TypeScript imports Vite handles at runtime. TypeScript
// rejects these imports without a matching module declaration.

// Side-effect CSS imports such as the style import at the top of every
// timeline.ts (`import "../../styles/<slug>/tokens.css"`). TypeScript 6+
// fails with TS2882 without this declaration.
declare module "*.css";

// Image and video imports resolve to the URL Vite serves the file from.
declare module "*.png" {
	const url: string;
	export default url;
}
declare module "*.jpg" {
	const url: string;
	export default url;
}
declare module "*.jpeg" {
	const url: string;
	export default url;
}
declare module "*.gif" {
	const url: string;
	export default url;
}
declare module "*.webp" {
	const url: string;
	export default url;
}
declare module "*.svg" {
	const url: string;
	export default url;
}
declare module "*.mp4" {
	const url: string;
	export default url;
}
declare module "*.webm" {
	const url: string;
	export default url;
}

// `?raw` imports resolve to the file's text, e.g. inline SVG markup from
// `import icon from "./icon.svg?raw"`.
declare module "*?raw" {
	const text: string;
	export default text;
}

// `?url` imports resolve to the file's URL, for any file type.
declare module "*?url" {
	const url: string;
	export default url;
}

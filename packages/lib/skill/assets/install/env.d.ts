// Lets TypeScript accept side-effect CSS imports such as the style import at
// the top of every timeline.ts (`import "../../styles/<slug>/tokens.css"`).
// Vite handles the CSS at runtime; TypeScript 6+ rejects the import without
// this declaration (TS2882).
declare module "*.css";

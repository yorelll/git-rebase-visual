const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
// Sourcemaps embed `sourcesContent`, i.e. the full TypeScript sources, into the
// VSIX. Keep them for local development (watch) only; a packaged build must not
// ship readable sources. `--sourcemap` forces them on for debugging a build.
const sourcemap = process.argv.includes("--sourcemap");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: watch || sourcemap,
    logLevel: "info",
  });

  // seq-editor runs as a standalone node process invoked by git; ship it as-is.
  fs.mkdirSync("dist", { recursive: true });
  fs.copyFileSync(
    path.join("src", "git", "seq-editor.js"),
    path.join("dist", "seq-editor.js")
  );

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    // A previously generated map would survive the rebuild and get packaged
    // next to the new bundle, so delete it when this build does not emit one.
    const mapPath = path.join("dist", "extension.js.map");
    if (!sourcemap && fs.existsSync(mapPath)) {
      fs.unlinkSync(mapPath);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

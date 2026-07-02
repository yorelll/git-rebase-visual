const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: true,
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
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

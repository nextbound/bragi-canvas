import esbuild from "esbuild";
import process from "process";
import fs from "fs/promises";
import path from "path";

const prod = process.argv[2] === "production";

/** Load a few third-party assets as plain text so the plugin can inject them at runtime. */
const textAssetsPlugin = {
	name: "text-assets",
	setup(build) {
		build.onResolve({ filter: /^pannellum-raw$/ }, () => ({
			path: path.resolve("./node_modules/pannellum/build/pannellum.js"),
			namespace: "text-asset",
		}));
		build.onResolve({ filter: /^pannellum-raw-css$/ }, () => ({
			path: path.resolve("./node_modules/pannellum/build/pannellum.css"),
			namespace: "text-asset",
		}));
		build.onLoad({ filter: /.*/, namespace: "text-asset" }, async (args) => ({
			contents: await fs.readFile(args.path, "utf8"),
			loader: "text",
		}));
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		"http",
		"https",
		"crypto",
		"net",
		"tls",
		"stream",
		"events",
		"buffer",
		"url",
		"util",
		"querystring",
		"zlib",
		"node:http",
		"node:https",
		"node:crypto",
		"node:net",
		"node:tls",
		"node:stream",
		"node:events",
		"node:buffer",
		"node:url",
		"node:util",
		"node:querystring",
		"node:zlib",
		"node:stream/web",
		"node:async_hooks",
		"node:diagnostics_channel",
		"http2",
		"node:http2",
		"os",
		"node:os",
		"fs",
		"node:fs",
		"path",
		"node:path",
		"child_process",
		"node:child_process",
		"worker_threads",
		"node:worker_threads",
		"perf_hooks",
		"node:perf_hooks",
		"assert",
		"node:assert",
		"string_decoder",
		"node:string_decoder",
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	loader: {
		".css": "text",
	},
	plugins: [textAssetsPlugin],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}

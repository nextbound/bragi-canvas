import esbuild from "esbuild";
import process from "process";
import fs from "fs/promises";
import path from "path";

const prod = process.argv[2] === "production";

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
	plugins: [],
});

if (prod) {
	await context.rebuild();
	const srcCss = path.resolve("src/styles.css");
	const rootCss = path.resolve("styles.css");
	await fs.copyFile(srcCss, rootCss);
	process.exit(0);
} else {
	await context.watch();
}

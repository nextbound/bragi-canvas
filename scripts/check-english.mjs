import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const walk = (name) => fs.lstatSync(name).isDirectory()
  ? fs.readdirSync(name).flatMap((child) => walk(path.join(name, child))) : [name];
const files = process.argv.includes("--workspace")
  ? fs.readdirSync(".").filter((name) => fs.lstatSync(name).isFile()).concat(walk("scripts"))
  : execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean);
const errors = [];
for (const file of new Set(files)) {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
  if (/\p{Script=Han}/u.test(file)) errors.push(`${file}: filename`);
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) continue;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { continue; } // Binary assets are not authored text.
  text.split(/\r?\n/).forEach((line, index) => {
    if (/\p{Script=Han}/u.test(line)) errors.push(`${file}:${index + 1}`);
  });
}
if (errors.length) {
  console.error(`English-only check failed:\n${errors.join("\n")}`);
  process.exitCode = 1;
} else console.log("English-only check passed (no Han text in maintained files).");

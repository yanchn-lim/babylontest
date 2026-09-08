import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

const revision = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
export default defineConfig({
  base: "./",
  define: { __APP_REVISION__: JSON.stringify(revision) },
});

import assert from "node:assert";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isNativeAvailable } from "../../wreq-js.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bundle = resolve(projectRoot, "dist", "wreq-js.js");

/**
 * Run `script` against a copy of the built bundle placed somewhere the native
 * addon cannot be resolved from: outside the repository, so `../rust/*.node` is
 * absent, and outside any `node_modules`, so the `@wreq-js/binding-*` packages
 * are not reachable either.
 */
async function runWithoutAddon(script: (specifier: string) => string): Promise<string> {
  const dir = mkdtempSync(resolve(tmpdir(), "wreq-js-no-addon-"));

  try {
    const copied = resolve(dir, "wreq-js.mjs");
    copyFileSync(bundle, copied);

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script(`file://${copied}`)],
      { cwd: dir },
    );

    return stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("native addon loading", () => {
  test("isNativeAvailable() reports the addon this suite runs against", () => {
    assert.strictEqual(isNativeAvailable(), true);
  });

  test("importing the package does not throw when the addon is missing", async (t) => {
    if (!existsSync(bundle)) {
      t.skip("dist bundle not built");
      return;
    }

    // Importing a module that throws takes down the host process at startup and
    // leaves an embedder no way to recover, so the addon must load on first use
    // rather than at module scope.
    const output = await runWithoutAddon(
      (specifier) => `await import(${JSON.stringify(specifier)}); console.log("imported");`,
    );

    assert.strictEqual(output, "imported");
  });

  test("isNativeAvailable() returns false when the addon is missing", async (t) => {
    if (!existsSync(bundle)) {
      t.skip("dist bundle not built");
      return;
    }

    const output = await runWithoutAddon(
      (specifier) =>
        `const m = await import(${JSON.stringify(specifier)}); console.log(String(m.isNativeAvailable()));`,
    );

    assert.strictEqual(output, "false");
  });

  test("using the library without the addon throws the load error", async (t) => {
    if (!existsSync(bundle)) {
      t.skip("dist bundle not built");
      return;
    }

    const output = await runWithoutAddon(
      (specifier) => `
        const m = await import(${JSON.stringify(specifier)});
        try {
          await m.fetch("http://127.0.0.1:1/");
          console.log("no-throw");
        } catch (error) {
          console.log(error instanceof Error ? error.message : String(error));
        }
      `,
    );

    assert.match(output, /Failed to load native module|Unsupported platform/);
  });
});

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startLocalTestServer } from "./helpers/local-test-server.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDir, "..", "..");
const httpTestDir = resolve(testDir, "http");
const httpTestFiles = existsSync(httpTestDir)
  ? readdirSync(httpTestDir)
      .filter((filename) => filename.endsWith(".spec.ts") || filename.endsWith(".spec.js"))
      .map((filename) => resolve(httpTestDir, filename))
      .sort()
  : [];

const unitTestDir = resolve(testDir, "unit");
const unitTestFiles = existsSync(unitTestDir)
  ? readdirSync(unitTestDir)
      .filter((filename) => filename.endsWith(".spec.ts") || filename.endsWith(".spec.js"))
      .map((filename) => resolve(unitTestDir, filename))
      .sort()
  : [];

async function main() {
  const extraArgs = process.argv.slice(2);
  const websocketTestFile = ["websocket.spec.ts", "websocket.spec.js"]
    .map((filename) => resolve(testDir, filename))
    .find((filename) => existsSync(filename));
  const defaultTestFiles = websocketTestFile
    ? [...unitTestFiles, ...httpTestFiles, websocketTestFile]
    : [...unitTestFiles, ...httpTestFiles];

  const normalizeArg = (arg: string): string => {
    const abs = resolve(process.cwd(), arg);
    if (abs.endsWith(".ts")) {
      const srcPrefix = `${resolve(projectRoot, "src")}/`;
      const jsCandidate = abs.startsWith(srcPrefix)
        ? resolve(projectRoot, "dist", abs.slice(srcPrefix.length).replace(/\.ts$/, ".js"))
        : abs.replace(/\.ts$/, ".js");

      return existsSync(jsCandidate) ? jsCandidate : abs;
    }

    if (abs.endsWith(".js") && !existsSync(abs)) {
      const tsCandidate = abs.replace(/\.js$/, ".ts");
      return existsSync(tsCandidate) ? tsCandidate : abs;
    }
    return abs;
  };

  const normalizedExtraArgs = Array.from(new Set(extraArgs.map(normalizeArg)));

  const env = { ...process.env };

  const localServer = await startLocalTestServer();
  env.HTTP_TEST_BASE_URL = localServer.httpBaseUrl;
  env.WS_TEST_URL = localServer.wsUrl;
  env.HTTPS_SELF_SIGNED_URL = localServer.httpsSelfSignedUrl;
  env.HTTPS_EXPIRED_URL = localServer.httpsExpiredUrl;
  env.HTTPS_CUSTOM_CA_URL = localServer.httpsCustomCaUrl;
  env.SSL_CERT_FILE = resolve(testDir, "helpers", "certs", "default-paths-root.crt");
  env.SSL_CERT_DIR = mkdtempSync(resolve(tmpdir(), "wreq-js-empty-cert-dir-"));

  const nodeArgs = ["--import", "tsx", "--test", ...defaultTestFiles, ...normalizedExtraArgs];
  const testProcess = spawn(process.execPath, nodeArgs, {
    stdio: "inherit",
    env,
  });

  const cleanup = async () => {
    try {
      await localServer.close();
    } catch (error) {
      console.error("Failed to stop local test server:", error);
    }
  };

  testProcess.once("exit", async (code, signal) => {
    await cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  testProcess.once("error", async (error) => {
    console.error("Failed to run tests:", error);
    await cleanup();
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

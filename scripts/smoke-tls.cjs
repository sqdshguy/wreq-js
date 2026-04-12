const { fetch } = require("../dist/wreq-js.cjs");

const urls = ["https://example.com", "https://iana.org"];

async function main() {
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        browser: "chrome_145",
        timeout: 15_000,
      });
      if (!response.ok) {
        throw new Error(`Unexpected status ${response.status} ${response.statusText}`);
      }
      console.log(`tls-smoke-ok ${url} -> ${response.status}`);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`tls-smoke-fail ${url}\n${message}`);
      process.exit(1);
    }
  }
}

main();

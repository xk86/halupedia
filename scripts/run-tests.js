#!/usr/bin/env node

/**
 * Test runner wrapper that:
 * 1. Suppresses logging noise during test execution
 * 2. Captures test results
 * 3. Prints a clean summary report
 * 4. Forces clean exit to prevent hanging
 */

import { spawn } from "child_process";
import { resolve } from "path";

const isDry = process.argv.includes("--dry-run");
const quiet = process.argv.includes("--quiet");

async function runTests() {
  const cwd = resolve(import.meta.url, "../../");

  console.log("🧪 Running test suite...\n");
  const startTime = Date.now();

  // Run tests with suppressed logging
  const env = {
    ...process.env,
    LOG_LEVEL: quiet ? "error" : "warn",
    NODE_ENV: "test",
  };

  return new Promise((resolve) => {
    const testProcess = spawn(
      "node",
      ["--import", "tsx", "--test", "tests/**/*.test.ts"],
      {
        cwd,
        env,
        stdio: ["inherit", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    testProcess.stdout?.on("data", (data) => {
      stdout += data.toString();
      // Print only test result lines (✔, ✖) and errors
      const line = data.toString().trim();
      if (line.match(/^[✔✖]/)) {
        console.log(line);
      } else if (line.match(/^Error|^(At|Caused by)/) || line.includes("AssertionError")) {
        console.error(line);
      }
    });

    testProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
      const line = data.toString().trim();
      if (line && !line.includes("INF") && !line.includes("DBG")) {
        console.error(line);
      }
    });

    testProcess.on("close", (code) => {
      const elapsed = Date.now() - startTime;

      // Count test results
      const passed = (stdout.match(/✔/g) || []).length;
      const failed = (stdout.match(/✖/g) || []).length;
      const total = passed + failed;

      console.log("\n" + "=".repeat(60));
      console.log("📊 TEST SUMMARY");
      console.log("=".repeat(60));
      console.log(`Total:   ${total}`);
      console.log(`Passed:  ${passed} ✔`);
      console.log(`Failed:  ${failed} ${failed > 0 ? "✖" : ""}`);
      console.log(`Time:    ${(elapsed / 1000).toFixed(2)}s`);
      console.log("=".repeat(60) + "\n");

      if (code === 0) {
        console.log("✅ All tests passed!\n");
      } else {
        console.log("❌ Some tests failed\n");
      }

      // Force clean exit to prevent hanging
      process.exit(code ?? 0);
    });

    // Set timeout to force exit if tests hang
    setTimeout(() => {
      console.error("\n⚠️  Test timeout - forcing exit");
      testProcess.kill("SIGTERM");
      process.exit(124); // timeout exit code
    }, 5 * 60 * 1000); // 5 minute timeout
  });
}

runTests().catch((error) => {
  console.error("Test runner error:", error);
  process.exit(1);
});

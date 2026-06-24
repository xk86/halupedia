import { test } from "node:test";
import assert from "node:assert/strict";

import { MaintenanceScheduler } from "../src/server/maintenance";
import type { Logger } from "../src/server/logger";

function createMemoryLogger(): { logger: Logger; events: string[] } {
  const events: string[] = [];
  const logger: Logger = {
    debug(event) {
      events.push(event);
    },
    info(event) {
      events.push(event);
    },
    warn(event) {
      events.push(event);
    },
    error(event) {
      events.push(event);
    },
  };
  return { logger, events };
}

test("maintenance triggers coalesce while a task is already running", async () => {
  const { logger, events } = createMemoryLogger();
  const scheduler = new MaintenanceScheduler(logger);
  let runCount = 0;
  let finishRun!: () => void;

  scheduler.register({
    name: "homepage.refresh",
    nextDelayMs: () => 60_000,
    run: async () => {
      runCount += 1;
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
    },
  });

  scheduler.trigger("homepage.refresh", "first stale request");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runCount, 1);

  scheduler.trigger("homepage.refresh", "retry while pending");
  scheduler.trigger("homepage.refresh", "another retry while pending");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runCount, 1, "retries must not queue duplicate task runs");
  assert.ok(events.includes("maintenance.task_trigger_coalesced"));

  finishRun();
  await scheduler.shutdown();
});

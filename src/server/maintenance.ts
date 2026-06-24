import type { Logger } from "./logger";

export type MaintenanceTask = {
  name: string;
  run: () => Promise<void>;
  nextDelayMs: () => number;
};

type RegisteredTask = MaintenanceTask & {
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  stopped: boolean;
};

export class MaintenanceScheduler {
  private readonly tasks = new Map<string, RegisteredTask>();

  constructor(private readonly logger: Logger) {}

  register(task: MaintenanceTask): void {
    if (this.tasks.has(task.name)) {
      throw new Error(`maintenance task already registered: ${task.name}`);
    }
    const registered: RegisteredTask = {
      ...task,
      timer: null,
      running: null,
      stopped: false,
    };
    this.tasks.set(task.name, registered);
    this.logger.info("maintenance.task_registered", { task: task.name });
    this.schedule(registered, task.nextDelayMs());
  }

  trigger(name: string, reason: string): void {
    const task = this.tasks.get(name);
    if (!task || task.stopped) return;
    if (task.running) {
      this.logger.info("maintenance.task_trigger_coalesced", {
        task: name,
        reason,
      });
      return;
    }
    this.logger.info("maintenance.task_triggered", { task: name, reason });
    this.schedule(task, 0);
  }

  async shutdown(): Promise<void> {
    const running: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
      task.stopped = true;
      if (task.timer) clearTimeout(task.timer);
      task.timer = null;
      if (task.running) running.push(task.running);
    }
    if (running.length > 0) {
      this.logger.info("maintenance.shutdown_draining", {
        in_flight: running.length,
      });
      await Promise.allSettled(running);
    }
    this.logger.info("maintenance.shutdown_complete");
  }

  private schedule(task: RegisteredTask, delayMs: number): void {
    if (task.stopped) return;
    if (task.timer) clearTimeout(task.timer);
    const delay = Math.max(0, Math.floor(delayMs));
    this.logger.info("maintenance.task_scheduled", {
      task: task.name,
      delay_ms: delay,
    });
    task.timer = setTimeout(() => {
      task.timer = null;
      void this.runTask(task);
    }, delay);
    task.timer.unref?.();
  }

  private async runTask(task: RegisteredTask): Promise<void> {
    if (task.stopped) return;
    if (task.running) {
      this.logger.info("maintenance.task_run_coalesced", { task: task.name });
      return;
    }

    const startedAt = Date.now();
    this.logger.info("maintenance.task_start", { task: task.name });
    task.running = task
      .run()
      .then(() => {
        this.logger.info("maintenance.task_done", {
          task: task.name,
          duration_ms: Date.now() - startedAt,
        });
      })
      .catch((error) => {
        this.logger.error("maintenance.task_failed", {
          task: task.name,
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        task.running = null;
        this.schedule(task, task.nextDelayMs());
      });
    await task.running;
  }
}

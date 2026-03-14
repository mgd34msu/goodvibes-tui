// ============================================
// Simple Task Scheduler in TypeScript
// ============================================

type TaskStatus = "pending" | "running" | "completed" | "failed";
type TaskPriority = "low" | "medium" | "high";

interface Task {
  id: string;
  name: string;
  priority: TaskPriority;
  status: TaskStatus;
  scheduledAt: Date;
  executedAt?: Date;
  completedAt?: Date;
  interval?: number; // For recurring tasks (in ms)
  retries: number;
  maxRetries: number;
  execute: () => Promise<void>;
}

interface TaskOptions {
  name: string;
  priority?: TaskPriority;
  scheduledAt?: Date;
  interval?: number;
  maxRetries?: number;
  execute: () => Promise<void>;
}

class TaskScheduler {
  private tasks: Map<string, Task> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running: boolean = false;
  private concurrency: number;
  private activeCount: number = 0;
  private queue: string[] = [];

  constructor(concurrency: number = 3) {
    this.concurrency = concurrency;
  }

  // ---------- ID Generator ----------
  private generateId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  // ---------- Add a Task ----------
  addTask(options: TaskOptions): string {
    const id = this.generateId();
    const task: Task = {
      id,
      name: options.name,
      priority: options.priority ?? "medium",
      status: "pending",
      scheduledAt: options.scheduledAt ?? new Date(),
      interval: options.interval,
      retries: 0,
      maxRetries: options.maxRetries ?? 0,
      execute: options.execute,
    };

    this.tasks.set(id, task);
    console.log(`[Scheduler] Task added: "${task.name}" (${id}) | Priority: ${task.priority}`);

    if (this.running) {
      this.scheduleTask(task);
    }

    return id;
  }

  // ---------- Remove a Task ----------
  removeTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      console.log(`[Scheduler] Task not found: ${id}`);
      return false;
    }

    // Clear any active timer
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    // Remove from queue
    this.queue = this.queue.filter((taskId) => taskId !== id);

    this.tasks.delete(id);
    console.log(`[Scheduler] Task removed: "${task.name}" (${id})`);
    return true;
  }

  // ---------- Schedule a Single Task ----------
  private scheduleTask(task: Task): void {
    const now = new Date();
    const delay = Math.max(0, task.scheduledAt.getTime() - now.getTime());

    const timer = setTimeout(() => {
      this.enqueue(task.id);
    }, delay);

    this.timers.set(task.id, timer);
  }

  // ---------- Enqueue and Process ----------
  private enqueue(taskId: string): void {
    this.queue.push(taskId);
    this.sortQueue();
    this.processQueue();
  }

  private sortQueue(): void {
    const priorityOrder: Record<TaskPriority, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };

    this.queue.sort((a, b) => {
      const taskA = this.tasks.get(a);
      const taskB = this.tasks.get(b);
      if (!taskA || !taskB) return 0;
      return priorityOrder[taskA.priority] - priorityOrder[taskB.priority];
    });
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && this.activeCount < this.concurrency) {
      const taskId = this.queue.shift();
      if (!taskId) break;

      const task = this.tasks.get(taskId);
      if (!task || task.status === "running") continue;

      this.activeCount++;
      this.runTask(task).finally(() => {
        this.activeCount--;
        this.processQueue();
      });
    }
  }

  // ---------- Run a Task ----------
  private async runTask(task: Task): Promise<void> {
    task.status = "running";
    task.executedAt = new Date();
    console.log(`[Scheduler] ▶ Running: "${task.name}" (${task.id})`);

    try {
      await task.execute();
      task.status = "completed";
      task.completedAt = new Date();
      const duration = task.completedAt.getTime() - task.executedAt.getTime();
      console.log(`[Scheduler] ✅ Completed: "${task.name}" (${task.id}) in ${duration}ms`);

      // Handle recurring tasks
      if (task.interval && task.interval > 0) {
        this.rescheduleRecurring(task);
      }
    } catch (error) {
      task.retries++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Scheduler] ❌ Failed: "${task.name}" (${task.id}) - ${errorMsg}`);

      if (task.retries <= task.maxRetries) {
        console.log(
          `[Scheduler] 🔄 Retrying "${task.name}" (${task.retries}/${task.maxRetries})...`
        );
        task.status = "pending";
        const backoffDelay = Math.min(1000 * Math.pow(2, task.retries - 1), 30000);
        const timer = setTimeout(() => {
          this.enqueue(task.id);
        }, backoffDelay);
        this.timers.set(task.id, timer);
      } else {
        task.status = "failed";
        console.error(
          `[Scheduler] 💀 Task permanently failed: "${task.name}" (${task.id}) after ${task.maxRetries} retries`
        );
      }
    }
  }

  // ---------- Reschedule Recurring Task ----------
  private rescheduleRecurring(task: Task): void {
    task.status = "pending";
    task.scheduledAt = new Date(Date.now() + (task.interval ?? 0));
    task.retries = 0;
    console.log(
      `[Scheduler] 🔁 Recurring task "${task.name}" rescheduled for ${task.scheduledAt.toISOString()}`
    );
    this.scheduleTask(task);
  }

  // ---------- Start the Scheduler ----------
  start(): void {
    if (this.running) {
      console.log("[Scheduler] Already running.");
      return;
    }

    this.running = true;
    console.log("[Scheduler] 🚀 Scheduler started.");

    // Schedule all pending tasks
    for (const task of this.tasks.values()) {
      if (task.status === "pending") {
        this.scheduleTask(task);
      }
    }
  }

  // ---------- Stop the Scheduler ----------
  stop(): void {
    this.running = false;

    // Clear all timers
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    this.queue = [];
    console.log("[Scheduler] 🛑 Scheduler stopped.");
  }

  // ---------- Get Task Info ----------
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  // ---------- List All Tasks ----------
  listTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  // ---------- Get Stats ----------
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  } {
    const tasks = this.listTasks();
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      running: tasks.filter((t) => t.status === "running").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
    };
  }
}

// ============================================
// Demo / Usage
// ============================================

async function main() {
  const scheduler = new TaskScheduler(2); // Max 2 concurrent tasks

  // Add a simple one-time task
  scheduler.addTask({
    name: "Send welcome email",
    priority: "high",
    execute: async () => {
      await sleep(500);
      console.log("  📧 Welcome email sent!");
    },
  });

  // Add a task that will fail and retry
  scheduler.addTask({
    name: "Sync database",
    priority: "medium",
    maxRetries: 2,
    execute: async () => {
      await sleep(300);
      if (Math.random() < 0.5) {
        throw new Error("Connection timeout");
      }
      console.log("  🗄️ Database synced!");
    },
  });

  // Add a delayed task
  scheduler.addTask({
    name: "Generate report",
    priority: "low",
    scheduledAt: new Date(Date.now() + 2000), // 2 seconds from now
    execute: async () => {
      await sleep(800);
      console.log("  📊 Report generated!");
    },
  });

  // Add a recurring task
  scheduler.addTask({
    name: "Health check",
    priority: "low",
    interval: 5000, // Every 5 seconds
    execute: async () => {
      await sleep(100);
      console.log("  💓 Health check passed!");
    },
  });

  // Start the scheduler
  scheduler.start();

  // Print stats periodically
  const statsInterval = setInterval(() => {
    const stats = scheduler.getStats();
    console.log(`\n[Stats] Total: ${stats.total} | Pending: ${stats.pending} | Running: ${stats.running} | Completed: ${stats.completed} | Failed: ${stats.failed}\n`);
  }, 3000);

  // Stop after 15 seconds
  setTimeout(() => {
    clearInterval(statsInterval);
    scheduler.stop();
    console.log("\n[Demo] Final stats:", scheduler.getStats());
    console.log("[Demo] All tasks:", scheduler.listTasks().map((t) => `${t.name} (${t.status})`));
  }, 15000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);

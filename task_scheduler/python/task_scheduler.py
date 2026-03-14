"""
============================================
Simple Task Scheduler in Python
============================================
"""

import asyncio
import uuid
import time
import math
from enum import Enum
from dataclasses import dataclass, field
from typing import Callable, Awaitable, Optional
from datetime import datetime, timedelta


# ============================================
# Enums
# ============================================

class TaskStatus(Enum):
    PENDING = "Pending"
    RUNNING = "Running"
    COMPLETED = "Completed"
    FAILED = "Failed"


class TaskPriority(Enum):
    HIGH = 0
    MEDIUM = 1
    LOW = 2


# ============================================
# Task
# ============================================

@dataclass
class Task:
    id: str
    name: str
    priority: TaskPriority
    status: TaskStatus
    scheduled_at: datetime
    execute_fn: Callable[[], Awaitable[None]]
    interval: Optional[timedelta] = None
    retries: int = 0
    max_retries: int = 0
    executed_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    def __str__(self) -> str:
        return f'Task("{self.name}", id={self.id[:8]}..., status={self.status.value}, priority={self.priority.name})'


# ============================================
# Scheduler Stats
# ============================================

@dataclass
class SchedulerStats:
    total: int = 0
    pending: int = 0
    running: int = 0
    completed: int = 0
    failed: int = 0

    def __str__(self) -> str:
        return (
            f"Total: {self.total} | Pending: {self.pending} | "
            f"Running: {self.running} | Completed: {self.completed} | "
            f"Failed: {self.failed}"
        )


# ============================================
# Task Scheduler
# ============================================

class TaskScheduler:
    def __init__(self, concurrency: int = 3):
        self._tasks: dict[str, Task] = {}
        self._queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._concurrency = concurrency
        self._semaphore = asyncio.Semaphore(concurrency)
        self._running = False
        self._workers: list[asyncio.Task] = []
        self._timers: dict[str, asyncio.Task] = []
        self._worker_event = asyncio.Event()

    # ---------- Add a Task ----------
    def add_task(
        self,
        name: str,
        execute_fn: Callable[[], Awaitable[None]],
        priority: TaskPriority = TaskPriority.MEDIUM,
        delay: Optional[timedelta] = None,
        interval: Optional[timedelta] = None,
        max_retries: int = 0,
    ) -> str:
        task_id = str(uuid.uuid4())
        scheduled_at = datetime.now() + delay if delay else datetime.now()

        task = Task(
            id=task_id,
            name=name,
            priority=priority,
            status=TaskStatus.PENDING,
            scheduled_at=scheduled_at,
            execute_fn=execute_fn,
            interval=interval,
            max_retries=max_retries,
        )

        self._tasks[task_id] = task
        print(f'[Scheduler] Task added: "{name}" ({task_id[:8]}...) | Priority: {priority.name}')

        if self._running:
            self._schedule_task(task)

        return task_id

    # ---------- Remove a Task ----------
    def remove_task(self, task_id: str) -> bool:
        task = self._tasks.pop(task_id, None)
        if task is None:
            print(f"[Scheduler] Task not found: {task_id}")
            return False

        # Cancel any pending timer
        timer = self._timers.pop(task_id, None) if isinstance(self._timers, dict) else None
        if timer and not timer.done():
            timer.cancel()

        print(f'[Scheduler] Task removed: "{task.name}" ({task_id[:8]}...)')
        return True

    # ---------- Schedule a Single Task ----------
    def _schedule_task(self, task: Task) -> None:
        now = datetime.now()
        delay_seconds = max(0.0, (task.scheduled_at - now).total_seconds())

        async def _delayed_enqueue():
            if delay_seconds > 0:
                await asyncio.sleep(delay_seconds)
            # Priority queue sorts by first element of tuple (lower = higher priority)
            await self._queue.put((task.priority.value, task.scheduled_at.timestamp(), task.id))
            self._worker_event.set()

        timer_task = asyncio.create_task(_delayed_enqueue())
        if not isinstance(self._timers, dict):
            self._timers = {}
        self._timers[task.id] = timer_task

    # ---------- Run a Task ----------
    async def _run_task(self, task: Task) -> None:
        task.status = TaskStatus.RUNNING
        task.executed_at = datetime.now()
        print(f'[Scheduler] ▶ Running: "{task.name}" ({task.id[:8]}...)')

        start = time.monotonic()

        try:
            await task.execute_fn()
            elapsed = time.monotonic() - start
            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            print(f'[Scheduler] ✅ Completed: "{task.name}" ({task.id[:8]}...) in {elapsed*1000:.0f}ms')

            # Handle recurring tasks
            if task.interval is not None:
                self._reschedule_recurring(task)

        except Exception as e:
            elapsed = time.monotonic() - start
            task.retries += 1
            print(f'[Scheduler] ❌ Failed: "{task.name}" ({task.id[:8]}...) - {e}')

            if task.retries <= task.max_retries:
                backoff = min(1.0 * (2 ** (task.retries - 1)), 30.0)
                print(
                    f'[Scheduler] 🔄 Retrying "{task.name}" '
                    f"({task.retries}/{task.max_retries}) in {backoff:.1f}s..."
                )
                task.status = TaskStatus.PENDING
                task.scheduled_at = datetime.now() + timedelta(seconds=backoff)
                self._schedule_task(task)
            else:
                task.status = TaskStatus.FAILED
                print(
                    f'[Scheduler] 💀 Task permanently failed: "{task.name}" '
                    f"({task.id[:8]}...) after {task.max_retries} retries"
                )

    # ---------- Reschedule Recurring ----------
    def _reschedule_recurring(self, task: Task) -> None:
        task.status = TaskStatus.PENDING
        task.retries = 0
        task.scheduled_at = datetime.now() + task.interval
        print(
            f'[Scheduler] 🔁 Recurring task "{task.name}" rescheduled in {task.interval}'
        )
        self._schedule_task(task)

    # ---------- Worker Loop ----------
    async def _worker(self) -> None:
        while self._running:
            try:
                # Wait for an item with a timeout so we can check self._running
                try:
                    priority_val, timestamp, task_id = await asyncio.wait_for(
                        self._queue.get(), timeout=0.5
                    )
                except asyncio.TimeoutError:
                    continue

                task = self._tasks.get(task_id)
                if task is None or task.status != TaskStatus.PENDING:
                    continue

                async with self._semaphore:
                    await self._run_task(task)

            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[Scheduler] Worker error: {e}")

    # ---------- Start ----------
    async def start(self, num_workers: int = 0) -> None:
        if self._running:
            print("[Scheduler] Already running.")
            return

        self._running = True
        if not isinstance(self._timers, dict):
            self._timers = {}
        print("[Scheduler] 🚀 Scheduler started.")

        # Schedule all pending tasks
        for task in self._tasks.values():
            if task.status == TaskStatus.PENDING:
                self._schedule_task(task)

        # Spawn workers (at least as many as concurrency)
        worker_count = num_workers if num_workers > 0 else self._concurrency
        for i in range(worker_count):
            w = asyncio.create_task(self._worker())
            self._workers.append(w)

    # ---------- Stop ----------
    async def stop(self) -> None:
        self._running = False
        print("[Scheduler] 🛑 Scheduler stopped.")

        # Cancel workers
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()

        # Cancel timers
        if isinstance(self._timers, dict):
            for timer in self._timers.values():
                if not timer.done():
                    timer.cancel()
            self._timers.clear()

    # ---------- Get Task ----------
    def get_task(self, task_id: str) -> Optional[Task]:
        return self._tasks.get(task_id)

    # ---------- List Tasks ----------
    def list_tasks(self) -> list[Task]:
        return list(self._tasks.values())

    # ---------- Get Stats ----------
    def get_stats(self) -> SchedulerStats:
        tasks = self.list_tasks()
        return SchedulerStats(
            total=len(tasks),
            pending=sum(1 for t in tasks if t.status == TaskStatus.PENDING),
            running=sum(1 for t in tasks if t.status == TaskStatus.RUNNING),
            completed=sum(1 for t in tasks if t.status == TaskStatus.COMPLETED),
            failed=sum(1 for t in tasks if t.status == TaskStatus.FAILED),
        )


# ============================================
# Demo / Usage
# ============================================

import random


async def main():
    scheduler = TaskScheduler(concurrency=2)  # Max 2 concurrent tasks

    # --- Task 1: Simple one-time task (high priority) ---
    async def send_email():
        await asyncio.sleep(0.5)
        print("  📧 Welcome email sent!")

    scheduler.add_task(
        name="Send welcome email",
        execute_fn=send_email,
        priority=TaskPriority.HIGH,
    )

    # --- Task 2: Flaky task with retries ---
    async def sync_database():
        await asyncio.sleep(0.3)
        if random.random() < 0.5:
            raise RuntimeError("Connection timeout")
        print("  🗄️  Database synced!")

    scheduler.add_task(
        name="Sync database",
        execute_fn=sync_database,
        priority=TaskPriority.MEDIUM,
        max_retries=2,
    )

    # --- Task 3: Delayed task ---
    async def generate_report():
        await asyncio.sleep(0.8)
        print("  📊 Report generated!")

    scheduler.add_task(
        name="Generate report",
        execute_fn=generate_report,
        priority=TaskPriority.LOW,
        delay=timedelta(seconds=2),
    )

    # --- Task 4: Recurring health check ---
    async def health_check():
        await asyncio.sleep(0.1)
        print("  💓 Health check passed!")

    scheduler.add_task(
        name="Health check",
        execute_fn=health_check,
        priority=TaskPriority.LOW,
        interval=timedelta(seconds=5),
    )

    # Start the scheduler
    await scheduler.start()

    # Print stats periodically
    async def print_stats():
        while True:
            await asyncio.sleep(3)
            stats = scheduler.get_stats()
            print(f"\n[Stats] {stats}\n")

    stats_task = asyncio.create_task(print_stats())

    # Run for 15 seconds
    await asyncio.sleep(15)

    # Stop
    stats_task.cancel()
    await scheduler.stop()

    # Final stats
    stats = scheduler.get_stats()
    print(f"\n[Demo] Final stats: {stats}")
    print("[Demo] All tasks:")
    for task in scheduler.list_tasks():
        print(f"  - {task.name} ({task.id[:8]}...) [{task.status.value}]")


if __name__ == "__main__":
    asyncio.run(main())

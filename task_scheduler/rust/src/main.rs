// ============================================
// Simple Task Scheduler in Rust
// ============================================

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};
use tokio::time::sleep;
use uuid::Uuid;

// ============================================
// Types & Enums
// ============================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

impl fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TaskStatus::Pending => write!(f, "Pending"),
            TaskStatus::Running => write!(f, "Running"),
            TaskStatus::Completed => write!(f, "Completed"),
            TaskStatus::Failed => write!(f, "Failed"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TaskPriority {
    Low = 0,
    Medium = 1,
    High = 2,
}

impl fmt::Display for TaskPriority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TaskPriority::Low => write!(f, "Low"),
            TaskPriority::Medium => write!(f, "Medium"),
            TaskPriority::High => write!(f, "High"),
        }
    }
}

// ============================================
// Task Function Type
// ============================================

type TaskFn = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

// ============================================
// Task
// ============================================

#[derive(Clone)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub priority: TaskPriority,
    pub status: TaskStatus,
    pub scheduled_at: Instant,
    pub interval: Option<Duration>,
    pub retries: u32,
    pub max_retries: u32,
    execute_fn: TaskFn,
}

impl Task {
    pub fn new(
        name: impl Into<String>,
        priority: TaskPriority,
        scheduled_at: Instant,
        interval: Option<Duration>,
        max_retries: u32,
        execute_fn: TaskFn,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            priority,
            status: TaskStatus::Pending,
            scheduled_at,
            interval,
            retries: 0,
            max_retries,
            execute_fn,
        }
    }

    pub async fn execute(&self) -> Result<(), String> {
        (self.execute_fn)().await
    }
}

impl fmt::Debug for Task {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Task")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("priority", &self.priority)
            .field("status", &self.status)
            .field("retries", &self.retries)
            .field("max_retries", &self.max_retries)
            .finish()
    }
}

// ============================================
// Scheduled Entry (for the priority queue)
// ============================================

#[derive(Clone)]
struct ScheduledEntry {
    task_id: String,
    priority: TaskPriority,
    scheduled_at: Instant,
}

// BinaryHeap is a max-heap, so we reverse ordering for scheduled_at
// (earlier time = higher priority) and keep priority as-is (higher = better)
impl Eq for ScheduledEntry {}

impl PartialEq for ScheduledEntry {
    fn eq(&self, other: &Self) -> bool {
        self.task_id == other.task_id
    }
}

impl Ord for ScheduledEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        // Higher priority first, then earlier scheduled time
        self.priority
            .cmp(&other.priority)
            .then_with(|| other.scheduled_at.cmp(&self.scheduled_at))
    }
}

impl PartialOrd for ScheduledEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// ============================================
// Scheduler Stats
// ============================================

#[derive(Debug, Clone)]
pub struct SchedulerStats {
    pub total: usize,
    pub pending: usize,
    pub running: usize,
    pub completed: usize,
    pub failed: usize,
}

impl fmt::Display for SchedulerStats {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Total: {} | Pending: {} | Running: {} | Completed: {} | Failed: {}",
            self.total, self.pending, self.running, self.completed, self.failed
        )
    }
}

// ============================================
// Scheduler Inner State
// ============================================

struct SchedulerState {
    tasks: Vec<Task>,
    queue: BinaryHeap<ScheduledEntry>,
    active_count: usize,
    running: bool,
}

impl SchedulerState {
    fn new() -> Self {
        Self {
            tasks: Vec::new(),
            queue: BinaryHeap::new(),
            active_count: 0,
            running: false,
        }
    }

    fn find_task_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.id == id)
    }

    fn find_task(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }

    fn stats(&self) -> SchedulerStats {
        SchedulerStats {
            total: self.tasks.len(),
            pending: self.tasks.iter().filter(|t| t.status == TaskStatus::Pending).count(),
            running: self.tasks.iter().filter(|t| t.status == TaskStatus::Running).count(),
            completed: self.tasks.iter().filter(|t| t.status == TaskStatus::Completed).count(),
            failed: self.tasks.iter().filter(|t| t.status == TaskStatus::Failed).count(),
        }
    }
}

// ============================================
// Task Scheduler
// ============================================

pub struct TaskScheduler {
    state: Arc<Mutex<SchedulerState>>,
    concurrency: usize,
    notify: Arc<Notify>,
}

impl TaskScheduler {
    pub fn new(concurrency: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(SchedulerState::new())),
            concurrency,
            notify: Arc::new(Notify::new()),
        }
    }

    // ---------- Add a Task ----------
    pub async fn add_task(
        &self,
        name: impl Into<String>,
        priority: TaskPriority,
        delay: Option<Duration>,
        interval: Option<Duration>,
        max_retries: u32,
        execute_fn: TaskFn,
    ) -> String {
        let scheduled_at = match delay {
            Some(d) => Instant::now() + d,
            None => Instant::now(),
        };

        let task = Task::new(name, priority, scheduled_at, interval, max_retries, execute_fn);
        let id = task.id.clone();
        let task_name = task.name.clone();

        let mut state = self.state.lock().await;

        state.queue.push(ScheduledEntry {
            task_id: id.clone(),
            priority: task.priority,
            scheduled_at: task.scheduled_at,
        });

        state.tasks.push(task);

        println!("[Scheduler] Task added: \"{}\" ({}) | Priority: {}", task_name, id, priority);

        // Notify the worker loop
        self.notify.notify_one();

        id
    }

    // ---------- Remove a Task ----------
    pub async fn remove_task(&self, id: &str) -> bool {
        let mut state = self.state.lock().await;

        if let Some(pos) = state.tasks.iter().position(|t| t.id == id) {
            let task = state.tasks.remove(pos);
            // Remove from queue (rebuild without this task)
            let entries: Vec<ScheduledEntry> = state
                .queue
                .drain()
                .filter(|e| e.task_id != id)
                .collect();
            state.queue = entries.into_iter().collect();
            println!("[Scheduler] Task removed: \"{}\" ({})", task.name, id);
            true
        } else {
            println!("[Scheduler] Task not found: {}", id);
            false
        }
    }

    // ---------- Get Stats ----------
    pub async fn get_stats(&self) -> SchedulerStats {
        let state = self.state.lock().await;
        state.stats()
    }

    // ---------- List Tasks ----------
    pub async fn list_tasks(&self) -> Vec<(String, String, TaskStatus)> {
        let state = self.state.lock().await;
        state
            .tasks
            .iter()
            .map(|t| (t.id.clone(), t.name.clone(), t.status))
            .collect()
    }

    // ---------- Start the Scheduler ----------
    pub async fn start(self: &Arc<Self>) {
        {
            let mut state = self.state.lock().await;
            if state.running {
                println!("[Scheduler] Already running.");
                return;
            }
            state.running = true;
        }

        println!("[Scheduler] 🚀 Scheduler started.");

        let scheduler = Arc::clone(self);
        tokio::spawn(async move {
            scheduler.worker_loop().await;
        });
    }

    // ---------- Stop the Scheduler ----------
    pub async fn stop(&self) {
        let mut state = self.state.lock().await;
        state.running = false;
        println!("[Scheduler] 🛑 Scheduler stopped.");
        // Wake the worker so it can exit
        self.notify.notify_one();
    }

    // ---------- Worker Loop ----------
    async fn worker_loop(self: &Arc<Self>) {
        loop {
            // Wait for a notification or check periodically
            tokio::select! {
                _ = self.notify.notified() => {},
                _ = sleep(Duration::from_millis(100)) => {},
            }

            let running = {
                let state = self.state.lock().await;
                state.running
            };

            if !running {
                break;
            }

            // Process as many tasks as concurrency allows
            loop {
                let task_to_run = {
                    let mut state = self.state.lock().await;

                    if state.active_count >= self.concurrency {
                        break;
                    }

                    // Find the next ready task
                    let now = Instant::now();
                    let mut ready_entry: Option<ScheduledEntry> = None;

                    // Peek and check if the top entry is ready
                    let mut temp: Vec<ScheduledEntry> = Vec::new();
                    while let Some(entry) = state.queue.pop() {
                        // Check if task still exists and is pending
                        let task_exists = state
                            .find_task(&entry.task_id)
                            .map(|t| t.status == TaskStatus::Pending)
                            .unwrap_or(false);

                        if !task_exists {
                            continue; // Skip stale entries
                        }

                        if entry.scheduled_at <= now && ready_entry.is_none() {
                            ready_entry = Some(entry);
                        } else {
                            temp.push(entry);
                        }
                    }

                    // Put remaining entries back
                    for e in temp {
                        state.queue.push(e);
                    }

                    if let Some(entry) = ready_entry {
                        // Mark task as running
                        if let Some(task) = state.find_task_mut(&entry.task_id) {
                            task.status = TaskStatus::Running;
                            state.active_count += 1;
                            Some(task.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                match task_to_run {
                    Some(task) => {
                        let scheduler = Arc::clone(self);
                        tokio::spawn(async move {
                            scheduler.run_task(task).await;
                        });
                    }
                    None => break,
                }
            }
        }

        println!("[Scheduler] Worker loop exited.");
    }

    // ---------- Run a Task ----------
    async fn run_task(self: &Arc<Self>, task: Task) {
        let task_id = task.id.clone();
        let task_name = task.name.clone();

        println!("[Scheduler] ▶ Running: \"{}\" ({})", task_name, task_id);
        let start_time = Instant::now();

        let result = task.execute().await;
        let duration = start_time.elapsed();

        let mut state = self.state.lock().await;
        state.active_count -= 1;

        match result {
            Ok(()) => {
                if let Some(t) = state.find_task_mut(&task_id) {
                    t.status = TaskStatus::Completed;
                    println!(
                        "[Scheduler] ✅ Completed: \"{}\" ({}) in {:?}",
                        task_name, task_id, duration
                    );

                    // Handle recurring tasks
                    if let Some(interval) = t.interval {
                        t.status = TaskStatus::Pending;
                        t.retries = 0;
                        t.scheduled_at = Instant::now() + interval;
                        let scheduled_at = t.scheduled_at;
                        let priority = t.priority;
                        state.queue.push(ScheduledEntry {
                            task_id: task_id.clone(),
                            priority,
                            scheduled_at,
                        });
                        println!(
                            "[Scheduler] 🔁 Recurring task \"{}\" rescheduled in {:?}",
                            task_name, interval
                        );
                    }
                }
            }
            Err(e) => {
                if let Some(t) = state.find_task_mut(&task_id) {
                    t.retries += 1;
                    println!(
                        "[Scheduler] ❌ Failed: \"{}\" ({}) - {}",
                        task_name, task_id, e
                    );

                    if t.retries <= t.max_retries {
                        let retry_count = t.retries;
                        let max = t.max_retries;
                        let backoff = Duration::from_millis(
                            (1000 * 2u64.pow(retry_count - 1)).min(30_000),
                        );
                        t.status = TaskStatus::Pending;
                        t.scheduled_at = Instant::now() + backoff;
                        let scheduled_at = t.scheduled_at;
                        let priority = t.priority;
                        state.queue.push(ScheduledEntry {
                            task_id: task_id.clone(),
                            priority,
                            scheduled_at,
                        });
                        println!(
                            "[Scheduler] 🔄 Retrying \"{}\" ({}/{}) in {:?}",
                            task_name, retry_count, max, backoff
                        );
                    } else {
                        t.status = TaskStatus::Failed;
                        println!(
                            "[Scheduler] 💀 Task permanently failed: \"{}\" ({}) after {} retries",
                            task_name, task_id, t.max_retries
                        );
                    }
                }
            }
        }

        // Notify worker to check for more tasks
        self.notify.notify_one();
    }
}

// ============================================
// Demo / Usage
// ============================================

#[tokio::main]
async fn main() {
    let scheduler = Arc::new(TaskScheduler::new(2)); // Max 2 concurrent tasks

    // --- Task 1: Simple one-time task (high priority) ---
    scheduler
        .add_task(
            "Send welcome email",
            TaskPriority::High,
            None,            // No delay
            None,            // Not recurring
            0,               // No retries
            Arc::new(|| {
                Box::pin(async {
                    sleep(Duration::from_millis(500)).await;
                    println!("  📧 Welcome email sent!");
                    Ok(())
                })
            }),
        )
        .await;

    // --- Task 2: Flaky task with retries ---
    scheduler
        .add_task(
            "Sync database",
            TaskPriority::Medium,
            None,
            None,
            2, // Up to 2 retries
            Arc::new(|| {
                Box::pin(async {
                    sleep(Duration::from_millis(300)).await;
                    let fail = rand_bool();
                    if fail {
                        Err("Connection timeout".to_string())
                    } else {
                        println!("  🗄️  Database synced!");
                        Ok(())
                    }
                })
            }),
        )
        .await;

    // --- Task 3: Delayed task ---
    scheduler
        .add_task(
            "Generate report",
            TaskPriority::Low,
            Some(Duration::from_secs(2)), // 2 second delay
            None,
            0,
            Arc::new(|| {
                Box::pin(async {
                    sleep(Duration::from_millis(800)).await;
                    println!("  📊 Report generated!");
                    Ok(())
                })
            }),
        )
        .await;

    // --- Task 4: Recurring health check ---
    scheduler
        .add_task(
            "Health check",
            TaskPriority::Low,
            None,
            Some(Duration::from_secs(5)), // Every 5 seconds
            0,
            Arc::new(|| {
                Box::pin(async {
                    sleep(Duration::from_millis(100)).await;
                    println!("  💓 Health check passed!");
                    Ok(())
                })
            }),
        )
        .await;

    // Start the scheduler
    scheduler.start().await;

    // Print stats periodically
    let stats_scheduler = Arc::clone(&scheduler);
    let stats_handle = tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(3)).await;
            let stats = stats_scheduler.get_stats().await;
            println!("\n[Stats] {}\n", stats);
        }
    });

    // Run for 15 seconds
    sleep(Duration::from_secs(15)).await;

    // Stop
    scheduler.stop().await;
    stats_handle.abort();

    // Final stats
    let stats = scheduler.get_stats().await;
    println!("\n[Demo] Final stats: {}", stats);

    let tasks = scheduler.list_tasks().await;
    println!("[Demo] All tasks:");
    for (id, name, status) in &tasks {
        println!("  - {} ({}) [{}]", name, id, status);
    }
}

// Simple pseudo-random bool (no extra deps needed)
fn rand_bool() -> bool {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    nanos % 2 == 0
}

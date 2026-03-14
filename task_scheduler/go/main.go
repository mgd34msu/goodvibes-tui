// ============================================
// Simple Task Scheduler in Go
// ============================================

package main

import (
	"container/heap"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ============================================
// Enums / Constants
// ============================================

type TaskStatus int

const (
	StatusPending TaskStatus = iota
	StatusRunning
	StatusCompleted
	StatusFailed
)

func (s TaskStatus) String() string {
	switch s {
	case StatusPending:
		return "Pending"
	case StatusRunning:
		return "Running"
	case StatusCompleted:
		return "Completed"
	case StatusFailed:
		return "Failed"
	default:
		return "Unknown"
	}
}

type TaskPriority int

const (
	PriorityHigh TaskPriority = iota
	PriorityMedium
	PriorityLow
)

func (p TaskPriority) String() string {
	switch p {
	case PriorityHigh:
		return "High"
	case PriorityMedium:
		return "Medium"
	case PriorityLow:
		return "Low"
	default:
		return "Unknown"
	}
}

// ============================================
// Task
// ============================================

type Task struct {
	ID          string
	Name        string
	Priority    TaskPriority
	Status      TaskStatus
	ScheduledAt time.Time
	ExecutedAt  time.Time
	CompletedAt time.Time
	Interval    time.Duration // 0 means non-recurring
	Retries     int
	MaxRetries  int
	ExecuteFn   func() error
}

// ============================================
// Priority Queue (min-heap by priority, then scheduled time)
// ============================================

type QueueEntry struct {
	TaskID      string
	Priority    TaskPriority
	ScheduledAt time.Time
	Index       int // used by heap.Interface
}

type PriorityQueue []*QueueEntry

func (pq PriorityQueue) Len() int { return len(pq) }

func (pq PriorityQueue) Less(i, j int) bool {
	// Lower priority value = higher priority
	if pq[i].Priority != pq[j].Priority {
		return pq[i].Priority < pq[j].Priority
	}
	// Earlier scheduled time first
	return pq[i].ScheduledAt.Before(pq[j].ScheduledAt)
}

func (pq PriorityQueue) Swap(i, j int) {
	pq[i], pq[j] = pq[j], pq[i]
	pq[i].Index = i
	pq[j].Index = j
}

func (pq *PriorityQueue) Push(x interface{}) {
	entry := x.(*QueueEntry)
	entry.Index = len(*pq)
	*pq = append(*pq, entry)
}

func (pq *PriorityQueue) Pop() interface{} {
	old := *pq
	n := len(old)
	entry := old[n-1]
	old[n-1] = nil
	entry.Index = -1
	*pq = old[:n-1]
	return entry
}

// ============================================
// Scheduler Stats
// ============================================

type SchedulerStats struct {
	Total     int
	Pending   int
	Running   int
	Completed int
	Failed    int
}

func (s SchedulerStats) String() string {
	return fmt.Sprintf(
		"Total: %d | Pending: %d | Running: %d | Completed: %d | Failed: %d",
		s.Total, s.Pending, s.Running, s.Completed, s.Failed,
	)
}

// ============================================
// Task Scheduler
// ============================================

type TaskScheduler struct {
	mu          sync.Mutex
	tasks       map[string]*Task
	queue       PriorityQueue
	concurrency int
	running     bool
	stopCh      chan struct{}
	enqueueCh   chan struct{} // signals new items in queue
	wg          sync.WaitGroup
	semaphore   chan struct{} // concurrency limiter
}

func NewTaskScheduler(concurrency int) *TaskScheduler {
	return &TaskScheduler{
		tasks:       make(map[string]*Task),
		queue:       make(PriorityQueue, 0),
		concurrency: concurrency,
		stopCh:      make(chan struct{}),
		enqueueCh:   make(chan struct{}, 100),
		semaphore:   make(chan struct{}, concurrency),
	}
}

// ---------- Add a Task ----------

type TaskOptions struct {
	Name       string
	Priority   TaskPriority
	Delay      time.Duration
	Interval   time.Duration
	MaxRetries int
	ExecuteFn  func() error
}

func (s *TaskScheduler) AddTask(opts TaskOptions) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := uuid.New().String()
	scheduledAt := time.Now()
	if opts.Delay > 0 {
		scheduledAt = scheduledAt.Add(opts.Delay)
	}

	task := &Task{
		ID:          id,
		Name:        opts.Name,
		Priority:    opts.Priority,
		Status:      StatusPending,
		ScheduledAt: scheduledAt,
		Interval:    opts.Interval,
		MaxRetries:  opts.MaxRetries,
		ExecuteFn:   opts.ExecuteFn,
	}

	s.tasks[id] = task

	heap.Push(&s.queue, &QueueEntry{
		TaskID:      id,
		Priority:    task.Priority,
		ScheduledAt: task.ScheduledAt,
	})

	fmt.Printf("[Scheduler] Task added: %q (%s) | Priority: %s\n", task.Name, id[:8], task.Priority)

	// Signal the worker
	select {
	case s.enqueueCh <- struct{}{}:
	default:
	}

	return id
}

// ---------- Remove a Task ----------

func (s *TaskScheduler) RemoveTask(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	task, exists := s.tasks[id]
	if !exists {
		fmt.Printf("[Scheduler] Task not found: %s\n", id)
		return false
	}

	delete(s.tasks, id)
	fmt.Printf("[Scheduler] Task removed: %q (%s)\n", task.Name, id[:8])
	return true
}

// ---------- Get Stats ----------

func (s *TaskScheduler) GetStats() SchedulerStats {
	s.mu.Lock()
	defer s.mu.Unlock()

	stats := SchedulerStats{Total: len(s.tasks)}
	for _, t := range s.tasks {
		switch t.Status {
		case StatusPending:
			stats.Pending++
		case StatusRunning:
			stats.Running++
		case StatusCompleted:
			stats.Completed++
		case StatusFailed:
			stats.Failed++
		}
	}
	return stats
}

// ---------- List Tasks ----------

func (s *TaskScheduler) ListTasks() []*Task {
	s.mu.Lock()
	defer s.mu.Unlock()

	tasks := make([]*Task, 0, len(s.tasks))
	for _, t := range s.tasks {
		tasks = append(tasks, t)
	}
	return tasks
}

// ---------- Start ----------

func (s *TaskScheduler) Start() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		fmt.Println("[Scheduler] Already running.")
		return
	}
	s.running = true
	s.mu.Unlock()

	fmt.Println("[Scheduler] 🚀 Scheduler started.")

	s.wg.Add(1)
	go s.workerLoop()
}

// ---------- Stop ----------

func (s *TaskScheduler) Stop() {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	s.running = false
	s.mu.Unlock()

	close(s.stopCh)
	s.wg.Wait()
	fmt.Println("[Scheduler] 🛑 Scheduler stopped.")
}

// ---------- Worker Loop ----------

func (s *TaskScheduler) workerLoop() {
	defer s.wg.Done()

	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-s.enqueueCh:
			s.processQueue()
		case <-ticker.C:
			s.processQueue()
		}
	}
}

func (s *TaskScheduler) processQueue() {
	for {
		s.mu.Lock()

		if s.queue.Len() == 0 {
			s.mu.Unlock()
			return
		}

		// Peek at the top entry
		entry := s.queue[0]
		now := time.Now()

		// Not yet ready
		if entry.ScheduledAt.After(now) {
			s.mu.Unlock()
			return
		}

		// Pop the entry
		heap.Pop(&s.queue)

		// Validate task still exists and is pending
		task, exists := s.tasks[entry.TaskID]
		if !exists || task.Status != StatusPending {
			s.mu.Unlock()
			continue
		}

		task.Status = StatusRunning
		task.ExecutedAt = now
		s.mu.Unlock()

		// Acquire semaphore (blocks if at concurrency limit)
		select {
		case s.semaphore <- struct{}{}:
		case <-s.stopCh:
			return
		}

		s.wg.Add(1)
		go func(t *Task) {
			defer s.wg.Done()
			defer func() { <-s.semaphore }()
			s.runTask(t)
		}(task)
	}
}

// ---------- Run a Task ----------

func (s *TaskScheduler) runTask(task *Task) {
	fmt.Printf("[Scheduler] ▶ Running: %q (%s)\n", task.Name, task.ID[:8])
	startTime := time.Now()

	err := task.ExecuteFn()
	elapsed := time.Since(startTime)

	s.mu.Lock()
	defer s.mu.Unlock()

	// Task may have been removed while running
	if _, exists := s.tasks[task.ID]; !exists {
		return
	}

	if err == nil {
		task.Status = StatusCompleted
		task.CompletedAt = time.Now()
		fmt.Printf("[Scheduler] ✅ Completed: %q (%s) in %v\n", task.Name, task.ID[:8], elapsed.Round(time.Millisecond))

		// Handle recurring tasks
		if task.Interval > 0 {
			task.Status = StatusPending
			task.Retries = 0
			task.ScheduledAt = time.Now().Add(task.Interval)
			heap.Push(&s.queue, &QueueEntry{
				TaskID:      task.ID,
				Priority:    task.Priority,
				ScheduledAt: task.ScheduledAt,
			})
			fmt.Printf("[Scheduler] 🔁 Recurring task %q rescheduled in %v\n", task.Name, task.Interval)

			select {
			case s.enqueueCh <- struct{}{}:
			default:
			}
		}
	} else {
		task.Retries++
		fmt.Printf("[Scheduler] ❌ Failed: %q (%s) - %v\n", task.Name, task.ID[:8], err)

		if task.Retries <= task.MaxRetries {
			backoffSec := math.Min(math.Pow(2, float64(task.Retries-1)), 30)
			backoff := time.Duration(backoffSec * float64(time.Second))
			fmt.Printf("[Scheduler] 🔄 Retrying %q (%d/%d) in %v...\n",
				task.Name, task.Retries, task.MaxRetries, backoff)

			task.Status = StatusPending
			task.ScheduledAt = time.Now().Add(backoff)
			heap.Push(&s.queue, &QueueEntry{
				TaskID:      task.ID,
				Priority:    task.Priority,
				ScheduledAt: task.ScheduledAt,
			})

			select {
			case s.enqueueCh <- struct{}{}:
			default:
			}
		} else {
			task.Status = StatusFailed
			fmt.Printf("[Scheduler] 💀 Task permanently failed: %q (%s) after %d retries\n",
				task.Name, task.ID[:8], task.MaxRetries)
		}
	}
}

// ============================================
// Demo / Usage
// ============================================

func main() {
	scheduler := NewTaskScheduler(2) // Max 2 concurrent tasks

	// --- Task 1: Simple one-time task (high priority) ---
	scheduler.AddTask(TaskOptions{
		Name:     "Send welcome email",
		Priority: PriorityHigh,
		ExecuteFn: func() error {
			time.Sleep(500 * time.Millisecond)
			fmt.Println("  📧 Welcome email sent!")
			return nil
		},
	})

	// --- Task 2: Flaky task with retries ---
	scheduler.AddTask(TaskOptions{
		Name:       "Sync database",
		Priority:   PriorityMedium,
		MaxRetries: 2,
		ExecuteFn: func() error {
			time.Sleep(300 * time.Millisecond)
			if rand.Float64() < 0.5 {
				return fmt.Errorf("connection timeout")
			}
			fmt.Println("  🗄️  Database synced!")
			return nil
		},
	})

	// --- Task 3: Delayed task ---
	scheduler.AddTask(TaskOptions{
		Name:     "Generate report",
		Priority: PriorityLow,
		Delay:    2 * time.Second,
		ExecuteFn: func() error {
			time.Sleep(800 * time.Millisecond)
			fmt.Println("  📊 Report generated!")
			return nil
		},
	})

	// --- Task 4: Recurring health check ---
	scheduler.AddTask(TaskOptions{
		Name:     "Health check",
		Priority: PriorityLow,
		Interval: 5 * time.Second,
		ExecuteFn: func() error {
			time.Sleep(100 * time.Millisecond)
			fmt.Println("  💓 Health check passed!")
			return nil
		},
	})

	// Start the scheduler
	scheduler.Start()

	// Print stats periodically
	stopStats := make(chan struct{})
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopStats:
				return
			case <-ticker.C:
				stats := scheduler.GetStats()
				fmt.Printf("\n[Stats] %s\n\n", stats)
			}
		}
	}()

	// Run for 15 seconds
	time.Sleep(15 * time.Second)

	// Stop
	close(stopStats)
	scheduler.Stop()

	// Final stats
	stats := scheduler.GetStats()
	fmt.Printf("\n[Demo] Final stats: %s\n", stats)
	fmt.Println("[Demo] All tasks:")
	for _, t := range scheduler.ListTasks() {
		fmt.Printf("  - %s (%s) [%s]\n", t.Name, t.ID[:8], t.Status)
	}
}

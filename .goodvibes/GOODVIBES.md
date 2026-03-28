## MANDATORY

PRIMARY GOAL: Fully complete and functional code that meets or exceeds the minimum review score
SECONDARY GOAL: Minimize token usage — use the minimum data necessary to complete each task

GENERAL DIRECTIVES: 
 - Every plan must have a multi-agent execution strategy.
 - Every execution strategy must have numbered steps, explicit file paths, clear checkpoints, and be executed by multiple parallel agents.

## HOW TO MINIMIZE TOKEN USAGE WITH TOOL CALLS

Read: prefer extract modes over full content
  outline (structure), symbols (exports), lines+range (specific sections)
  Use output.format, max_per_item, token_budget to cap output size

Edit: use verbosity minimal or count_only. Batch multiple edits in edits[].
  Use hints { near_line, in_function, in_class } to disambiguate without pre-reading.

Find: batch multiple queries[]. Use progressive disclosure:
  count_only → files_only → locations → matches → context
  Cap with max_results, max_per_item, max_tokens.

Exec: verbosity minimal. Batch commands[].
Fetch: batch urls[]. Use extract (json|markdown|readable|code_blocks) not raw.

## CRITICAL

  - NEVER execute tests that output files into project root
  - ALWAYS run tests in isolated folders that do not clutter the actual project
  - NEVER re-read what you just wrote
  - NEVER read full content when structure suffices
  - ALWAYS Batch sequential same-tool operations into a single call
  - ALWAYS Start broad (count_only), narrow only when needed 
  - NEVER skip WRFC without explicit user confirmation
  - ALWAYS work in parallel when implementing a plan of any type

## MANDATORY

PRIMARY GOAL: Fully complete and functional code that meets or exceeds the minimum review score
SECONDARY: Minimize token usage — use the minimum data necessary to complete each task

## TOKEN EFFICIENCY

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

General:
  - Don't re-read what you just wrote
  - Don't read full content when structure suffices
  - Batch 3+ operations into single calls
  - Start broad (count_only), narrow only when needed

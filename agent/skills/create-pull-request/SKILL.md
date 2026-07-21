---
name: create-pull-request
description: Inspect staged changes in the current git repository, create a new branch, push it to origin, and open a pull request via gh CLI with a detailed description of what changed. Use when the user wants to create a PR from staged or uncommitted work.
---

# Create Pull Request

Creates a new branch from staged changes and opens a PR via `gh`.

## Usage

```bash
bash "$SKILL_DIR/scripts/pr.sh"
```

The script will:
1. Check for staged changes
2. Create a descriptive branch name from the changes
3. Commit, push to origin
4. Open a PR via `gh pr create` with a detailed body

## Requirements

- `git` and `gh` must be available
- The repository must have an `origin` remote
- Changes should be staged (`git add`) before running

#!/usr/bin/env bash
# pr.sh — Create a branch from staged changes and open a PR via gh.
# Usage: pr.sh [branch_name] [--base <branch>] [--title <title>]
#   Without args: shows staged changes for review.
#   With branch_name: creates branch, pushes, opens PR.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(git -C "$REPO_ROOT" remote get-url origin | sed -E 's|.*github[.:]||; s|\.git$||')"
REMOTE="origin"

# --- Pre-flight checks ---

if ! command -v gh &>/dev/null; then
    echo "ERROR: gh (GitHub CLI) not found. Install it first." >&2
    exit 1
fi

if ! gh auth status &>/dev/null 2>&1; then
    echo "ERROR: gh is not authenticated. Run 'gh auth login' first." >&2
    exit 1
fi

# --- Parse arguments ---
BRANCH=""
BASE_BRANCH=""
PR_TITLE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --base)  BASE_BRANCH="$2"; shift 2 ;;
        --title) PR_TITLE="$2"; shift 2 ;;
        --*)     echo "Unknown option: $1" >&2; exit 1 ;;
        *)       BRANCH="$1"; shift ;;
    esac
done

# --- Phase 1: No branch name — show diagnostics ---
if [[ -z "$BRANCH" ]]; then
    echo "=== STAGED CHANGES ==="
    STAGED=$(git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null || true)
    if [[ -z "$STAGED" ]]; then
        echo "No staged changes found."
        UNSTAGED=$(git -C "$REPO_ROOT" diff --name-only 2>/dev/null || true)
        if [[ -n "$UNSTAGED" ]]; then
            echo ""
            echo "=== UNSTAGED CHANGES ==="
            echo "$UNSTAGED"
            echo ""
            echo "Run 'git add <files>' to stage changes before creating a PR."
        fi
        exit 0
    fi
    echo "$STAGED"
    echo ""
    echo "=== DIFF ==="
    git -C "$REPO_ROOT" diff --cached
    echo ""
    echo "=== REMOTE ==="
    git -C "$REPO_ROOT" remote -v
    echo ""
    echo "=== BRANCH ==="
    git -C "$REPO_ROOT" branch --show-current
    exit 0
fi

# --- Phase 2: Create branch, commit, push, open PR ---

echo "=== CREATING BRANCH: $BRANCH ==="

# Create or switch to branch
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "Branch '$BRANCH' already exists locally. Switching to it."
    git -C "$REPO_ROOT" checkout "$BRANCH"
else
    git -C "$REPO_ROOT" checkout -b "$BRANCH"
    echo "Created branch '$BRANCH'."
fi

# Stage everything
git -C "$REPO_ROOT" add -A

# Check there are actual changes
if git -C "$REPO_ROOT" diff --cached --quiet; then
    echo "No changes to commit on this branch."
    exit 0
fi

# Commit
COMMIT_MSG="${PR_TITLE:-$BRANCH}"
git -C "$REPO_ROOT" commit -m "$COMMIT_MSG"
echo "Committed: $COMMIT_MSG"

# Push
echo ""
echo "=== PUSHING BRANCH ==="
git -C "$REPO_ROOT" push -u "${REMOTE}/${BRANCH}" --force-if-needed
echo "Pushed to ${REMOTE}/${BRANCH}"

# --- Determine base branch ---
if [[ -z "$BASE_BRANCH" ]]; then
    BASE_BRANCH=$(git -C "$REPO_ROOT" remote show "$REMOTE" 2>/dev/null | grep "HEAD branch" | awk '{print $NF}')
    if [[ -z "$BASE_BRANCH" ]]; then
        BASE_BRANCH="main"
    fi
fi
echo "Target base branch: $BASE_BRANCH"

# --- Build PR body ---
echo ""
echo "=== BUILDING PR BODY ==="

BODY_TMP=$(mktemp)

{
    echo "# Changes"
    echo ""

    CHANGED_FILES=$(git -C "$REPO_ROOT" diff HEAD~1 --name-only)
    FILE_COUNT=$(echo "$CHANGED_FILES" | grep -c . || true)
    echo "**Files changed:** $FILE_COUNT"
    echo ""

    while IFS= read -r f; do
        [[ -z "$f" ]] && continue

        # Determine change type
        if git -C "$REPO_ROOT" diff HEAD~1 HEAD --diff-filter=A -- "$f" &>/dev/null; then
            CTYPE="Added"
        elif git -C "$REPO_ROOT" diff HEAD~1 HEAD --diff-filter=D -- "$f" &>/dev/null; then
            CTYPE="Deleted"
        elif git -C "$REPO_ROOT" diff HEAD~1 HEAD --diff-filter=R -- "$f" &>/dev/null; then
            CTYPE="Renamed"
        else
            CTYPE="Modified"
        fi

        # Get file-level diff
        FILE_DIFF=$(git -C "$REPO_ROOT" diff HEAD~1 HEAD -- "$f" 2>/dev/null || true)
        ADDS=$(echo "$FILE_DIFF" | grep -c '^\+' 2>/dev/null || echo "0")
        DELS=$(echo "$FILE_DIFF" | grep -c '^\-' 2>/dev/null || echo "0")

        echo "### $CTYPE: \`$f\` (+$ADDS/-$DELS)"
        echo ""

        # Diff preview (first 80 lines)
        DIFF_PREVIEW=$(echo "$FILE_DIFF" | head -80)
        if [[ -n "$DIFF_PREVIEW" ]]; then
            echo '```diff'
            echo "$DIFF_PREVIEW"
            echo '```'
        fi
        echo ""
    done <<< "$CHANGED_FILES"
} > "$BODY_TMP"

echo "=== PR BODY PREVIEW ==="
head -30 "$BODY_TMP"
echo "..."

# --- Create the PR ---
echo ""
echo "=== CREATING PULL REQUEST ==="

PR_OUTPUT=$(gh pr create \
    --repo "$REPO_NAME" \
    --title "$BRANCH" \
    --body-file "$BODY_TMP" \
    --head "$BRANCH" \
    --base "$BASE_BRANCH" \
    2>&1 || true)

rm -f "$BODY_TMP"

echo "$PR_OUTPUT"

# Extract PR URL
PR_URL=$(echo "$PR_OUTPUT" | grep -oE 'https://github\.com/[^ ]+' | head -1)
if [[ -n "$PR_URL" ]]; then
    echo ""
    echo "=== PR CREATED: $PR_URL ==="
fi

/**
 * Destructive Operations Guard
 *
 * Intercepts and asks for confirmation before potentially destructive operations:
 *   - Bash: rm -rf, sudo, chmod/chown 777, dd, mkfs, truncate, > file, etc.
 *   - File writes: overwriting .env, .git/config, and other sensitive files
 *   - Session actions: clearing session, switching with unsaved work
 *
 * Configure via the settings below. Commands matching the allowlist bypass
 * the confirmation prompt entirely.
 */

import type {
  ExtensionAPI,
  SessionBeforeSwitchEvent,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

// ── Configuration ──────────────────────────────────────────────────────────

/** Regex patterns that trigger a confirmation prompt for bash commands. */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-rf|--recursive\s+-f|-fr)\b/i,        // rm -rf, rm -r -f, rm -fr
  /\bsudo\b/i,                                    // sudo anything
  /\b(chmod|chown)\b.*\b777\b/i,                  // chmod/chown 777
  /\bdd\b/i,                                      // dd (disk destroyer)
  /\bmkfs\b/i,                                    // mkfs (format disk)
  /\btruncate\s+-s\s+0\b/i,                      // truncate file to zero
  /\b>+\s*\/dev\/\w/i,                            // redirect to /dev/*
  /\bshred\b/i,                                   // shred (secure delete)
  /\bwipe\b/i,                                    // wipe
  /\bfstrim\b/i,                                  // fstrim
  /\bswapoff\b/i,                                 // swapoff
  /\bgit\s+checkout\s+(-f|--force)\b/i,           // git checkout -f (discard changes)
  /\bgit\s+reset\s+--hard\b/i,                    // git reset --hard (discard commits)
];

/** Paths that always require confirmation before write/edit. */
const PROTECTED_PATHS: string[] = [
  ".env",
  ".git/config",
  ".ssh/",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".aws/",
  ".gcp/",
  ".kube/",
  "docker-compose.yml",
  "Dockerfile",
];

// No allowlist — all destructive commands require confirmation.

// ── Helpers ────────────────────────────────────────────────────────────────

/** Check if a bash command matches any dangerous pattern. */
function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

/** Check if a file path is protected. */
function isProtectedPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "");
  return PROTECTED_PATHS.some((p) => {
    if (p.endsWith("/")) {
      return normalized === p.slice(0, -1) || normalized.startsWith(p);
    }
    return normalized === p || normalized.endsWith("/" + p);
  });
}

/** Get a human-readable reason for why a command was flagged. */
function getDangerReason(command: string): string {
  if (/\brm\s+(-rf|--recursive\s+-f|-fr)\b/i.test(command))
    return "Recursive force delete — will permanently remove files";
  if (/\bsudo\b/i.test(command)) return "Running with elevated (root) privileges";
  if (/\b(chmod|chown)\b.*\b777\b/i.test(command))
    return "Setting world-readable/writable/executable permissions";
  if (/\bdd\b/i.test(command) && !/\bdd\s+--help/i.test(command))
    return "Direct disk write — can corrupt data or overwrite partitions";
  if (/\bmkfs\b/i.test(command)) return "Formatting a disk partition";
  if (/\btruncate\s+-s\s+0\b/i.test(command))
    return "Truncating file to zero bytes — data loss";
  if (/\b>+\s*\/dev\/\w/i.test(command))
    return "Writing directly to a device file — can corrupt the system";
  if (/\bshred\b/i.test(command)) return "Securely overwriting file contents";
  if (/\bwipe\b/i.test(command)) return "Wiping file contents";
  if (/\bfstrim\b/i.test(command)) return "Trimming SSD blocks — can cause data loss on some setups";
  if (/\bswapoff\b/i.test(command)) return "Disabling swap — can cause OOM crashes";
  if (/\bgit\s+checkout\s+(-f|--force)\b/i.test(command)) return "Discarding all working tree changes";
  if (/\bgit\s+reset\s+--hard\b/i.test(command)) return "Resetting branch to commit — discards all local changes";
  return "Potentially destructive command";
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Bash command interception ──────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    if (!command) return undefined;

    // Dangerous pattern: ask for confirmation
    if (isDangerousCommand(command)) {
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `Blocked: ${getDangerReason(command)} (no UI for confirmation)`,
        };
      }

      const reason = getDangerReason(command);
      const choice = await ctx.ui.select(
        `⚠️  Destructive command detected\n\n  ${reason}\n\n  Command:\n  ${command}\n\nAllow?`,
        ["Yes, run it", "No, cancel"],
      );

      if (choice !== "Yes, run it") {
        return { block: true, reason: "Blocked by user" };
      }
    }

    return undefined;
  });

  // ── File write/edit interception ───────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const path = event.input.path as string;
    if (!path) return undefined;

    if (isProtectedPath(path)) {
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `Blocked write to protected path: ${path}`,
        };
      }

      const choice = await ctx.ui.select(
        `🔒 Protected file detected\n\n  Path: ${path}\n\nWrite to this file?`,
        ["Yes, write anyway", "No, cancel"],
      );

      if (choice !== "Yes, write anyway") {
        return { block: true, reason: `Blocked write to protected path: ${path}` };
      }
    }

    return undefined;
  });

  // ── Session action interception ────────────────────────────────────────

  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
    if (!ctx.hasUI) return;

    if (event.reason === "new") {
      const confirmed = await ctx.ui.confirm(
        "🗑️  Clear session?",
        "This will delete all messages in the current session. This cannot be undone.",
      );

      if (!confirmed) {
        ctx.ui.notify("Clear cancelled", "info");
        return { cancel: true };
      }
      return;
    }

    // reason === "resume" — check for unsaved work
    const entries = ctx.sessionManager.getEntries();
    const hasUnsavedWork = entries.some(
      (e): e is SessionMessageEntry =>
        e.type === "message" && e.message.role === "user",
    );

    if (hasUnsavedWork) {
      const confirmed = await ctx.ui.confirm(
        "🔄 Switch session?",
        "You have unsaved messages in the current session. Switch anyway?",
      );

      if (!confirmed) {
        ctx.ui.notify("Switch cancelled", "info");
        return { cancel: true };
      }
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const choice = await ctx.ui.select(
      `🌿 Fork from entry ${event.entryId.slice(0, 8)}?`,
      ["Yes, create fork", "No, stay in current session"],
    );

    if (choice !== "Yes, create fork") {
      ctx.ui.notify("Fork cancelled", "info");
      return { cancel: true };
    }
  });
}

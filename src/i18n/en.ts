import type { Messages } from "./messages.ts";

const HELP_EN = `ccleanup - interactive cleanup of Claude Code sessions

Usage:
  ccleanup [options]

With no option, opens an interactive list of the sessions in ~/.claude/projects, sorted
by size. Mark the ones to delete, then confirm.

Keys:
  up/down, j/k      move            PgUp/PgDn, g/G    page, top, bottom
  space             mark, then follow the way you last moved
  a                 mark all, or unmark all
  o                 mark sessions older than --older-than (14d by default)
  s, S              change the sort (size, age, project), reverse the order
  /                 search by project, title, folder or id (esc clears)
  i                 details of the session under the cursor
  ?                 help and legend
  enter             delete the marked sessions (with confirmation)
  e                 show deletion errors
  q, esc            quit (Ctrl+C twice, Ctrl+Z to suspend)

Options:
  -l, --list              print the list, no interactive UI
      --older-than <d>    only target sessions older than <d> (12h, 14d, 2w, 3m)
      --min-size <s>      only target sessions bigger than <s> (100K, 500M, 1G)
  -y, --yes               delete the targeted sessions without UI (requires a filter)
  -n, --dry-run           show what would be deleted, delete nothing
      --include-recent    allow deleting sessions modified less than 30 min ago
                          (never those open in Claude Code)
      --claude-dir <dir>  Claude config folder, repeatable (default: those that exist among
                          $CLAUDE_CONFIG_DIR, ~/.claude and $XDG_CONFIG_HOME/claude or ~/.config/claude)

Reminder:
      --install-reminder  install a systemd timer that notifies when there is cleaning to do
      --every <p>         reminder period: daily, weekly (default) or monthly
      --notify-above <s>  notification threshold (default: 1G)
      --uninstall-reminder  remove the timer
      --check             what the reminder runs, by hand: summarize what can be cleaned
                          (14d by default), delete nothing
      --notify            with --check: desktop notification above the threshold

  -h, --help              show this help
  -v, --version           show the version

Environment:
  CCLEANUP_LANG=fr|en     interface language (default: system locale)
  CCLEANUP_NOTIFY=<cmd>   notification command, which receives the text, then the title
                          (default: notify-send)
  CCLEANUP_ASCII=1        draw the interface with ASCII only
  NO_COLOR, FORCE_COLOR   disable or force colors
`;

/**
 * English plural ending: only one takes the singular.
 *
 * @param count - Number the word refers to
 * @returns An empty string for one, "s" otherwise, zero included
 */
function pluralEn(count: number): string {
    return count === 1 ? "" : "s";
}

/**
 * English texts of the interface.
 */
export const en: Messages = {
    help: HELP_EN,
    subtitle: "Claude Code sessions",
    columns: { size: "SIZE", age: "AGE", project: "PROJECT", title: "TITLE" },
    stats: { sessions: "Sessions", marked: "Marked", releasable: "Releasable", freed: "Freed" },
    olderTag: (days) => `over ${days} d`,
    totalLine: (count, size) => `${count} session${pluralEn(count)}, ${size}`,
    scanning: (done, total) => `Scanning  ${done}/${total}`,
    scanDone: (count, duration) => `${count} session${pluralEn(count)} scanned in ${duration}`,
    deleting: (done, total) => `Deleting  ${done}/${total}`,
    keys: {
        move: "move",
        mark: "mark",
        all: "all",
        none: "none",
        old: "old",
        sort: "sort",
        delete: "delete",
        quit: "quit",
        errors: "errors",
        yes: "yes",
        no: "no",
        scroll: "scroll",
        close: "close",
        stop: "stop",
        search: "search",
        details: "details",
        help: "help",
        clear: "clear",
        keep: "keep",
    },
    keyNames: {
        arrows: "arrows",
        space: "space",
        enter: "enter",
        esc: "esc",
        yes: "y",
        no: "n",
        sort: "s/S",
    },
    usage: {
        unknownOption: (option) => `Unknown option: ${option}`,
        missingValue: (option) => `Missing value for ${option}`,
        invalidValue: (option, value, expected) =>
            `Invalid value for ${option}: "${value}" (expected: ${expected})`,
        yesNeedsFilter:
            "--yes requires --older-than or --min-size, so it never deletes everything.",
        hint: "Run ccleanup --help for usage.",
        expected: {
            "--older-than": "12h, 14d, 2w, 3m",
            "--min-size": "100K, 500M, 1G",
            "--notify-above": "100K, 500M, 1G",
            "--every": "daily, weekly, monthly",
        },
    },
    refusing: (path) => `Refusing to delete outside the sessions: ${path}`,
    confirm: (count, size) => `Delete ${count} session${pluralEn(count)} (${size})?`,
    confirmHint: "[y/N]",
    confirmKeys: ["y"],
    confirmTitle: "Delete",
    confirmMore: (count) => `and ${count} more`,
    confirmHidden: (count) => `including ${count} hidden by the search`,
    confirmFinal: (count) =>
        count === 1
            ? "It can no longer be resumed with claude --resume."
            : "They can no longer be resumed with claude --resume.",
    guide: {
        title: "Help",
        sections: [
            {
                title: "Navigation",
                rows: [
                    ["up/down, j/k", "move"],
                    ["PgUp/PgDn", "previous, next page"],
                    ["g/G", "top, bottom of the list"],
                ],
            },
            {
                title: "Marking",
                rows: [
                    ["space", "mark, follow the way"],
                    ["a", "mark all, unmark all"],
                    ["o", "mark the old ones"],
                ],
            },
            {
                title: "List",
                rows: [
                    ["/", "search (project, title, folder, id)"],
                    ["s/S", "change the sort, reverse it"],
                    ["i", "details of the session"],
                ],
            },
            {
                title: "Deletion",
                rows: [
                    ["enter", "delete the marked ones"],
                    ["e", "deletion errors"],
                    ["esc", "close, clear the search"],
                    ["q", "quit"],
                ],
            },
        ],
        legendTitle: "Legend",
        legend: {
            marked: "marked",
            markable: "can be marked",
            open: "open in Claude Code, never deleted",
            recent: "changed less than 30 min ago, protected",
            recentAllowed: "changed less than 30 min ago (--include-recent)",
            sizes: "size: grey under 10 MB, orange from 100 MB, red from 1 GB",
        },
        close: "esc or ? to close",
    },
    details: {
        title: "Details",
        folder: "Folder",
        config: "Config",
        started: "Started",
        modified: "Modified",
        size: "Size",
        parts: {
            transcript: "transcript",
            folder: "folder",
            history: "history",
            env: "env",
            debug: "debug",
        },
        state: "State",
        states: {
            open: "open in Claude Code",
            recent: "recent",
            marked: "marked",
            idle: "idle",
        },
        resume: "Resume",
    },
    search: {
        prompt: "search",
        none: (query) => `No session matches "${query}".`,
        count: (shown, total) => `${shown} of ${total}`,
        clearHint: "esc to clear",
    },
    done: (count, size) => `${count} session${pluralEn(count)} deleted, ${size} freed.`,
    failed: (count) => `${count} deletion${pluralEn(count)} failed.`,
    stopping: "Stopping after the current session…",
    ctrlCAgain: "Ctrl+C once more to quit",
    errorsHint: (count) => `${count} error${pluralEn(count)}`,
    errorsTitle: (count) => `Deletion errors (${count})`,
    tooSmall: {
        title: "Terminal too small",
        needs: "needs",
        hint: "Make the window bigger, or press q to quit.",
    },
    exitFreed: (size, count) => `${size} freed, ${count} session${pluralEn(count)} deleted`,
    exitNothing: "Nothing deleted, see you next time.",
    exitTones: ["A little breathing room.", "Nice cleanup.", "Big cleanup!"],
    exitFailures: (count) => `${count} failure${pluralEn(count)}:`,
    updateAvailable: (latest, current) => `${latest} is available, you have ${current}:`,
    recent: "recent",
    recentProtected: "Recent session, maybe running: protected (see --include-recent).",
    open: "open",
    openProtected: "Session open in Claude Code: protected.",
    openSkipped: (count) => `${count} session${pluralEn(count)} opened meanwhile, kept.`,
    nothingMarked: "Nothing marked.",
    noSessions: (dirs) => `No Claude Code session found in ${dirs.join(", ")} (see --claude-dir).`,
    denied: (paths) => `Permission denied, check the access rights: ${paths.join(", ")}`,
    nothingMatches: "No session matches the filters.",
    wouldDelete: (count, size) =>
        `Would delete ${count} session${pluralEn(count)} (${size}). Nothing was deleted.`,
    checkLine: (count, days, size) =>
        `${count} session${pluralEn(count)} older than ${days} d can be cleaned: ${size}.`,
    checkNothing: (days) => `No session older than ${days} d.`,
    notifyTitle: "Claude Code sessions to clean",
    notifyBody: (count, days, size) =>
        `${size} in ${count} session${pluralEn(count)} older than ${days} d. Run "npx ccleanup".`,
    notifyFailed: "Could not send the notification (is notify-send installed?).",
    reminderInstalled: (every) => `${every} reminder installed (ccleanup-reminder.timer).`,
    reminderRemoved: "Reminder removed.",
    reminderDry: "Dry run: nothing was written or enabled.",
    reminderNeedsGlobal:
        "ccleanup is running from the npx cache, which is temporary. Install it first: npm i -g ccleanup",
    reminderNeedsSystemd: "The automatic reminder needs Linux with systemd.",
};

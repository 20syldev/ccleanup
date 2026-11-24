import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { messages } from "../i18n/messages.ts";
import { DAY, formatSize, type Lang } from "../lib/format.ts";

import { DEFAULT_OLDER_THAN, type Options } from "./args.ts";
import type { Session } from "./scan.ts";
import { matches } from "./select.ts";

/**
 * Runs a command without a shell and waits for it.
 *
 * @param file - Executable, looked up in PATH
 * @param args - Arguments, passed as is
 * @returns Its stdout and stderr; rejects on a non-zero exit or a missing command
 */
const run = promisify(execFile);

const UNIT = "ccleanup-reminder";

/**
 * Prints what `--check` would clean, and sends a notification when it is above the
 * threshold and `--notify` is set.
 *
 * @param sessions - Measured sessions
 * @param options - Parsed options: filters, notify flag and threshold
 * @param lang - Language of the messages
 * @param now - Reference time of the scan
 */
export async function check(
    sessions: Session[],
    options: Options,
    lang: Lang,
    now: number,
): Promise<void> {
    const m = messages(lang);
    const olderThan = options.olderThan ?? DEFAULT_OLDER_THAN;
    const days = Math.round(olderThan / DAY);
    const filter = {
        olderThan,
        minSize: options.minSize,
        includeRecent: options.includeRecent,
        now,
    };
    const targets = sessions.filter((session) => matches(session, filter));
    const bytes = targets.reduce((total, session) => total + session.bytes, 0);

    if (targets.length === 0) {
        console.log(m.checkNothing(days));
        return;
    }
    const size = formatSize(bytes, lang);
    console.log(m.checkLine(targets.length, days, size));

    if (options.notify && bytes >= options.notifyAbove) {
        const sent = await sendNotification(
            m.notifyTitle,
            m.notifyBody(targets.length, days, size),
        );
        if (!sent) console.error(m.notifyFailed);
    }
}

/**
 * Sends a desktop notification.
 *
 * @param title - Notification title
 * @param text - Notification body
 * @returns False when the command is missing or fails; $CCLEANUP_NOTIFY, when set, is run with the text then the title, else notify-send
 */
export async function sendNotification(title: string, text: string): Promise<boolean> {
    try {
        const custom = process.env.CCLEANUP_NOTIFY;
        if (custom) await run("sh", ["-c", `${custom} "$@"`, "ccleanup", text, title]);
        else await run("notify-send", ["--app-name=ccleanup", title, text]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Folder of the systemd user units.
 *
 * @returns $XDG_CONFIG_HOME/systemd/user, ~/.config by default
 */
function unitDir(): string {
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(base, "systemd", "user");
}

/**
 * Quotes a value for a systemd unit file.
 *
 * @param value - Raw value; backslashes and quotes are escaped, % is doubled so systemd does not expand it
 * @returns The value between double quotes
 */
function quote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/**
 * Writes the text of the reminder service and timer.
 *
 * @param cli - Absolute path of the installed cli.js
 * @param options - Parsed options: period and filter flags to repeat in the service
 * @param lang - Language the notifications keep, whatever the session locale
 * @returns Contents of the .service and .timer files
 */
function units(cli: string, options: Options, lang: Lang): { service: string; timer: string } {
    const environment = [`PATH=${process.env.PATH ?? ""}`, `CCLEANUP_LANG=${lang}`];

    // The service does not inherit the shell: carry the folder variables.
    for (const name of ["CCLEANUP_NOTIFY", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
        const value = process.env[name];
        if (value) environment.push(`${name}=${value}`);
    }
    const command = [process.execPath, cli, "--check", "--notify", ...options.reminderArgs]
        .map(quote)
        .join(" ");

    const service = [
        "[Unit]",
        "Description=Remind to clean old Claude Code sessions (ccleanup)",
        "",
        "[Service]",
        "Type=oneshot",
        ...environment.map((line) => `Environment=${quote(line)}`),
        `ExecStart=${command}`,
        "",
    ].join("\n");

    const timer = [
        "[Unit]",
        "Description=Periodic ccleanup reminder",
        "",
        "[Timer]",
        `OnCalendar=${options.every}`,
        "Persistent=true",
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
    ].join("\n");

    return { service, timer };
}

/**
 * Installs and enables the systemd user timer that runs `--check --notify`.
 *
 * With `--dry-run`, prints the units and the commands instead of writing anything.
 *
 * @param options - Parsed options: period, filters and dry-run flag
 * @param lang - Language of the messages and of the future notifications
 * @throws Error off Linux, or when ccleanup runs from the temporary npx cache
 */
export async function installReminder(options: Options, lang: Lang): Promise<void> {
    const m = messages(lang);
    if (process.platform !== "linux") throw new Error(m.reminderNeedsSystemd);

    const cli = await realpath(fileURLToPath(new URL("../cli.js", import.meta.url)));
    if (cli.includes("/_npx/")) throw new Error(m.reminderNeedsGlobal);

    const { service, timer } = units(cli, options, lang);
    const servicePath = join(unitDir(), `${UNIT}.service`);
    const timerPath = join(unitDir(), `${UNIT}.timer`);
    if (options.dryRun) {
        console.log(`# ${servicePath}\n${service}`);
        console.log(`# ${timerPath}\n${timer}`);
        console.log(
            `# systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}.timer`,
        );
        console.log(m.reminderDry);
        return;
    }

    await mkdir(unitDir(), { recursive: true });
    await writeFile(servicePath, service);
    await writeFile(timerPath, timer);
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", "--now", `${UNIT}.timer`]);
    console.log(m.reminderInstalled(options.every));
}

/**
 * Disables the reminder timer and removes its unit files.
 *
 * @param options - Parsed options; with --dry-run, only prints what would happen
 * @param lang - Language of the messages
 */
export async function uninstallReminder(options: Options, lang: Lang): Promise<void> {
    const m = messages(lang);
    const servicePath = join(unitDir(), `${UNIT}.service`);
    const timerPath = join(unitDir(), `${UNIT}.timer`);
    if (options.dryRun) {
        console.log(`# systemctl --user disable --now ${UNIT}.timer`);
        console.log(`# rm ${servicePath} ${timerPath}`);
        console.log(m.reminderDry);
        return;
    }

    // Disabling fails when the timer was never installed, which is fine here.
    await run("systemctl", ["--user", "disable", "--now", `${UNIT}.timer`]).catch(() => undefined);
    await rm(servicePath, { force: true });
    await rm(timerPath, { force: true });
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    console.log(m.reminderRemoved);
}

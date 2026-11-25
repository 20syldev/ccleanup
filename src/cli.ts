#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { type Options, parseArgs, UsageError } from "./core/args.ts";
import { findConfigDirs } from "./core/config.ts";
import { openSessions } from "./core/live.ts";
import { check, installReminder, uninstallReminder } from "./core/remind.ts";
import { removeSession, UnsafePathError } from "./core/remove.ts";
import { discover, scan, type Session } from "./core/scan.ts";
import { hasFilter, select, sortSessions } from "./core/select.ts";
import { startUpdateCheck } from "./core/update.ts";
import { type Messages, messages } from "./i18n/messages.ts";
import { detectLang, formatSize, type Lang, tildify } from "./lib/format.ts";
import { createTheme } from "./ui/theme.ts";
import { runTui } from "./ui/tui.ts";
import { exitSummary, table } from "./ui/view.ts";

const RECENT_MS = 30 * 60_000;

/**
 * Reads the version of the package.
 *
 * @returns The version field of package.json, one folder above the compiled cli.js
 */
function version(): string {
    const url = new URL("../package.json", import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}

/**
 * Prints the plain table of sessions, biggest first.
 *
 * @param sessions - Sessions to print
 * @param lang - Language of the headers and units
 * @param now - Time of the scan, for ages
 */
function printTable(sessions: Session[], lang: Lang, now: number): void {
    const theme = createTheme(process.stdout);
    const cols = process.stdout.columns || 120;
    for (const row of table(sortSessions(sessions, "size"), theme, lang, now, cols)) {
        console.log(row);
    }
}

/**
 * Explains an error in the language of the interface.
 *
 * @param error - Anything thrown: usage errors and refused paths are translated, others keep their message
 * @param m - Texts of the interface
 * @returns One line, without the program name
 */
function describeError(error: unknown, m: Messages): string {
    if (error instanceof UnsafePathError) return m.refusing(error.path);
    if (!(error instanceof UsageError))
        return error instanceof Error ? error.message : String(error);
    switch (error.code) {
        case "unknownOption":
            return m.usage.unknownOption(error.option);
        case "missingValue":
            return m.usage.missingValue(error.option);
        case "invalidValue":
            return m.usage.invalidValue(
                error.option,
                error.value ?? "",
                m.usage.expected[error.option] ?? "",
            );
        case "yesNeedsFilter":
            return m.usage.yesNeedsFilter;
    }
}

/**
 * Explains why no session was found: folders that refuse reading, or none to read.
 *
 * @param searched - Every config folder looked at
 * @param denied - Folders that exist but cannot be read
 * @param m - Messages in the language of the interface
 * @returns The exit code: 1 when a folder could not be read, else 0
 */
function reportEmpty(searched: string[], denied: string[], m: Messages): number {
    if (denied.length > 0) {
        console.error(m.denied(denied.map((path) => tildify(path))));
        return 1;
    }
    console.log(m.noSessions(searched.map((path) => tildify(path))));
    return 0;
}

/**
 * Deletes sessions without the interface, for --yes, keeping those opened since the scan.
 *
 * @param configDirs - Claude config folders the sessions were found in, for the re-check
 * @param sessions - Sessions to delete, in order
 * @param lang - Language of the summary
 * @returns Number of failed deletions, each already reported on stderr
 */
async function deleteAll(configDirs: string[], sessions: Session[], lang: Lang): Promise<number> {
    let deleted = 0;
    let failed = 0;
    let freed = 0;

    // A session may have opened during the scan: check again.
    const open = await openSessions(configDirs);
    const kept = sessions.filter((session) => open.has(session.id.toLowerCase()));
    if (kept.length > 0) console.log(messages(lang).openSkipped(kept.length));
    for (const session of sessions) {
        if (open.has(session.id.toLowerCase())) continue;
        try {
            await removeSession(session.configDir, session);
            deleted++;
            freed += session.bytes;
        } catch (error) {
            failed++;
            console.error(`${session.id}: ${describeError(error, messages(lang))}`);
        }
    }
    const m = messages(lang);
    console.log(m.done(deleted, formatSize(freed, lang)));
    if (failed > 0) console.error(m.failed(failed));
    return failed;
}

/**
 * Entry point: parses the options and runs the matching mode.
 *
 * @returns Exit code: 0 on success, 1 when a deletion failed
 * @throws UsageError for a bad command line
 */
async function main(): Promise<number> {
    const lang = detectLang();
    const m = messages(lang);
    const options: Options = parseArgs(process.argv.slice(2));

    if (options.help) {
        process.stdout.write(m.help);
        return 0;
    }
    if (options.version) {
        console.log(version());
        return 0;
    }
    if (options.installReminder) {
        await installReminder(options, lang);
        return 0;
    }
    if (options.uninstallReminder) {
        await uninstallReminder(options, lang);
        return 0;
    }
    if (options.yes && !hasFilter(options)) throw new UsageError("yesNeedsFilter", "--yes");

    const now = Date.now();
    const search = await findConfigDirs(options.claudeDirs);
    const denied = new Set(search.denied);
    const onDenied = (path: string) => denied.add(path);
    const interactive =
        Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
        process.env.TERM !== "dumb" &&
        !options.list &&
        !options.check &&
        !options.yes &&
        !options.dryRun;

    if (interactive) {
        // Measuring happens inside the interface, so it opens at once.
        const open = openSessions(search.dirs);
        const found = await Promise.all(search.dirs.map((dir) => discover(dir, onDenied)));
        const entries = found.flat();
        if (entries.length === 0) return reportEmpty(search.searched, [...denied], m);

        // Printed before the interface, so it stays after it.
        if (denied.size > 0) console.error(m.denied([...denied].map((path) => tildify(path))));

        // Runs while the interface is open, and is dropped on exit if still waiting.
        const current = version();
        const update = startUpdateCheck(current, { env: process.env, now });
        const result = await runTui({
            configDirs: search.dirs,
            entries,
            open,
            denied: [...denied].map((path) => tildify(path)),
            lang,
            version: current,
            now,
            recentMs: RECENT_MS,
            olderThan: options.olderThan,
            minSize: options.minSize,
            includeRecent: options.includeRecent,
        }).catch(async (error: unknown) => {
            await update.finish();
            throw error;
        });
        const latest = await update.finish();
        const notice = latest ? { latest, current, cols: process.stdout.columns || 80 } : undefined;
        for (const row of exitSummary(result, result.theme, lang, notice)) console.log(row);
        return result.errors.length > 0 ? 1 : 0;
    }

    const open = await openSessions(search.dirs);
    const sessions = await scan(search.dirs, { now, recentMs: RECENT_MS, open }, onDenied);
    if (sessions.length === 0) return reportEmpty(search.searched, [...denied], m);
    if (denied.size > 0) console.error(m.denied([...denied].map((path) => tildify(path))));
    if (options.check) {
        await check(sessions, options, lang, now);
        return 0;
    }

    const targets = select(sessions, {
        olderThan: options.olderThan,
        minSize: options.minSize,
        includeRecent: options.includeRecent,
        now,
    });

    if (options.yes || options.dryRun) {
        if (targets.length === 0) {
            console.log(m.nothingMatches);
            return 0;
        }
        printTable(targets, lang, now);
        if (options.dryRun) {
            const bytes = targets.reduce((total, session) => total + session.bytes, 0);
            console.log(m.wouldDelete(targets.length, formatSize(bytes, lang)));
            return 0;
        }
        return (await deleteAll(search.dirs, targets, lang)) > 0 ? 1 : 0;
    }

    const shown = hasFilter(options) ? targets : sessions;
    if (shown.length === 0) console.log(m.nothingMatches);
    else printTable(shown, lang, now);
    return 0;
}

main().then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        const m = messages(detectLang());
        console.error(`ccleanup: ${describeError(error, m)}`);
        if (error instanceof UsageError) console.error(m.usage.hint);
        process.exitCode = error instanceof UsageError ? 2 : 1;
    },
);

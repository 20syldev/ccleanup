import type { Lang } from "../lib/format.ts";

import { en } from "./en.ts";
import { fr } from "./fr.ts";

/**
 * Actions named in the footer, next to their key.
 */
export type KeyLabel =
    | "move"
    | "mark"
    | "all"
    | "none"
    | "old"
    | "sort"
    | "delete"
    | "quit"
    | "errors"
    | "yes"
    | "no"
    | "scroll"
    | "close"
    | "stop"
    | "search"
    | "details"
    | "help"
    | "clear"
    | "keep";

/**
 * Names of the keys that are not a single letter.
 */
export type KeyName = "arrows" | "space" | "enter" | "esc" | "yes" | "no" | "sort";

/**
 * Texts of the help panel: sections of key and action pairs, then the legend.
 */
export interface Guide {
    title: string;
    sections: { title: string; rows: [string, string][] }[];
    legendTitle: string;
    legend: {
        marked: string;
        markable: string;
        open: string;
        recent: string;
        recentAllowed: string;
        sizes: string;
    };
    close: string;
}

/**
 * Texts of the details panel of the session under the cursor.
 */
export interface Details {
    title: string;
    folder: string;
    config: string;
    started: string;
    modified: string;
    size: string;
    parts: Record<"transcript" | "folder" | "history" | "env" | "debug", string>;
    state: string;
    states: { open: string; recent: string; marked: string; idle: string };
    resume: string;
}

/**
 * Every text of the interface in one language. Functions take the values to insert;
 * `confirmKeys` lists the letters that confirm a deletion.
 */
export interface Messages {
    help: string;
    subtitle: string;
    columns: { size: string; age: string; project: string; title: string };
    stats: { sessions: string; marked: string; releasable: string; freed: string };
    olderTag: (days: number) => string;
    totalLine: (count: number, size: string) => string;
    scanning: (done: number, total: number) => string;
    scanDone: (count: number, duration: string) => string;
    deleting: (done: number, total: number) => string;
    keys: Record<KeyLabel, string>;
    keyNames: Record<KeyName, string>;
    usage: {
        unknownOption: (option: string) => string;
        missingValue: (option: string) => string;
        invalidValue: (option: string, value: string, expected: string) => string;
        yesNeedsFilter: string;
        hint: string;
        expected: Record<string, string>;
    };
    refusing: (path: string) => string;
    confirm: (count: number, size: string) => string;
    confirmHint: string;
    confirmKeys: string[];
    confirmTitle: string;
    confirmMore: (count: number) => string;
    confirmHidden: (count: number) => string;
    confirmFinal: (count: number) => string;
    guide: Guide;
    details: Details;
    search: {
        prompt: string;
        none: (query: string) => string;
        count: (shown: number, total: number) => string;
        clearHint: string;
    };
    done: (count: number, size: string) => string;
    failed: (count: number) => string;
    stopping: string;
    ctrlCAgain: string;
    errorsHint: (count: number) => string;
    errorsTitle: (count: number) => string;
    tooSmall: { title: string; needs: string; hint: string };
    exitFreed: (size: string, count: number) => string;
    exitNothing: string;
    exitTones: [string, string, string];
    exitFailures: (count: number) => string;
    updateAvailable: (latest: string, current: string) => string;
    recent: string;
    recentProtected: string;
    open: string;
    openProtected: string;
    openSkipped: (count: number) => string;
    nothingMarked: string;
    noSessions: (dirs: string[]) => string;
    denied: (paths: string[]) => string;
    nothingMatches: string;
    wouldDelete: (count: number, size: string) => string;
    checkLine: (count: number, days: number, size: string) => string;
    checkNothing: (days: number) => string;
    notifyTitle: string;
    notifyBody: (count: number, days: number, size: string) => string;
    notifyFailed: string;
    reminderInstalled: (every: string) => string;
    reminderRemoved: string;
    reminderDry: string;
    reminderNeedsGlobal: string;
    reminderNeedsSystemd: string;
}

/**
 * Texts of the interface.
 *
 * @param lang - Language picked by detectLang
 * @returns The French or English texts
 */
export function messages(lang: Lang): Messages {
    return lang === "fr" ? fr : en;
}

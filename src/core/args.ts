import { resolve } from "node:path";

import { DAY, GB, parseDuration, parseSize } from "../lib/format.ts";

/**
 * Period of the systemd reminder timer, used as its OnCalendar value.
 */
export type Every = "daily" | "weekly" | "monthly";

/**
 * Parsed command line. Durations are in milliseconds and sizes in bytes; `reminderArgs`
 * keeps the filter flags as typed, so the reminder service runs with the same filters.
 */
export interface Options {
    help: boolean;
    version: boolean;
    list: boolean;
    yes: boolean;
    dryRun: boolean;
    includeRecent: boolean;
    check: boolean;
    notify: boolean;
    installReminder: boolean;
    uninstallReminder: boolean;
    every: Every;
    olderThan?: number;
    minSize?: number;
    notifyAbove: number;
    claudeDirs: string[];
    reminderArgs: string[];
}

export const DEFAULT_OLDER_THAN = 14 * DAY;

/**
 * What is wrong with the command line, translated by the caller.
 */
export type UsageCode = "unknownOption" | "missingValue" | "invalidValue" | "yesNeedsFilter";

/**
 * Error in the command line itself. It carries a code, the option and the value at
 * fault, so the entry point can explain it in the language of the interface.
 */
export class UsageError extends Error {
    readonly code: UsageCode;
    readonly option: string;
    readonly value?: string;

    /**
     * Builds the error.
     *
     * @param code - Kind of mistake
     * @param option - Option at fault, as typed
     * @param value - Value at fault, for invalidValue
     */
    constructor(code: UsageCode, option: string, value?: string) {
        super(`${code}: ${option}${value === undefined ? "" : ` ${value}`}`);
        this.code = code;
        this.option = option;
        this.value = value;
    }
}

// Boolean flags and the option they turn on
const FLAGS: Record<string, keyof Options> = {
    "-h": "help",
    "--help": "help",
    "-v": "version",
    "--version": "version",
    "-l": "list",
    "--list": "list",
    "-y": "yes",
    "--yes": "yes",
    "-n": "dryRun",
    "--dry-run": "dryRun",
    "--include-recent": "includeRecent",
    "--check": "check",
    "--notify": "notify",
    "--install-reminder": "installReminder",
    "--uninstall-reminder": "uninstallReminder",
};

// Options that take a value, as "--name value" or "--name=value"
const VALUES = ["--older-than", "--min-size", "--notify-above", "--every", "--claude-dir"];

const EVERY: Every[] = ["daily", "weekly", "monthly"];

/**
 * Builds the default options, before any flag is read.
 *
 * @returns Options with every flag off, a weekly reminder and a 1 GB notification threshold
 */
function defaults(): Options {
    return {
        help: false,
        version: false,
        list: false,
        yes: false,
        dryRun: false,
        includeRecent: false,
        check: false,
        notify: false,
        installReminder: false,
        uninstallReminder: false,
        every: "weekly",
        notifyAbove: GB,
        claudeDirs: [],
        reminderArgs: [],
    };
}

/**
 * Applies one option that takes a value.
 *
 * @param options - Options being built, changed in place
 * @param name - Option name, one of VALUES
 * @param value - Raw value from the command line
 * @throws Error when the value does not parse
 */
function applyValue(options: Options, name: string, value: string): void {
    switch (name) {
        case "--older-than":
            options.olderThan = parseDuration(value);
            options.reminderArgs.push(name, value);
            break;
        case "--min-size":
            options.minSize = parseSize(value);
            options.reminderArgs.push(name, value);
            break;
        case "--notify-above":
            options.notifyAbove = parseSize(value);
            options.reminderArgs.push(name, value);
            break;
        case "--every":
            if (!EVERY.includes(value as Every)) {
                throw new Error(`Invalid --every "${value}" (daily, weekly or monthly)`);
            }
            options.every = value as Every;
            break;
        case "--claude-dir":
            options.claudeDirs.push(value);

            // The reminder runs from the home folder: resolve it from here.
            options.reminderArgs.push(name, resolve(value));
            break;
    }
}

/**
 * Parses the command line arguments.
 *
 * @param argv - Arguments after the script name, as in process.argv.slice(2)
 * @returns The options, defaults filled in
 * @throws UsageError for an unknown option, a missing value or a value that does not parse
 */
export function parseArgs(argv: string[]): Options {
    const options = defaults();
    const flags = options as unknown as Record<string, boolean>;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        const [name = arg, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg];

        const flag = FLAGS[name];
        if (flag) {
            flags[flag] = true;
            continue;
        }
        if (!VALUES.includes(name)) throw new UsageError("unknownOption", arg);

        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError("missingValue", name);
        try {
            applyValue(options, name, value);
        } catch {
            throw new UsageError("invalidValue", name, value);
        }
    }
    return options;
}

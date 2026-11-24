import { homedir } from "node:os";
import { sep } from "node:path";

/**
 * Language of the interface.
 */
export type Lang = "fr" | "en";

// Unit labels per language, from bytes to terabytes
const UNITS: Record<Lang, string[]> = {
    fr: ["o", "Ko", "Mo", "Go", "To"],
    en: ["B", "KB", "MB", "GB", "TB"],
};

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

/**
 * Picks the interface language from the environment.
 *
 * @param env - Environment to read; CCLEANUP_LANG wins over LC_ALL, LC_MESSAGES and LANG
 * @returns French when the first of these variables starts with "fr", English otherwise
 */
export function detectLang(env: NodeJS.ProcessEnv = process.env): Lang {
    const raw = env.CCLEANUP_LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? "";
    return raw.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/**
 * Formats a size in binary units, with a decimal comma in French.
 *
 * @param bytes - Size in bytes, 0 or more
 * @param lang - Language of the unit labels and of the decimal separator
 * @returns One decimal under 100 of the unit ("4,2 Go"), none above or for bytes ("512 o")
 */
export function formatSize(bytes: number, lang: Lang): string {
    const units = UNITS[lang];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    let text = unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1);
    if (lang === "fr") text = text.replace(".", ",");
    return `${text} ${units[unit]}`;
}

/**
 * Formats an age in the shortest readable unit.
 *
 * @param ageMs - Elapsed time in milliseconds
 * @param lang - Language of the day suffix ("j" in French, "d" in English)
 * @returns "<1h" under an hour, hours under two days, days under 60 days, then months of 30 days
 */
export function formatAge(ageMs: number, lang: Lang): string {
    const hours = ageMs / HOUR;
    if (hours < 1) return "<1h";
    if (hours < 48) return `${Math.floor(hours)}h`;
    const days = ageMs / DAY;
    if (days < 60) return `${Math.floor(days)}${lang === "fr" ? "j" : "d"}`;
    return `${Math.floor(days / 30)}mo`;
}

/**
 * Formats a duration for progress lines.
 *
 * @param ms - Duration in milliseconds
 * @param lang - Language of the decimal separator
 * @returns Tenths of a second under 10 s ("3,7 s"), whole seconds under a minute, then "2 min 05 s"
 */
export function formatDuration(ms: number, lang: Lang): string {
    const seconds = ms / 1000;
    if (seconds < 10) {
        const text = seconds.toFixed(1);
        return `${lang === "fr" ? text.replace(".", ",") : text} s`;
    }
    if (seconds < 60) return `${Math.round(seconds)} s`;
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

/**
 * Parses a duration given on the command line.
 *
 * @param input - Number followed by h (hours), d (days), w (weeks) or m (months of 30 days)
 * @returns The duration in milliseconds
 * @throws Error when the input does not match that form
 */
export function parseDuration(input: string): number {
    const match = /^(\d+(?:\.\d+)?)([hdwm])$/i.exec(input.trim());
    if (!match) throw new Error(`Invalid duration "${input}" (expected e.g. 12h, 14d, 2w, 3m)`);
    const factor = { h: HOUR, d: DAY, w: 7 * DAY, m: 30 * DAY }[match[2]!.toLowerCase()]!;
    return Number(match[1]) * factor;
}

/**
 * Parses a size given on the command line, in binary units.
 *
 * @param input - Number with an optional K, M, G or T suffix and an optional trailing B
 * @returns The size in bytes, rounded to an integer
 * @throws Error when the input does not match that form
 */
export function parseSize(input: string): number {
    const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(input.trim());
    if (!match) throw new Error(`Invalid size "${input}" (expected e.g. 100K, 500M, 1G)`);
    const suffix = match[2]!.toLowerCase();
    const power = suffix ? "kmgt".indexOf(suffix) + 1 : 0;
    return Math.round(Number(match[1]) * 1024 ** power);
}

/**
 * Writes a date and time the way the language does.
 *
 * @param ms - Time in milliseconds since the epoch
 * @param lang - Language of the output
 * @returns Such as "24 nov. 2026, 14:05"
 */
export function formatDate(ms: number, lang: Lang): string {
    return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(ms);
}

/**
 * Shortens a path under the home folder for display.
 *
 * @param path - Absolute path
 * @param home - Home folder
 * @returns The path with the home folder written "~"
 */
export function tildify(path: string, home = homedir()): string {
    return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { DAY } from "../lib/format.ts";

const LATEST_URL = "https://registry.npmjs.org/ccleanup/latest";
const TIMEOUT_MS = 3000;

// Only plain versions are ever printed, so a bad answer cannot reach the terminal
const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * What is kept between two runs: when the registry was last asked, and what it answered.
 */
interface Cache {
    checkedAt: number;
    latest?: string;
}

/**
 * Handle on a check started in the background.
 */
export interface UpdateCheck {
    /**
     * Ends the check: a request still running when the patience is over is dropped, so it
     * never holds the exit back.
     *
     * @param patience - How long to let the check go on, in milliseconds
     * @returns The newest version when it is newer than the running one, else undefined
     */
    finish(patience?: number): Promise<string | undefined>;
}

/**
 * Tells whether version `a` comes after version `b`.
 *
 * @param a - Version as x.y.z
 * @param b - Version as x.y.z
 * @returns True when `a` is newer; anything that is not x.y.z is never newer
 */
export function isNewer(a: string, b: string): boolean {
    if (!VERSION.test(a) || !VERSION.test(b)) return false;
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let index = 0; index < 3; index++) {
        if (left[index]! !== right[index]!) return left[index]! > right[index]!;
    }
    return false;
}

/**
 * Tells whether the update check is switched off.
 *
 * @param env - Environment: NO_UPDATE_NOTIFIER, CI and npm_command (set by npx)
 * @returns True with NO_UPDATE_NOTIFIER or CI set, or under npx, which fetches the latest itself
 */
export function updateDisabled(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.NO_UPDATE_NOTIFIER || env.CI) || env.npm_command === "exec";
}

/**
 * File that keeps the answer of the registry.
 *
 * @param env - Environment, for XDG_CACHE_HOME and HOME
 * @returns $XDG_CACHE_HOME/ccleanup/update.json when it is absolute, else ~/.cache/ccleanup/update.json
 */
export function cacheFile(env: NodeJS.ProcessEnv): string {
    // A relative path would land in the folder being worked in, so it is ignored, as the spec says
    const xdg = env.XDG_CACHE_HOME;
    const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), ".cache");
    return join(base, "ccleanup", "update.json");
}

/**
 * Reads the kept answer.
 *
 * @param file - Cache file
 * @returns The cache, or undefined when it is missing or not valid
 */
async function readCache(file: string): Promise<Cache | undefined> {
    try {
        const data = JSON.parse(await readFile(file, "utf8")) as Partial<Cache> | null;
        if (typeof data?.checkedAt !== "number" || !Number.isFinite(data.checkedAt)) return;
        const latest = typeof data.latest === "string" && VERSION.test(data.latest);
        return { checkedAt: data.checkedAt, latest: latest ? data.latest : undefined };
    } catch {
        return undefined;
    }
}

/**
 * Keeps the answer, through a rename so a second run never reads half of it.
 *
 * @param file - Cache file
 * @param cache - What to keep; a failure to write is ignored, the check just runs again
 */
async function writeCache(file: string, cache: Cache): Promise<void> {
    try {
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}`;
        await writeFile(temp, JSON.stringify(cache));
        await rename(temp, file);
    } catch {
        // Nothing to do: the cache only saves a request
    }
}

/**
 * Asks the registry for the latest version.
 *
 * @param fetcher - The fetch function, replaceable for tests
 * @param signal - Aborts the request
 * @returns The version, or undefined on any failure or unexpected answer
 */
async function fetchLatest(
    fetcher: typeof fetch,
    signal: AbortSignal,
): Promise<string | undefined> {
    try {
        const response = await fetcher(LATEST_URL, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
            headers: { accept: "application/json" },
        });
        if (!response.ok) return undefined;
        const { version } = (await response.json()) as { version?: unknown };
        return typeof version === "string" && VERSION.test(version) ? version : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Starts looking for a newer version in the background.
 *
 * The registry is asked at most once a day, and the answer is kept. The newest version known
 * is the answer just received, or the kept one when the request did not end in time.
 *
 * @param current - Running version
 * @param options - Environment, time of the run, and what to read and fetch with
 * @returns A handle to end the check; nothing is read or sent when the check is disabled
 */
export function startUpdateCheck(
    current: string,
    options: { env: NodeJS.ProcessEnv; now: number; file?: string; fetcher?: typeof fetch },
): UpdateCheck {
    const { env, now } = options;
    if (updateDisabled(env)) return { finish: async () => undefined };

    const file = options.file ?? cacheFile(env);
    const controller = new AbortController();
    const task = (async () => {
        const cache = await readCache(file);

        // A date in the future comes from a clock that moved: ask again
        const fresh = cache !== undefined && cache.checkedAt <= now && now - cache.checkedAt < DAY;
        if (fresh) return cache.latest;

        // Closed before the answer of the cache came: nothing worth asking for
        if (controller.signal.aborted) return cache?.latest;

        const latest = await fetchLatest(options.fetcher ?? fetch, controller.signal);

        // A request cut short by the exit says nothing, so the next run asks again
        if (latest === undefined && controller.signal.aborted) return cache?.latest;

        const known = latest ?? cache?.latest;
        await writeCache(file, { checkedAt: now, latest: known });
        return known;
    })();

    return {
        async finish(patience = 0) {
            const timer = setTimeout(() => controller.abort(), patience);
            const latest = await task.finally(() => clearTimeout(timer));
            return latest !== undefined && isNewer(latest, current) ? latest : undefined;
        },
    };
}

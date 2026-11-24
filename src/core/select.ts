import { fold } from "../lib/text.ts";

import type { Session } from "./scan.ts";

/**
 * Order of the list: biggest first, oldest first, or by project name.
 */
export type SortMode = "size" | "age" | "project";

/**
 * Targeting filters. `olderThan` is in milliseconds and `minSize` in bytes; recent
 * sessions are left out unless `includeRecent` is set, open sessions always; `now` is the
 * reference time.
 */
export interface Filter {
    olderThan?: number;
    minSize?: number;
    includeRecent: boolean;
    now: number;
}

export const SORT_MODES: SortMode[] = ["size", "age", "project"];

/**
 * Tells whether any targeting filter is set.
 *
 * @param filter - Filters as given on the command line
 * @returns True when --older-than or --min-size was given
 */
export function hasFilter(filter: Pick<Filter, "olderThan" | "minSize">): boolean {
    return filter.olderThan !== undefined || filter.minSize !== undefined;
}

/**
 * Tells whether a session passes every given filter.
 *
 * @param session - Measured session; its age comes from its newest file
 * @param filter - Filters to apply; a missing one lets everything through
 * @returns False for an open session, and for a recent one unless the filter includes them
 */
export function matches(session: Session, filter: Filter): boolean {
    if (session.open) return false;
    if (!filter.includeRecent && session.recent) return false;
    if (filter.olderThan !== undefined && filter.now - session.mtime < filter.olderThan) {
        return false;
    }
    if (filter.minSize !== undefined && session.bytes < filter.minSize) return false;
    return true;
}

/**
 * Keeps the sessions targeted by the filters.
 *
 * @param sessions - Measured sessions
 * @param filter - Filters to apply
 * @returns The matching sessions, or none at all when no filter is set, so a bare call never targets everything
 */
export function select(sessions: Session[], filter: Filter): Session[] {
    return hasFilter(filter) ? sessions.filter((session) => matches(session, filter)) : [];
}

/**
 * Sorts sessions without changing the given array.
 *
 * @param sessions - Sessions to sort
 * @param mode - Biggest first, oldest first, or project name then oldest first
 * @param reversed - Reverse the order: smallest, newest or last project first
 * @returns A new sorted array
 */
export function sortSessions(sessions: Session[], mode: SortMode, reversed = false): Session[] {
    const sorted = [...sessions];
    switch (mode) {
        case "size":
            sorted.sort((a, b) => b.bytes - a.bytes);
            break;
        case "age":
            sorted.sort((a, b) => a.mtime - b.mtime);
            break;
        case "project":
            sorted.sort((a, b) => a.project.localeCompare(b.project) || a.mtime - b.mtime);
            break;
    }
    return reversed ? sorted.reverse() : sorted;
}

/**
 * Tells whether a session matches a search: every word of the query must appear in its
 * project, title, working folder or id, whatever the case and the accents.
 *
 * @param session - Measured session
 * @param query - Words typed after /, possibly empty
 * @returns True for an empty query
 */
export function searchMatches(session: Session, query: string): boolean {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const haystack = fold(`${session.project} ${session.title} ${session.cwd ?? ""} ${session.id}`);
    return words.every((word) => haystack.includes(word));
}

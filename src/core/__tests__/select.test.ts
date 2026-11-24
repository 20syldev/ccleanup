import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Session } from "../scan.ts";
import { hasFilter, matches, searchMatches, select, sortSessions } from "../select.ts";

const DAY = 24 * 3_600_000;
const NOW = 100 * DAY;

/**
 * Builds a measured session for the filters.
 *
 * @param id - Session id, also used as its title
 * @param bytes - Size of the session
 * @param ageDays - Days since its last change
 * @param recent - Whether it counts as recent
 * @param open - Whether it runs in Claude Code
 * @returns A session with no file behind it
 */
function session(
    id: string,
    bytes: number,
    ageDays: number,
    recent = false,
    open = false,
): Session {
    return {
        id,
        projectDir: "-home-test",
        project: id.startsWith("b") ? "beta" : "alpha",
        title: id,
        bytes,
        mtime: NOW - ageDays * DAY,
        recent,
        open,
        paths: [],
        parts: [],
    };
}

const SESSIONS = [
    session("a-old-big", 900, 40),
    session("b-mid", 500, 20),
    session("a-new", 100, 2),
    session("b-running", 800, 0, true),
];

describe("matches and select", () => {
    it("targets nothing without a filter", () => {
        assert.equal(hasFilter({}), false);
        assert.deepEqual(select(SESSIONS, { includeRecent: false, now: NOW }), []);
    });

    it("combines age and size", () => {
        const filter = { olderThan: 14 * DAY, minSize: 600, includeRecent: false, now: NOW };
        assert.deepEqual(
            select(SESSIONS, filter).map((s) => s.id),
            ["a-old-big"],
        );
    });

    it("protects recent sessions unless asked", () => {
        const running = SESSIONS[3]!;
        assert.equal(matches(running, { minSize: 1, includeRecent: false, now: NOW }), false);
        assert.equal(matches(running, { minSize: 1, includeRecent: true, now: NOW }), true);
    });

    it("never targets an open session, even with --include-recent", () => {
        const open = session("a-open", 900, 40, false, true);
        const filter = { olderThan: DAY, includeRecent: true, now: NOW };
        assert.equal(matches(open, filter), false);
        assert.deepEqual(
            select([...SESSIONS, open], filter).map((s) => s.id),
            ["a-old-big", "b-mid", "a-new"],
        );
    });
});

describe("sortSessions", () => {
    it("sorts by size, age or project without changing the input", () => {
        const ids = (list: Session[]) => list.map((s) => s.id);
        assert.deepEqual(ids(sortSessions(SESSIONS, "size")), [
            "a-old-big",
            "b-running",
            "b-mid",
            "a-new",
        ]);
        assert.deepEqual(ids(sortSessions(SESSIONS, "age")), [
            "a-old-big",
            "b-mid",
            "a-new",
            "b-running",
        ]);
        assert.deepEqual(ids(sortSessions(SESSIONS, "size", true)), [
            "a-new",
            "b-mid",
            "b-running",
            "a-old-big",
        ]);
        assert.deepEqual(ids(sortSessions(SESSIONS, "project")), [
            "a-old-big",
            "a-new",
            "b-mid",
            "b-running",
        ]);
        assert.equal(SESSIONS[0]!.id, "a-old-big");
    });
});

describe("searchMatches", () => {
    it("needs every word, in the project, title or id, whatever the accents", () => {
        const one = { ...session("a-old-big", 900, 40), title: "Refonte du thème été" };
        assert.equal(searchMatches(one, ""), true);
        assert.equal(searchMatches(one, "ALPHA ete"), true);
        assert.equal(searchMatches(one, "alpha hiver"), false);
        assert.equal(searchMatches(one, "old-big"), true);
    });
});

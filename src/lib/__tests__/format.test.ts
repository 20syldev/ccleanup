import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    detectLang,
    formatAge,
    formatDate,
    formatDuration,
    formatSize,
    GB,
    MB,
    parseDuration,
    parseSize,
    tildify,
} from "../format.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("detectLang", () => {
    it("prefers CCLEANUP_LANG, then the locale", () => {
        assert.equal(detectLang({ CCLEANUP_LANG: "en", LANG: "fr_FR.UTF-8" }), "en");
        assert.equal(detectLang({ LANG: "fr_FR.UTF-8" }), "fr");
        assert.equal(detectLang({}), "en");
    });
});

describe("formatSize", () => {
    it("uses binary units and a decimal comma in French", () => {
        assert.equal(formatSize(512, "fr"), "512 o");
        assert.equal(formatSize(1.5 * MB, "fr"), "1,5 Mo");
        assert.equal(formatSize(1.5 * MB, "en"), "1.5 MB");
        assert.equal(formatSize(150 * GB, "en"), "150 GB");
    });
});

describe("formatAge", () => {
    it("picks the shortest readable unit", () => {
        assert.equal(formatAge(10 * 60_000, "fr"), "<1h");
        assert.equal(formatAge(5 * HOUR, "fr"), "5h");
        assert.equal(formatAge(10 * DAY, "fr"), "10j");
        assert.equal(formatAge(10 * DAY, "en"), "10d");
        assert.equal(formatAge(90 * DAY, "en"), "3mo");
    });
});

describe("formatDuration", () => {
    it("shows tenths under ten seconds, then minutes", () => {
        assert.equal(formatDuration(3700, "fr"), "3,7 s");
        assert.equal(formatDuration(42_000, "en"), "42 s");
        assert.equal(formatDuration(125_000, "en"), "2 min 05 s");
    });
});

describe("parseDuration", () => {
    it("reads hours, days, weeks and months", () => {
        assert.equal(parseDuration("12h"), 12 * HOUR);
        assert.equal(parseDuration("14d"), 14 * DAY);
        assert.equal(parseDuration("2w"), 14 * DAY);
        assert.equal(parseDuration("1m"), 30 * DAY);
    });

    it("rejects anything else", () => {
        assert.throws(() => parseDuration("14"));
        assert.throws(() => parseDuration("two days"));
    });
});

describe("parseSize", () => {
    it("reads binary units with an optional B", () => {
        assert.equal(parseSize("100K"), 100 * 1024);
        assert.equal(parseSize("500MB"), 500 * MB);
        assert.equal(parseSize("1g"), GB);
        assert.equal(parseSize("42"), 42);
    });

    it("rejects anything else", () => {
        assert.throws(() => parseSize("1 gigabyte"));
    });
});

describe("formatDate and tildify", () => {
    it("writes a date in the language", () => {
        const when = Date.UTC(2026, 10, 24, 12, 0);
        assert.match(formatDate(when, "fr"), /2026/);
        assert.match(formatDate(when, "en"), /Nov/);
    });

    it("writes the home folder as ~", () => {
        assert.equal(tildify("/home/u/.claude", "/home/u"), "~/.claude");
        assert.equal(tildify("/home/u", "/home/u"), "~");
        assert.equal(tildify("/home/user2/x", "/home/u"), "/home/user2/x");
    });
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { GB, MB } from "../../lib/format.ts";
import { parseArgs, UsageError } from "../args.ts";

const DAY = 24 * 3_600_000;

describe("parseArgs", () => {
    it("has safe defaults", () => {
        const options = parseArgs([]);
        assert.equal(options.yes, false);
        assert.equal(options.olderThan, undefined);
        assert.equal(options.every, "weekly");
        assert.equal(options.notifyAbove, GB);
    });

    it("reads short and long flags", () => {
        const options = parseArgs(["-l", "--dry-run", "-y", "--include-recent"]);
        assert.equal(options.list, true);
        assert.equal(options.dryRun, true);
        assert.equal(options.yes, true);
        assert.equal(options.includeRecent, true);
    });

    it("reads values given apart or after an equal sign", () => {
        const options = parseArgs(["--older-than", "14d", "--min-size=100M"]);
        assert.equal(options.olderThan, 14 * DAY);
        assert.equal(options.minSize, 100 * MB);
        assert.deepEqual(options.reminderArgs, ["--older-than", "14d", "--min-size", "100M"]);
    });

    it("repeats --claude-dir and keeps it absolute for the reminder", () => {
        const options = parseArgs(["--claude-dir", "cfg", "--claude-dir=/abs"]);
        assert.deepEqual(options.claudeDirs, ["cfg", "/abs"]);
        assert.deepEqual(options.reminderArgs, [
            "--claude-dir",
            join(process.cwd(), "cfg"),
            "--claude-dir",
            "/abs",
        ]);
    });

    it("rejects unknown options, missing values and bad values", () => {
        assert.throws(() => parseArgs(["--nope"]), UsageError);
        assert.throws(() => parseArgs(["--older-than"]), UsageError);
        assert.throws(() => parseArgs(["--older-than", "soon"]), UsageError);
        assert.throws(() => parseArgs(["--every", "hourly"]), UsageError);
    });
});

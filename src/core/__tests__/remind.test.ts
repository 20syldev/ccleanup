import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { messages } from "../../i18n/messages.ts";
import { parseArgs } from "../args.ts";
import { uninstallReminder } from "../remind.ts";

let root = "";
let saved: string | undefined;

before(async () => {
    root = await mkdtemp(join(tmpdir(), "ccleanup-remind-"));
    saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = root;
});

after(async () => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    await rm(root, { recursive: true, force: true });
});

beforeEach(() => mock.restoreAll());

describe("uninstallReminder", () => {
    it("says that no reminder is installed, however many times it runs", async () => {
        await mkdir(join(root, "systemd", "user"), { recursive: true });
        const lines: string[] = [];
        mock.method(console, "log", (line: string) => lines.push(line));
        const options = parseArgs(["--uninstall-reminder"]);
        await uninstallReminder(options, "en");
        await uninstallReminder(options, "en");
        assert.deepEqual(lines, [messages("en").reminderNone, messages("en").reminderNone]);
    });

    it("prints what it would do with --dry-run, even when nothing is installed", async () => {
        const lines: string[] = [];
        mock.method(console, "log", (line: string) => lines.push(line));
        await uninstallReminder(parseArgs(["--uninstall-reminder", "--dry-run"]), "en");
        assert.equal(lines.length, 3);
        assert.ok(lines[0]!.includes("disable --now"));
    });
});

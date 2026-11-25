import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { claudeTempRoot } from "../temp.ts";

const UID = process.getuid?.() ?? 1000;

let base = "";

before(async () => {
    base = await mkdtemp(join(tmpdir(), "ccleanup-temp-"));
    await mkdir(join(base, `claude-${UID}`));
    await mkdir(join(base, `claude-${UID + 1}`));
});

after(async () => {
    await rm(base, { recursive: true, force: true });
});

describe("claudeTempRoot", () => {
    it("is claude-<uid> in the temporary folder of the system", async () => {
        assert.equal(await claudeTempRoot({}, "linux", UID, base), join(base, `claude-${UID}`));
    });

    it("follows CLAUDE_CODE_TMPDIR", async () => {
        const env = { CLAUDE_CODE_TMPDIR: base };
        assert.equal(
            await claudeTempRoot(env, "linux", UID, "/nowhere"),
            join(base, `claude-${UID}`),
        );
    });

    it("gives nothing when the folder is missing", async () => {
        assert.equal(await claudeTempRoot({}, "linux", UID + 2, base), undefined);
    });

    it("gives nothing for a folder that belongs to another user", async () => {
        assert.equal(await claudeTempRoot({}, "linux", UID + 1, base), undefined);
    });

    it("gives nothing for a link", async () => {
        await symlink(join(base, `claude-${UID}`), join(base, `claude-${UID + 3}`));
        assert.equal(await claudeTempRoot({}, "linux", UID + 3, base), undefined);
    });

    it("leaves Windows out, where the folder is named another way", async () => {
        assert.equal(await claudeTempRoot({}, "win32", UID, base), undefined);
    });
});

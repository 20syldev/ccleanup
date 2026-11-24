import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { configCandidates, findConfigDirs } from "../config.ts";
import { discover } from "../scan.ts";

const ROOT_USER = process.getuid?.() === 0;

let home = "";

before(async () => {
    home = await mkdtemp(join(tmpdir(), "ccleanup-config-"));
});

after(async () => {
    await chmod(join(home, "locked", "projects"), 0o755).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
});

describe("configCandidates", () => {
    it("searches the environment folder, ~/.claude and ~/.config/claude", () => {
        const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, "custom") };
        assert.deepEqual(configCandidates([], env), [
            join(home, "custom"),
            join(home, ".claude"),
            join(home, ".config", "claude"),
        ]);
    });

    it("follows XDG_CONFIG_HOME and keeps only the overrides when given", () => {
        const env = { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") };
        assert.deepEqual(configCandidates([], env).at(-1), join(home, "xdg", "claude"));
        assert.deepEqual(configCandidates(["a", "a"], env), [join(process.cwd(), "a")]);
    });
});

describe("findConfigDirs", () => {
    it("keeps the folders with projects, once each through a symbolic link", async () => {
        await mkdir(join(home, ".claude", "projects"), { recursive: true });
        await mkdir(join(home, ".config"), { recursive: true });
        await symlink(join(home, ".claude"), join(home, ".config", "claude"));
        const search = await findConfigDirs([], { HOME: home });
        assert.deepEqual(search.dirs, [join(home, ".claude")]);
        assert.deepEqual(search.denied, []);
        assert.equal(search.searched.length, 2);
    });

    it("counts once two config folders sharing their projects", async () => {
        const shared = join(home, "shared");
        await mkdir(join(home, "real", "projects"), { recursive: true });
        await mkdir(shared);
        await symlink(join(home, "real", "projects"), join(shared, "projects"));
        const search = await findConfigDirs([join(home, "real"), shared], { HOME: home });
        assert.deepEqual(search.dirs, [join(home, "real")]);
    });

    it("reports a folder that refuses reading", { skip: ROOT_USER }, async () => {
        const locked = join(home, "locked");
        await mkdir(join(locked, "projects"), { recursive: true });
        await chmod(join(locked, "projects"), 0o000);
        const search = await findConfigDirs([locked], { HOME: home });
        assert.deepEqual(search.dirs, []);
        assert.deepEqual(search.denied, [join(locked, "projects")]);

        const denied: string[] = [];
        assert.deepEqual(await discover(locked, (path) => denied.push(path)), []);
        assert.deepEqual(denied, [join(locked, "projects")]);
    });
});

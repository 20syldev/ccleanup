import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resumePlan } from "../resume.ts";

describe("resumePlan", () => {
    it("runs in the folder of the session, keeping the environment of the default config", async () => {
        const home = await mkdtemp(join(tmpdir(), "ccleanup-resume-"));
        const env = { PATH: "/bin" };
        const plan = resumePlan({ cwd: home, configDir: join(home, ".claude") }, env, home);
        assert.deepEqual(plan, { cwd: home, env });
    });

    it("passes a custom config folder on to claude", async () => {
        const home = await mkdtemp(join(tmpdir(), "ccleanup-resume-"));
        const configDir = join(home, "work", ".claude");
        const plan = resumePlan({ cwd: home, configDir }, { PATH: "/bin" }, home);
        assert.deepEqual(plan?.env, { PATH: "/bin", CLAUDE_CONFIG_DIR: configDir });
    });

    it("gives nothing when the folder is unknown, gone, or a file", async () => {
        const home = await mkdtemp(join(tmpdir(), "ccleanup-resume-"));
        const file = join(home, "file");
        await writeFile(file, "");
        const configDir = join(home, ".claude");
        assert.equal(resumePlan({ cwd: undefined, configDir }, {}, home), undefined);
        assert.equal(resumePlan({ cwd: join(home, "gone"), configDir }, {}, home), undefined);
        assert.equal(resumePlan({ cwd: file, configDir }, {}, home), undefined);
    });
});

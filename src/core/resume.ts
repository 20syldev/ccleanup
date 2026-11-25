import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Session } from "./scan.ts";

/**
 * How to start `claude --resume` for a session.
 */
export interface ResumePlan {
    cwd: string;
    env: NodeJS.ProcessEnv;
}

/**
 * Works out where `claude --resume` finds a session: in its own folder, and with its config
 * folder when that is not the default one.
 *
 * @param session - Session to resume
 * @param env - Environment of ccleanup
 * @param home - Home folder, where the default config folder lives
 * @returns The plan, or undefined when the folder of the session is unknown or gone
 */
export function resumePlan(
    session: Pick<Session, "cwd" | "configDir">,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): ResumePlan | undefined {
    const { cwd, configDir } = session;
    if (!cwd) return undefined;
    try {
        if (!statSync(cwd).isDirectory()) return undefined;
    } catch {
        return undefined;
    }

    // Claude Code keeps one login per config folder, so only a custom one is passed on
    const custom = configDir !== join(home, ".claude");
    return { cwd, env: custom ? { ...env, CLAUDE_CONFIG_DIR: configDir } : env };
}

/**
 * Runs `claude --resume` on the terminal and waits for it to end.
 *
 * @param id - Session id
 * @param plan - Folder and environment to run it with
 * @returns Its exit code, or undefined when `claude` cannot be started
 */
export function runResume(id: string, plan: ResumePlan): Promise<number | undefined> {
    return new Promise((resolve) => {
        const child = spawn("claude", ["--resume", id], {
            cwd: plan.cwd,
            env: plan.env,
            stdio: "inherit",
            shell: process.platform === "win32",
        });

        // Ctrl+C reaches both programs: only claude acts on it
        const ignore = () => undefined;
        process.on("SIGINT", ignore);
        const done = (code: number | undefined) => {
            process.removeListener("SIGINT", ignore);
            resolve(code);
        };
        child.once("error", () => done(undefined));
        child.once("close", (code, signal) => done(code ?? (signal ? 1 : 0)));
    });
}

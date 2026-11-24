import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Outcome of the search for Claude Code config folders: `dirs` hold sessions and can be
 * read; `denied` lists the `projects` folders that exist but refuse reading; `searched`
 * lists every config folder looked at.
 */
export interface ConfigSearch {
    dirs: string[];
    denied: string[];
    searched: string[];
}

/**
 * Folders that may hold Claude Code sessions, in order of preference.
 *
 * @param overrides - Folders given with --claude-dir; when set, they are the only ones
 * @param env - Environment, for CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME and HOME
 * @returns Absolute paths, without duplicates
 */
export function configCandidates(overrides: string[], env: NodeJS.ProcessEnv): string[] {
    const home = env.HOME || homedir();
    const candidates =
        overrides.length > 0
            ? overrides
            : [
                  env.CLAUDE_CONFIG_DIR,
                  join(home, ".claude"),
                  join(env.XDG_CONFIG_HOME || join(home, ".config"), "claude"),
              ];
    const paths = candidates.filter((path): path is string => Boolean(path));
    return [...new Set(paths.map((path) => resolve(path)))];
}

/**
 * Finds the Claude Code config folders that hold sessions.
 *
 * A folder counts when its `projects` subfolder exists. Two folders that lead to the same
 * `projects` tree, through a symbolic link to either, count once: the first one wins.
 *
 * @param overrides - Folders given with --claude-dir; when set, nothing else is searched
 * @param env - Environment, for CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME and HOME
 * @returns The readable folders, the unreadable ones and every folder searched
 */
export async function findConfigDirs(
    overrides: string[],
    env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigSearch> {
    const searched = configCandidates(overrides, env);
    const dirs: string[] = [];
    const denied: string[] = [];
    const seen = new Set<string>();
    for (const dir of searched) {
        const projects = join(dir, "projects");
        let readable = true;
        try {
            await readdir(projects);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EACCES" && code !== "EPERM") continue;
            readable = false;
        }
        const real = await realpath(projects).catch(() => projects);
        if (seen.has(real)) continue;
        seen.add(real);
        if (readable) dirs.push(dir);
        else denied.push(projects);
    }
    return { dirs, denied, searched };
}

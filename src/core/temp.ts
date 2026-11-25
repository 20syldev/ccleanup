import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Finds the folder where Claude Code keeps the temporary files of the sessions, one folder
 * per project and per session: `<temp>/claude-<uid>/<project>/<session id>`.
 *
 * @param env - Environment, for CLAUDE_CODE_TMPDIR
 * @param platform - Operating system; Windows names this folder differently and is left out
 * @param uid - User id of the process
 * @param base - Temporary folder of the system, replaceable for tests
 * @returns The folder, or undefined when it does not exist, is a link, or belongs to someone else
 */
export async function claudeTempRoot(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    uid: number | undefined = process.getuid?.(),
    base: string = tmpdir(),
): Promise<string | undefined> {
    if (platform === "win32" || uid === undefined) return undefined;

    // Claude Code uses /tmp on macOS, not the per-user folder of the system
    const parent = env.CLAUDE_CODE_TMPDIR || (platform === "darwin" ? "/tmp" : base);
    const root = join(parent, `claude-${uid}`);
    try {
        const info = await lstat(root);

        // A shared temp folder lets anyone create this name: only our own folder counts
        return info.isDirectory() && info.uid === uid ? root : undefined;
    } catch {
        return undefined;
    }
}

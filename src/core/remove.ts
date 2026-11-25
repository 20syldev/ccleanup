import { realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

import { type Session, UUID } from "./scan.ts";

/**
 * Deletion refused by the safety checks, before anything was removed.
 */
export class UnsafePathError extends Error {
    readonly path: string;

    /**
     * Builds the error.
     *
     * @param path - Path that failed the checks
     */
    constructor(path: string) {
        super(`Refusing to delete ${path}`);
        this.path = path;
    }
}

/**
 * Refuses any path that is not named after the session or lies outside the folders a
 * session may own.
 *
 * @param roots - Config folder and, when known, temporary folder: the only trees deletions may touch
 * @param path - Path about to be deleted
 * @param id - Session UUID the path must be named after
 * @throws UnsafePathError when one of the checks fails
 */
function assertSafe(roots: string[], path: string, id: string): void {
    const target = resolve(path);
    const inside = roots.some((root) => target.startsWith(resolve(root) + sep));
    if (!UUID.test(id) || !inside || !basename(target).startsWith(id)) {
        throw new UnsafePathError(path);
    }
}

/**
 * Refuses a path of the temporary folder that leads out of it through a link, since that
 * folder can be written by other programs.
 *
 * @param root - Temporary folder of Claude Code
 * @param path - Path about to be deleted
 * @throws UnsafePathError when the real parent of the path is not inside the real root
 */
async function assertNoLink(root: string, path: string): Promise<void> {
    try {
        const real = await realpath(root);
        const parent = await realpath(dirname(path));
        if (!parent.startsWith(real + sep)) throw new UnsafePathError(path);
    } catch (error) {
        if (error instanceof UnsafePathError) throw error;

        // Nothing there: nothing to delete
    }
}

/**
 * Deletes a session: its transcript and the folders that belong to it.
 *
 * Every path is checked before the first one is removed, so a bad path deletes nothing.
 *
 * @param configDir - Claude config folder the session was found in
 * @param session - Measured session; its `paths` list what goes
 * @param tempRoot - Temporary folder of Claude Code, where the scratch folder of the session lives
 * @throws UnsafePathError when a path fails the safety checks, else the file system error
 */
export async function removeSession(
    configDir: string,
    session: Session,
    tempRoot?: string,
): Promise<void> {
    const roots = tempRoot ? [configDir, tempRoot] : [configDir];
    for (const path of session.paths) {
        assertSafe(roots, path, session.id);
        if (tempRoot && resolve(path).startsWith(resolve(tempRoot) + sep)) {
            await assertNoLink(tempRoot, path);
        }
    }
    for (const path of session.paths) await rm(path, { recursive: true, force: true });
}

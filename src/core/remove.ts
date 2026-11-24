import { rm } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

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
 * Refuses any path that is not named after the session or lies outside the config folder.
 *
 * @param configDir - Claude config folder, the only tree deletions may touch
 * @param path - Path about to be deleted
 * @param id - Session UUID the path must be named after
 * @throws UnsafePathError when one of the checks fails
 */
function assertSafe(configDir: string, path: string, id: string): void {
    const root = resolve(configDir) + sep;
    const target = resolve(path);
    if (!UUID.test(id) || !target.startsWith(root) || !basename(target).startsWith(id)) {
        throw new UnsafePathError(path);
    }
}

/**
 * Deletes a session: its transcript and the folders that belong to it.
 *
 * Every path is checked before the first one is removed, so a bad path deletes nothing.
 *
 * @param configDir - Claude config folder the session was found in
 * @param session - Measured session; its `paths` list what goes
 * @throws UnsafePathError when a path fails the safety checks, else the file system error
 */
export async function removeSession(configDir: string, session: Session): Promise<void> {
    for (const path of session.paths) assertSafe(configDir, path, session.id);
    for (const path of session.paths) await rm(path, { recursive: true, force: true });
}

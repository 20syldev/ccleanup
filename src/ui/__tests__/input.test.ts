import assert from "node:assert/strict";
import type { Key } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { ESC } from "../../lib/text.ts";
import { createInput } from "../input.ts";

/**
 * Sends raw bytes to a fresh input and collects the keys it reports.
 *
 * @param chunks - Chunks of terminal input, written one after the other
 * @param waitMs - Time to wait after the last chunk
 * @returns The names of the keys, and the time the first one took
 */
async function keys(chunks: string[], waitMs = 250): Promise<{ names: string[]; firstMs: number }> {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const names: string[] = [];
    const start = performance.now();
    let firstMs = Infinity;
    const input = createInput(stdin, (text: string | undefined, key: Key | undefined) => {
        firstMs = Math.min(firstMs, performance.now() - start);
        names.push(key?.name ?? text ?? "");
    });
    for (const chunk of chunks) stdin.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    input.close();
    return { names, firstMs };
}

describe("createInput", () => {
    it("reports a lone Esc after a short wait, not readline's half second", async () => {
        const { names, firstMs } = await keys([ESC]);
        assert.deepEqual(names, ["escape"]);
        assert.ok(firstMs < 250, `Esc took ${Math.round(firstMs)} ms`);
    });

    it("still reads arrows sent with their escape byte", async () => {
        const { names } = await keys([`${ESC}[A`, `${ESC}[B`]);
        assert.deepEqual(names, ["up", "down"]);
    });

    it("drops a background color reply instead of reading it as keys", async () => {
        const { names } = await keys([`${ESC}]11;rgb:2a2a/2a2a/2a2a${ESC}\\`, "q"]);
        assert.deepEqual(names, ["q"]);
    });
});

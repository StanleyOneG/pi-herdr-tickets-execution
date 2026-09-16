import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Reads a nonempty regular file without following its final path component. */
export async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  description: string,
): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
      throw new Error(`${description} is not a bounded regular file`);
    }
    const bytes = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead === 0 || bytesRead > maximumBytes) {
      throw new Error(`${description} is empty or exceeds its bound`);
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

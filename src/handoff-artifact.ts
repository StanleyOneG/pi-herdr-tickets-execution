import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { atomicWritePrivateFile } from "./atomic-file.js";
import { readBoundedRegularFile } from "./bounded-regular-file.js";
import type { DurableHandoff, HandoffBinding } from "./coordination-contracts.js";
import { digest } from "./policy.js";

export const MAX_HANDOFF_BYTES = 24_000;

export async function readHandoffArtifact(path: string, binding: HandoffBinding): Promise<{ content: string; sourceDigest: string }> {
  if (!isAbsolute(path) || !path.endsWith(".md")) throw new Error("Handoff must identify the actual Markdown artifact");
  const bytes = await readBoundedRegularFile(path, MAX_HANDOFF_BYTES, "Handoff artifact");
  const content = bytes.toString("utf8");
  if (!Object.values(binding).every((value): boolean => content.includes(value)) ||
    ![/changes|progress/i, /checks|tests/i, /findings|reviews/i, /decisions|blocked/i, /next/i].every((pattern): boolean => pattern.test(content)) ||
    /"type"\s*:\s*"(?:message|session|compaction)"|\[Assistant thinking\]/i.test(content)
  ) throw new Error("Handoff is incomplete, mismatched or contains a transcript");
  return { content, sourceDigest: createHash("sha256").update(bytes).digest("hex") };
}

/** The native skill owns its filename. This adapter records that exact file and copies bounded redacted text. */
export async function retainHandoff(directory: string, nonce: string, sessionId: string, binding: HandoffBinding): Promise<DurableHandoff> {
  const raw = JSON.parse((await readBoundedRegularFile(join(directory, "handoff-receipt.json"), 32_000, "Handoff receipt")).toString("utf8")) as Record<string, unknown>;
  if (raw.nonce !== nonce || raw.sessionId !== sessionId || raw.nativeCommand !== "/skill:handoff" || digest(raw.binding) !== digest(binding) || typeof raw.sourcePath !== "string") {
    throw new Error("Handoff receipt does not bind the native command to this ticket and session");
  }
  const artifact = await readHandoffArtifact(raw.sourcePath, binding);
  if (artifact.sourceDigest !== raw.sourceDigest) throw new Error("Handoff artifact changed after submission");
  const redacted = artifact.content
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/((?:token|secret|password|api[_ -]?key)\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]");
  const contentDigest = createHash("sha256").update(redacted).digest("hex");
  const reference = join(directory, `handoff-${contentDigest}.md`);
  await atomicWritePrivateFile(reference, redacted);
  return { ...binding, sessionId, sourcePath: raw.sourcePath, reference, contentDigest };
}

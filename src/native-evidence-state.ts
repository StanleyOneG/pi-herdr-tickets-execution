import { isAbsolute } from "node:path";

import { readBoundedRegularFile } from "./bounded-regular-file.js";

export const NATIVE_EVIDENCE_STATE_ENTRY = "herdr-native-evidence-state";
export const NATIVE_EVIDENCE_STATE_FILE = "obligation-state.json";

const MAX_NATIVE_EVIDENCE_STATE_BYTES = 256 * 1024;
const DIGEST = /^[a-f0-9]{64}$/i;
const GENERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type NativeEvidenceObligation = "tests" | "reviews";

export interface NativeEvidenceProofState {
  kind: NativeEvidenceObligation;
  codeStateDigest: string;
  completedAt: string;
  executionReference: string;
  sequence: number;
  sourceArtifact?: { reference: string; digest: string };
}

export interface NativeEvidenceObligationState {
  sequence: number;
  status: "required" | "pending" | "passed";
  proof?: NativeEvidenceProofState;
}

export interface NativeEvidenceState {
  schemaVersion: 1;
  producer: "herdr-worker-bridge";
  sessionId: string;
  generation: string;
  obligations: Record<NativeEvidenceObligation, NativeEvidenceObligationState>;
}

export interface NativeEvidenceLifecycleBinding {
  reference: string;
  sessionId: string;
  generation: string;
  obligation: NativeEvidenceObligation;
  sequence: number;
}

export async function readNativeEvidenceState(path: string): Promise<NativeEvidenceState> {
  if (!isAbsolute(path)) throw new Error("Native evidence obligation state path must be absolute");
  const bytes = await readBoundedRegularFile(
    path,
    MAX_NATIVE_EVIDENCE_STATE_BYTES,
    "Native evidence obligation state",
  );
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isNativeEvidenceState(parsed)) throw new Error("Native evidence obligation state is malformed");
  return structuredClone(parsed);
}

export function isNativeEvidenceState(value: unknown): value is NativeEvidenceState {
  if (!recordWithKeys(value, ["schemaVersion", "producer", "sessionId", "generation", "obligations"])) return false;
  if (value.schemaVersion !== 1 || value.producer !== "herdr-worker-bridge" ||
    !boundedText(value.sessionId, 4_096) || typeof value.generation !== "string" || !GENERATION.test(value.generation) ||
    !recordWithKeys(value.obligations, ["tests", "reviews"])
  ) return false;
  return isObligationState(value.obligations.tests, "tests") &&
    isObligationState(value.obligations.reviews, "reviews");
}

export function isNativeEvidenceLifecycleBinding(value: unknown): value is NativeEvidenceLifecycleBinding {
  return recordWithKeys(value, ["reference", "sessionId", "generation", "obligation", "sequence"]) &&
    typeof value.reference === "string" && isAbsolute(value.reference) && value.reference.length <= 4_096 &&
    boundedText(value.sessionId, 4_096) && typeof value.generation === "string" && GENERATION.test(value.generation) &&
    (value.obligation === "tests" || value.obligation === "reviews") && nonnegativeInteger(value.sequence);
}

function isObligationState(value: unknown, obligation: NativeEvidenceObligation): value is NativeEvidenceObligationState {
  if (!recordWithAllowedKeys(value, ["sequence", "status", "proof"]) || !nonnegativeInteger(value.sequence) ||
    (value.status !== "required" && value.status !== "pending" && value.status !== "passed")
  ) return false;
  if (value.status !== "passed") return value.proof === undefined;
  return isProof(value.proof, obligation, value.sequence);
}

function isProof(value: unknown, obligation: NativeEvidenceObligation, sequence: number): value is NativeEvidenceProofState {
  if (!recordWithAllowedKeys(value, [
    "kind", "codeStateDigest", "completedAt", "executionReference", "sequence", "sourceArtifact",
  ]) || value.kind !== obligation || value.sequence !== sequence || typeof value.codeStateDigest !== "string" ||
    !DIGEST.test(value.codeStateDigest) || typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.completedAt)) || !boundedText(value.executionReference, 4_096)
  ) return false;
  return value.sourceArtifact === undefined || (recordWithKeys(value.sourceArtifact, ["reference", "digest"]) &&
    typeof value.sourceArtifact.reference === "string" && isAbsolute(value.sourceArtifact.reference) &&
    value.sourceArtifact.reference.length <= 4_096 && typeof value.sourceArtifact.digest === "string" &&
    DIGEST.test(value.sourceArtifact.digest));
}

function recordWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return recordWithAllowedKeys(value, keys) && Object.keys(value).length === keys.length;
}

function recordWithAllowedKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key): boolean => allowed.has(key));
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

// Public surface of evidence management (upload, storage, transcription seed,
// grading suggestion, and the read models behind /evidence).

export { ingestEvidenceUpload } from "./intake";
export type { IngestInput, IngestOptions, IngestResult } from "./intake";

export {
  BLOB_MIME_TYPE,
  JPEG_QUALITY,
  UnreadableImageError,
  blobStoragePath,
  resolveBlobDir,
  resolveStoragePath,
  sanitizeImage,
  sha256Hex,
  writeBlob,
} from "./blob";
export type { SanitizedImage } from "./blob";

export {
  ANOMALY_DIGEST_MAX_CHARS,
  ANOMALY_MIN_CHARS,
  buildCaseDict,
  buildOcrDigest,
  checkEvidenceAnomaly,
} from "./anomaly";
export type { AnomalyChecker } from "./anomaly";

/* Text that arrived as a transcript rather than as an image. The one intake
   path that is neither party's own statement — see the module header for what
   it deliberately does not do. */
export {
  DEFAULT_TRANSCRIPT_SOURCE,
  MAX_TRANSCRIPT_CHARS,
  TRANSCRIPT_SOURCES,
  TRANSCRIPT_SOURCE_TYPES,
  TranscriptError,
  addTranscriptEvidence,
  isTranscriptSource,
  parseTranscript,
} from "./transcript";
export type {
  AddedTranscript,
  TranscriptErrorCode,
  TranscriptInput,
  TranscriptLine,
  TranscriptSource,
  TranscriptSpeaker,
} from "./transcript";

export {
  findEvidenceImage,
  listEvidence,
  resolveDefaultCaseId,
  summarizeEvidence,
} from "./queries";
export type {
  EvidenceImage,
  EvidenceListItem,
  EvidenceSummary,
} from "./queries";

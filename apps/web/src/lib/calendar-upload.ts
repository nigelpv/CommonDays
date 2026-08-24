import {
  CALENDAR_UPLOAD_IMAGE_TYPES,
  CALENDAR_UPLOAD_MAX_FILE_BYTES,
  CALENDAR_UPLOAD_MAX_SCREENSHOTS,
  CALENDAR_UPLOAD_MAX_TOTAL_BYTES,
} from "@commondays/shared/upload-limits";

const imageTypes = new Set<string>(CALENDAR_UPLOAD_IMAGE_TYPES);

export type UploadMode = "screenshots" | "pdf";

export interface FileSelectionResult {
  files: File[];
  mode: UploadMode | null;
  error: string;
}

function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function addCalendarFiles(existing: File[], incoming: File[]): FileSelectionResult {
  if (incoming.length === 0) return { files: existing, mode: inferUploadMode(existing), error: "" };

  const invalidFile = incoming.find(
    (file) => file.type !== "application/pdf" && !imageTypes.has(file.type),
  );
  if (invalidFile) {
    return { files: existing, mode: inferUploadMode(existing), error: "Use PNG, JPG, WebP, or PDF files." };
  }

  const emptyFile = incoming.find((file) => file.size === 0);
  if (emptyFile) {
    return { files: existing, mode: inferUploadMode(existing), error: `${emptyFile.name} is empty.` };
  }

  const oversizedFile = incoming.find((file) => file.size > CALENDAR_UPLOAD_MAX_FILE_BYTES);
  if (oversizedFile) {
    return { files: existing, mode: inferUploadMode(existing), error: `${oversizedFile.name} is too large to upload.` };
  }

  const incomingPdfs = incoming.filter((file) => file.type === "application/pdf");
  const incomingImages = incoming.filter((file) => imageTypes.has(file.type));
  const existingMode = inferUploadMode(existing);

  if (incomingPdfs.length > 0 && incomingImages.length > 0) {
    return { files: existing, mode: existingMode, error: "Choose screenshots or one PDF, not both." };
  }
  if ((existingMode === "screenshots" && incomingPdfs.length > 0) || (existingMode === "pdf" && incomingImages.length > 0)) {
    return { files: existing, mode: existingMode, error: "Choose screenshots or one PDF, not both." };
  }
  if (incomingPdfs.length > 1 || (existingMode === "pdf" && incomingPdfs.length > 0)) {
    return { files: existing, mode: existingMode, error: "Upload one PDF at a time." };
  }

  const knownFiles = new Set(existing.map(fileKey));
  const uniqueIncoming = incoming.filter((file) => {
    const key = fileKey(file);
    if (knownFiles.has(key)) return false;
    knownFiles.add(key);
    return true;
  });
  if (incomingPdfs.length === 1) {
    return { files: [...existing, incomingPdfs[0]], mode: "pdf", error: "" };
  }

  const remainingSlots = CALENDAR_UPLOAD_MAX_SCREENSHOTS - existing.length;
  const acceptedImages = uniqueIncoming.slice(0, Math.max(remainingSlots, 0));
  const files = [...existing, ...acceptedImages];
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > CALENDAR_UPLOAD_MAX_TOTAL_BYTES) {
    return { files: existing, mode: existingMode, error: "Those screenshots are too large together." };
  }

  return {
    files,
    mode: "screenshots",
    error:
      uniqueIncoming.length > acceptedImages.length
        ? "You have already added 10 screenshots. Remove one before adding another."
        : "",
  };
}

export function inferUploadMode(files: File[]): UploadMode | null {
  if (files.length === 0) return null;
  return files[0].type === "application/pdf" ? "pdf" : "screenshots";
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

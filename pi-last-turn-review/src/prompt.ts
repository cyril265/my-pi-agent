import type { DiffReviewComment, ReviewFile, ReviewSubmitPayload } from "./types.js";

function getCommentFilePath(file: ReviewFile | undefined): string {
  if (file == null) return "(unknown file)";
  return file.comparison.displayPath;
}

function formatLocation(comment: DiffReviewComment, file: ReviewFile | undefined, scopeLabel: string): string {
  const filePath = getCommentFilePath(file);
  const scopePrefix = `[${scopeLabel}] `;

  if (comment.side === "file" || comment.startLine == null) {
    return `${scopePrefix}${filePath}`;
  }

  const range = comment.endLine != null && comment.endLine !== comment.startLine
    ? `${comment.startLine}-${comment.endLine}`
    : `${comment.startLine}`;

  const suffix = comment.side === "original" ? " (old)" : " (new)";
  return `${scopePrefix}${filePath}:${range}${suffix}`;
}

export function composeReviewPrompt(files: ReviewFile[], payload: ReviewSubmitPayload, header: string, scopeLabel: string): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const lines: string[] = [];

  lines.push(header);
  lines.push("");

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push(overallComment);
    lines.push("");
  }

  payload.comments.forEach((comment, index) => {
    const file = fileMap.get(comment.fileId);
    lines.push(`${index + 1}. ${formatLocation(comment, file, scopeLabel)}`);
    lines.push(`   ${comment.body.trim()}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}

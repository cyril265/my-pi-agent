import type { DiffReviewComment, ReviewFile, ReviewSubmitPayload } from "./types.js";

function getCommentFilePath(file: ReviewFile | undefined): string {
  if (file == null) return "(unknown file)";
  return file.comparison.displayPath;
}

function formatLineRange(comment: DiffReviewComment): string {
  if (comment.startLine == null) return "";
  if (comment.endLine != null && comment.endLine !== comment.startLine) {
    return `L${comment.startLine}-L${comment.endLine}`;
  }
  return `L${comment.startLine}`;
}

function formatLocation(comment: DiffReviewComment, file: ReviewFile | undefined): string {
  const filePath = getCommentFilePath(file);

  if (comment.side === "file" || comment.startLine == null) {
    return filePath;
  }

  const range = formatLineRange(comment);
  if (comment.side === "original") {
    return `${filePath} (old ${range})`;
  }

  return `${filePath} ${range}`;
}

function formatIntro(_scopeLabel: string): string {
  return "Please address the following code review comments. Run `git diff` (or `git diff HEAD`) to see the full context of any changes, especially for deleted lines.";
}

export function composeReviewPrompt(files: ReviewFile[], payload: ReviewSubmitPayload, _header: string, scopeLabel: string): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const lines: string[] = [formatIntro(scopeLabel), ""];

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push(`- General: ${overallComment}`);
  }

  payload.comments.forEach((comment) => {
    const file = fileMap.get(comment.fileId);
    lines.push(`- ${formatLocation(comment, file)}: ${comment.body.trim()}`);
  });

  return lines.join("\n").trim();
}

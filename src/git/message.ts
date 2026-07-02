// Commit-message trailer handling. When rewording a commit or applying an
// AI-generated message, we must preserve Gerrit/DCO trailers such as
// `Change-Id:` and `Signed-off-by:` — only the header/body above them may
// change.

const TRAILER_KEYS = [
  "Change-Id",
  "Signed-off-by",
  "Co-authored-by",
  "Reviewed-by",
  "Acked-by",
  "Tested-by",
  "Reported-by",
];

const TRAILER_RE = new RegExp(
  `^(${TRAILER_KEYS.join("|")}):\\s`,
  "i"
);

export interface SplitMessage {
  body: string; // editable header/body
  trailers: string; // preserved trailer block (may be empty)
}

/**
 * Splits a commit message into an editable body and a preserved trailer block.
 * The trailer block is the final contiguous run of recognized trailer lines
 * (e.g. Change-Id, Signed-off-by), ignoring blank lines between them.
 */
export function splitTrailers(message: string): SplitMessage {
  const lines = message.replace(/\s+$/, "").split("\n");
  let firstTrailer = lines.length;
  // Walk upward while lines are trailers or blank; require at least one trailer.
  let sawTrailer = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") {
      continue; // blanks allowed within the trailing block
    }
    if (TRAILER_RE.test(line)) {
      firstTrailer = i;
      sawTrailer = true;
    } else {
      break;
    }
  }
  if (!sawTrailer) {
    return { body: message.replace(/\s+$/, ""), trailers: "" };
  }
  const body = lines.slice(0, firstTrailer).join("\n").replace(/\s+$/, "");
  const trailers = lines
    .slice(firstTrailer)
    .filter((l) => l.trim() !== "")
    .join("\n");
  return { body, trailers };
}

/**
 * Combines an edited body with the preserved trailers from the original
 * message. If the edited body already contains those trailers, they are not
 * duplicated.
 */
export function applyTrailers(editedBody: string, originalMessage: string): string {
  const { trailers } = splitTrailers(originalMessage);
  const body = editedBody.replace(/\s+$/, "");
  if (!trailers) {
    return body + "\n";
  }
  // Skip re-appending trailers already present in the edited body.
  const editedTrailers = splitTrailers(editedBody).trailers;
  if (editedTrailers) {
    return body + "\n";
  }
  return `${body}\n\n${trailers}\n`;
}

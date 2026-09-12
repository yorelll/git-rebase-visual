export interface CommitSearchTarget {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authorEmail: string;
  date?: string;
}

export type CommitSearchTerm =
  | { field: "author" | "msg" | "hash"; value: string }
  | { field: "text"; value: string };

/**
 * A small, deliberately forgiving query grammar. Known `field:value` terms are
 * scoped; unknown prefixes remain ordinary full-text terms so an author whose
 * name contains a colon is still searchable. `hash:0x…` accepts users' common
 * hexadecimal notation but only compares the normalized real hash prefix.
 */
export function parseCommitSearch(raw: string): CommitSearchTerm[] {
  return raw.trim().split(/\s+/).filter(Boolean).map((token): CommitSearchTerm => {
    const match = token.match(/^(author|msg|hash):(.+)$/i);
    if (!match) return { field: "text", value: token.toLocaleLowerCase() };
    const field = match[1].toLowerCase() as "author" | "msg" | "hash";
    let value = match[2].toLocaleLowerCase();
    if (field === "hash" && /^0x[0-9a-f]+$/i.test(value)) value = value.slice(2);
    return { field, value };
  });
}

export function matchesCommitSearch(commit: CommitSearchTarget, raw: string): boolean {
  const terms = parseCommitSearch(raw);
  return terms.every((term) => {
    switch (term.field) {
      case "author":
        return `${commit.author} ${commit.authorEmail}`.toLocaleLowerCase().includes(term.value);
      case "msg":
        return commit.subject.toLocaleLowerCase().includes(term.value);
      case "hash":
        return commit.hash.toLocaleLowerCase().startsWith(term.value) || commit.shortHash.toLocaleLowerCase().startsWith(term.value);
      case "text":
        return `${commit.shortHash} ${commit.hash} ${commit.subject} ${commit.author} ${commit.authorEmail} ${commit.date ?? ""}`
          .toLocaleLowerCase()
          .includes(term.value);
    }
  });
}

export interface SearchCompositionState {
  value: string;
  composing: boolean;
  pendingValue?: string;
}

export const initialSearchCompositionState: SearchCompositionState = { value: "", composing: false };

/**
 * Keeps the rendered filter immutable while an IME owns the input DOM. The
 * caller must not render/recreate the input for composing/update events;
 * compositionend commits exactly its final DOM value once.
 */
export function reduceSearchComposition(
  state: SearchCompositionState,
  event: "compositionstart" | "compositionupdate" | "compositionend" | "input",
  value: string
): SearchCompositionState {
  switch (event) {
    case "compositionstart":
      return { ...state, composing: true, pendingValue: value };
    case "compositionupdate":
      return { ...state, composing: true, pendingValue: value };
    case "compositionend":
      return { value, composing: false };
    case "input":
      return state.composing ? { ...state, pendingValue: value } : { value, composing: false };
  }
}

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
  const query = raw.trim();
  if (!query) return [];

  // A scoped value continues until the next known field. This permits natural
  // queries such as `msg: feat parser author: Alice`, including the optional
  // whitespace after `:` required by IMEs and normal typing. Unknown prefixes
  // intentionally remain ordinary full-text tokens.
  const markers = [...query.matchAll(/(?:^|\s)(author|msg|hash):\s*/gi)];
  if (markers.length === 0) {
    return query.split(/\s+/).filter(Boolean).map((value) => ({
      field: "text" as const,
      value: value.toLocaleLowerCase(),
    }));
  }

  const terms: CommitSearchTerm[] = [];
  const appendText = (value: string) => {
    for (const token of value.trim().split(/\s+/)) {
      if (token) terms.push({ field: "text", value: token.toLocaleLowerCase() });
    }
  };
  appendText(query.slice(0, markers[0].index));

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const field = marker[1].toLowerCase() as "author" | "msg" | "hash";
    const valueStart = (marker.index ?? 0) + marker[0].length;
    const valueEnd = index + 1 < markers.length ? markers[index + 1].index! : query.length;
    let value = query.slice(valueStart, valueEnd).trim().toLocaleLowerCase();
    if (!value) {
      // A bare known prefix has no useful scoped meaning; preserve it as text
      // instead of accidentally making every commit match an empty scope.
      appendText(`${field}:`);
      continue;
    }
    if (field === "hash" && /^0x[0-9a-f]+$/i.test(value)) value = value.slice(2);
    terms.push({ field, value });
  }
  return terms;
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

export const generatedDiffScheme = "git-rebase-visual-generated-diff";

export interface GeneratedDiffUriComponents {
  scheme: string;
  authority: string;
  path: string;
  query: string;
}

/** Pure URI shape for a private, non-untitled generated Diff snapshot. */
export function generatedDiffUriComponents(id: string): GeneratedDiffUriComponents {
  return {
    scheme: generatedDiffScheme,
    authority: "snapshot",
    // The suffix selects VS Code's built-in Diff language while the provider
    // remains read-only (unlike an editable `untitled:` text document).
    path: "/snapshot.diff",
    query: encodeURIComponent(id),
  };
}

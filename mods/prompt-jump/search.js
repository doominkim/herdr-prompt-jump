// Filtering the prompt list by what the person types in the panel's search box.

/** The prompts containing every whitespace-separated word of `query`, ignoring case, in their order */
export function searchPrompts(prompts, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return prompts;
  return prompts.filter((p) => {
    const text = p.text.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

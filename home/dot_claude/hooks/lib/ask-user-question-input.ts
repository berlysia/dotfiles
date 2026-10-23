// lib/ask-user-question-input.ts
//
// Reads of the AskUserQuestion tool input shared by document-workflow-guard
// and ask-preflight. A leaf with no imports: the guard runs before every
// tool call, so a load failure here would stop all of them.

/** `answers` or `annotations` is present and not undefined. */
export function hasPrefilledAnswer(toolInput: unknown): boolean {
  if (typeof toolInput !== "object" || toolInput === null) return false;
  const input = toolInput as { answers?: unknown; annotations?: unknown };
  return input.answers !== undefined || input.annotations !== undefined;
}

/**
 * Each question's text followed by its option labels, in order. Option
 * descriptions and headers are left out on purpose: they explain a choice
 * rather than state the operation being asked about.
 *
 * Null when the input is not the expected shape or reading it throws, so the
 * caller can tell "nothing to look at" from "could not look".
 */
export function extractQuestionTexts(toolInput: unknown): string[] | null {
  try {
    if (typeof toolInput !== "object" || toolInput === null) return null;
    const questions = (toolInput as { questions?: unknown }).questions;
    if (!Array.isArray(questions)) return null;
    const texts: string[] = [];
    for (const q of questions as unknown[]) {
      if (typeof q !== "object" || q === null) return null;
      const { question, options } = q as {
        question?: unknown;
        options?: unknown;
      };
      if (typeof question !== "string") return null;
      texts.push(question);
      if (options === undefined) continue;
      if (!Array.isArray(options)) return null;
      for (const o of options as unknown[]) {
        if (typeof o !== "object" || o === null) return null;
        const label = (o as { label?: unknown }).label;
        if (typeof label !== "string") return null;
        texts.push(label);
      }
    }
    return texts;
  } catch {
    return null;
  }
}

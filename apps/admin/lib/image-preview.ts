import { isHttpsUrl } from "@repo/security/href";

/**
 * The `src` an image field may preview for whatever the operator typed or
 * pasted, or null when it mustn't be previewed.
 *
 * Only an https:// address qualifies — the same rule the save applies
 * (`httpsUrl()` in lib/schema-fields.ts) — so a `javascript:`/`data:` link
 * never reaches the DOM. What does is percent-encoded with `encodeURI`, so
 * spaces, quotes and angle brackets can't travel into the attribute raw
 * (it's also the sanitiser CodeQL's js/xss-through-dom recognises); the
 * `replace` undoes the double-encoding that gives escapes the link already
 * had (`%20` → `%2520`).
 */
export function previewSrc(value: string): string | null {
  const typed = value.trim();
  if (!typed.startsWith("https://") || !isHttpsUrl(typed)) return null;
  try {
    return encodeURI(typed).replace(/%25([0-9A-Fa-f]{2})/g, "%$1");
  } catch {
    // encodeURI throws on a lone surrogate — nothing worth previewing.
    return null;
  }
}

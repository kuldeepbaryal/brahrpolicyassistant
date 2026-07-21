/**
 * Merges class names, filtering out falsy values.
 * Intentionally dependency-free to keep the bundle lean.
 */
export function cn(...classes: (string | undefined | null | false | 0)[]) {
  return classes.filter(Boolean).join(" ");
}

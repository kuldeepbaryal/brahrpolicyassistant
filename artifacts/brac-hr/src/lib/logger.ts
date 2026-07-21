/**
 * Structured JSON logs for Cloud Logging. `severity` is the field Cloud
 * Logging keys on. We log a salted hash of the user id — never the email —
 * and never question contents at INFO (see README retention note).
 */
import { createHash } from "crypto";

type Fields = Record<string, unknown>;

function emit(severity: "INFO" | "WARNING" | "ERROR", message: string, fields: Fields = {}) {
  const line = JSON.stringify({
    severity,
    message,
    time: new Date().toISOString(),
    ...fields,
  });
  if (severity === "ERROR") console.error(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: Fields) => emit("INFO", message, fields),
  warn: (message: string, fields?: Fields) => emit("WARNING", message, fields),
  error: (message: string, fields?: Fields) => emit("ERROR", message, fields),
};

/** Stable pseudonymous id for logs/metrics — not reversible to an email. */
export function hashUser(sub: string): string {
  return createHash("sha256").update(`brac-hr:${sub}`).digest("hex").slice(0, 16);
}

// Hides secret values in any text that might be shown or stored. Applied to every error message, call-log line and
// result the provisioner produces. A value shorter than six characters is not treated as a secret (it would blank
// ordinary words); real tokens and keys are far longer.

const MIN_SECRET_LENGTH = 6;
export const HIDDEN = "[hidden]";

export function createRedactor(secrets: Iterable<string>): (text: string) => string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(JSON.stringify(secret).slice(1, -1)); // as it appears inside a JSON string
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const form of ordered) out = out.split(form).join(HIDDEN);
    return out;
  };
}

/** The names of the secrets found in `text`, for tests and for a final scan before anything is written to disk. */
export function findSecrets(text: string, secrets: Record<string, string>): string[] {
  return Object.entries(secrets)
    .filter(([, value]) => value.length >= MIN_SECRET_LENGTH && (text.includes(value) || text.includes(encodeURIComponent(value))))
    .map(([name]) => name);
}

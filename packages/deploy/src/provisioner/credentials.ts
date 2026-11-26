// Where the account id and the API token come from: the environment, and nowhere else. The tool never opens a file for
// them and never takes them as arguments (an argument shows up in a process list and in shell history). A problem is
// reported by naming the variable, never by showing a value. An env file kept outside the repositories can be loaded by
// Node itself (`node --env-file=<path> ...`) before this code runs; this code does not know a file was involved.

export interface Credentials {
  token: string;
  accountId: string;
}

export class CredentialsError extends Error {
  constructor(problems: string[]) {
    super(`${problems.join("; ")}. They are read from the environment only (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).`);
    this.name = "CredentialsError";
  }
}

export function loadCredentials(env: Record<string, string | undefined> = process.env): Credentials {
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const problems: string[] = [];
  if (token === "") problems.push("CLOUDFLARE_API_TOKEN is not set");
  else if (/[\s"']/.test(token)) problems.push("CLOUDFLARE_API_TOKEN has a space, a line break or a quote in it");
  else if (/^[0-9a-f]{37}$/i.test(token)) problems.push("CLOUDFLARE_API_TOKEN looks like a Global API Key (37 hex characters): use a scoped API token; the key is never sent");
  if (accountId === "") problems.push("CLOUDFLARE_ACCOUNT_ID is not set");
  else if (!/^[0-9a-f]{32}$/.test(accountId)) problems.push("CLOUDFLARE_ACCOUNT_ID is not 32 hexadecimal characters");
  if (problems.length > 0) throw new CredentialsError(problems);
  return { token, accountId };
}

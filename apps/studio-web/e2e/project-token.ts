// Story 0.15: every Studio MCP token is bound to one project. The seeded E2E_MCP_TOKEN is bound to "acme-saas"; a spec that
// drives another project gets that project's own token here, issued the way a real client gets one: Alice (the Acme owner)
// signs in, the project is created in Acme if it does not exist yet, and Alice issues a token bound to it.
const API = "http://127.0.0.1:8787";
const ALICE = { email: "alice@example.com", password: "password12345" };
const tokens = new Map<string, string>();

async function api(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function aliceCookie(): Promise<string> {
  const res = await api("/api/auth/sign-in/email", { body: ALICE });
  if (!res.ok) throw new Error(`Alice could not sign in: HTTP ${res.status}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!cookie) throw new Error("Alice's sign-in returned no session cookie");
  return cookie;
}

/** The org that holds `project`, among Alice's orgs; null when it does not exist yet. */
async function orgOf(cookie: string, project: string, orgIds: string[]): Promise<string | null> {
  for (const orgId of orgIds) {
    const res = await api(`/api/projects?orgId=${encodeURIComponent(orgId)}`, { cookie });
    if (!res.ok) continue;
    const body = (await res.json()) as { projects?: Array<{ project: string }> };
    if (body.projects?.some((p) => p.project === project)) return orgId;
  }
  return null;
}

/** A bearer token bound to `project` (created in Acme first if it does not exist), for "Claude Desktop". */
export async function e2eProjectToken(
  project: string,
  scopes: readonly string[] = ["read", "edit", "deploy", "connect"],
): Promise<string> {
  const key = `${project}|${scopes.join(",")}`;
  const cached = tokens.get(key);
  if (cached) return cached;

  const cookie = await aliceCookie();
  const orgsRes = await api("/api/orgs", { cookie });
  if (!orgsRes.ok) throw new Error(`could not list Alice's orgs: HTTP ${orgsRes.status}`);
  const orgs = ((await orgsRes.json()) as { orgs: Array<{ id: string; slug?: string }> }).orgs;
  const acme = orgs.find((o) => o.slug === "acme") ?? orgs[0];
  if (!acme) throw new Error("Alice belongs to no org");

  let orgId = await orgOf(cookie, project, orgs.map((o) => o.id));
  if (!orgId) {
    const created = await api(`/api/orgs/${encodeURIComponent(acme.id)}/projects`, { cookie, body: { project } });
    if (created.status !== 201 && created.status !== 409)
      throw new Error(`could not create ${project}: HTTP ${created.status}`);
    orgId = acme.id;
  }

  const issued = await api(`/api/orgs/${encodeURIComponent(orgId)}/mcp-tokens`, {
    cookie,
    body: { clientName: "Claude Desktop", projectId: project, scopes },
  });
  if (issued.status !== 201) throw new Error(`could not issue a token for ${project}: HTTP ${issued.status}`);
  const token = ((await issued.json()) as { token: string }).token;
  tokens.set(key, token);
  return token;
}

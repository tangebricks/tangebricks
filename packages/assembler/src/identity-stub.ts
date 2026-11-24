// The text of src/identity.stub.ts in every assembled project. It is proof scaffolding (C8): it believes whatever a
// request header says, which a real project must never do. The comment says so in the emitted file too.
export const IDENTITY_STUB_SOURCE = `// STUB IDENTITY. For tests and the proof only.
// It trusts the x-test-user header, so anyone can claim to be anyone. Replace it with real verification
// (for example a signed token) before this project serves real users.
export const stubIdentity = async (c, next) => {
  if (c.env?.PX_ENVIRONMENT === "production") return c.json({ error: "stub identity is disabled in production" }, 503);
  const uid = c.req.header("x-test-user");
  if (uid) c.set("user", { uid, email: \`\${uid}@example.com\` });
  return await next();
};
`;

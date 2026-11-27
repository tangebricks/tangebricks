import { useState } from "react";
import type { FormEvent } from "react";
import { fetchStudioOrgs, fetchStudioProjects, signInWithEmail, signUpWithEmail } from "../api.ts";
import { useStudioStore } from "../store.ts";

export function AuthScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setAuth = useStudioStore((s) => s.setAuth);
  const setProjects = useStudioStore((s) => s.setProjects);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result =
        mode === "signin"
          ? await signInWithEmail({ email, password })
          : await signUpWithEmail({ name: name || email.split("@")[0] || "Builder", email, password });

      const orgs = await fetchStudioOrgs();
      const projects = await fetchStudioProjects();
      setAuth(result.user, orgs, orgs[0]?.id ?? null);
      setProjects(projects, projects[0]?.project ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="auth-screen" className="min-h-screen bg-surface-base text-text-primary flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-surface-raised border border-border rounded-lg p-6 shadow-xl">
        <div className="mb-6">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-surface-control text-accent text-xs font-bold tracking-wider uppercase mb-3">
            <span>◆</span>
            <span>ProjectX Studio</span>
          </div>
          <h1 className="text-lg font-bold text-text-primary">{mode === "signin" ? "Sign in to ProjectX Studio" : "Create your Studio account"}</h1>
          <p className="text-xs text-text-muted mt-1">Visual + AI builder for full-stack Cloudflare SaaS backends.</p>
        </div>

        <div className="flex gap-2 mb-4 bg-surface-base p-1 rounded-md border border-border">
          <button
            type="button"
            data-testid="auth-tab-signin"
            onClick={() => {
              setMode("signin");
              setError(null);
            }}
            className={`flex-1 py-1.5 px-3 rounded text-xs font-semibold transition ${
              mode === "signin" ? "bg-surface-control text-text-primary" : "text-text-muted hover:text-text-secondary"
            }`}
          >
            Sign in
          </button>
          <button
            type="button"
            data-testid="auth-tab-signup"
            onClick={() => {
              setMode("signup");
              setError(null);
            }}
            className={`flex-1 py-1.5 px-3 rounded text-xs font-semibold transition ${
              mode === "signup" ? "bg-surface-control text-text-primary" : "text-text-muted hover:text-text-secondary"
            }`}
          >
            Sign up
          </button>
        </div>

        {error && (
          <div role="alert" data-testid="auth-error" className="mb-4 p-3 rounded bg-red-950/60 border border-red-700 text-red-200 text-xs">
            ✕ {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "signup" && (
            <div>
              <label htmlFor="auth-name" className="block text-xs text-text-secondary mb-1">
                Full name
              </label>
              <input
                id="auth-name"
                data-testid="auth-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Asha Founder"
                className="w-full px-3 py-2 rounded bg-surface-control border border-border-strong text-text-primary text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                required
              />
            </div>
          )}

          <div>
            <label htmlFor="auth-email" className="block text-xs text-text-secondary mb-1">
              Email address
            </label>
            <input
              id="auth-email"
              data-testid="auth-email-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="asha@example.com"
              className="w-full px-3 py-2 rounded bg-surface-control border border-border-strong text-text-primary text-xs focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-xs text-text-secondary mb-1">
              Password
            </label>
            <input
              id="auth-password"
              data-testid="auth-password-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full px-3 py-2 rounded bg-surface-control border border-border-strong text-text-primary text-xs focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            data-testid="auth-submit-button"
            className="w-full py-2 px-4 rounded-md bg-accent hover:bg-accent-hover text-text-on-accent font-bold text-xs transition disabled:opacity-50"
          >
            {submitting ? "Authenticating…" : mode === "signin" ? "Sign in with Email" : "Create Account"}
          </button>
        </form>

        <div className="mt-4 pt-4 border-t border-border">
          <a
            href="/api/auth/sign-in/social?provider=github"
            data-testid="auth-github-link"
            className="w-full inline-flex items-center justify-center gap-2 py-2 px-4 rounded-md bg-surface-control hover:bg-slate-700 border border-border-strong text-text-primary text-xs font-semibold transition"
          >
            <span>Continue with GitHub OAuth</span>
          </a>
        </div>
      </div>
    </div>
  );
}

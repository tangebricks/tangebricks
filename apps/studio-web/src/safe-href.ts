// Hrefs that come from the server are rendered only when they are absolute http(s) URLs. Anything else (javascript:,
// data:, vbscript:, relative paths, garbage) yields undefined, so the link renders without an href.
export function safeHref(url: string | null | undefined): string | undefined {
  if (typeof url !== "string" || url.trim() === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
}

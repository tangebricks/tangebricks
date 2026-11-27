# Changelog

## 1.1.0 — named buckets, per-user key, packable

- `trafficArmorMiddleware({ rateLimit })` takes `bucket` (default `armor`), so an app can mount the middleware several
  times with separate counts, and `key: "user"` (the signed-in user's `uid` or `id`, falling back to the IP). The
  defaults are unchanged: bucket `armor`, keyed by IP.
- The package can be packed and installed outside the monorepo: a `files` list, `license` Apache-2.0 with `LICENSE` and
  `NOTICE`, and a README with a "Using outside the monorepo" section.

## 1.0.0 — initial versioned release

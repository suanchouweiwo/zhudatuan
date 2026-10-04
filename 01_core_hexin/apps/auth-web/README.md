# Unified authentication UI

This app owns the approved three-stage sign-in experience at
`accounts.zhudatuan.com`, with optional same-origin mounting at
`www.zhudatuan.com/login/`.

The browser never issues sessions or cross-domain tickets. An independent
accounts page uses an allowlisted top-level POST to the storefront or console
host so that host can create its own HttpOnly cookie. A storefront-embedded
login remains same-origin. Credentials stay in the POST body and never enter a
URL. QR login, enterprise SSO, multi-membership selection and admin step-up
remain visibly unavailable until their authoritative services exist.

Run it from the repository root:

```powershell
npm run dev:auth
```

It uses port `3002` locally. `/api` is proxied to the storefront compatibility
BFF configured by `AUTH_COMPAT_API_ORIGIN` (default `http://127.0.0.1:3000`),
never to the canonical Commerce API on port `3001`.

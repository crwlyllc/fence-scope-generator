# Housecall Pro proxy service

This directory contains a lightweight HTTP proxy that forwards browser requests to the Housecall Pro API. It removes the browser-side CORS limitation by terminating the request on your infrastructure and replaying it server-to-server.

## Features

- Accepts requests on a configurable prefix (defaults to `/api/hcp`).
- Forwards `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` requests to the Housecall Pro API.
- Supports either a stored API key (`HCP_API_KEY`) or a full `Authorization` header (`HCP_AUTH_HEADER`).
- Adds CORS headers so the static scope generator can call it from `https://scope.strongperimeter.com` (or any origin you allow).
- Compatible with Google Cloud Run, Cloud Functions (2nd gen), or any other Node-friendly runtime.

## Configuration

| Variable | Description |
|----------|-------------|
| `PORT` | Port to listen on (default `8080`). |
| `PROXY_PREFIX` | URL prefix to mount the proxy on (default `/api/hcp`). |
| `ALLOWED_ORIGINS` | Comma separated list of origins that can call the proxy (example: `https://scope.strongperimeter.com`). Leave empty to echo the caller or use `*`. |
| `HCP_API_BASE` | Override the upstream base URL. Defaults to `https://api.housecallpro.com`. |
| `HCP_API_KEY` | Raw API key to use if the client does not send one. |
| `HCP_API_KEY_MODE` | Either `bearer` (default) or `basic`. Controls how `HCP_API_KEY` is sent upstream. |
| `HCP_AUTH_HEADER` | Full `Authorization` header value to send upstream. If set, this takes precedence over other auth settings. |
| `MAX_BODY_SIZE` | Optional limit (in bytes) for request payloads. Default is `10485760` (10 MB). |

## Local testing

```bash
cd proxy
npm run start
```

By default the server listens on `http://localhost:8080` and serves the proxy at `http://localhost:8080/api/hcp`. The front-end can point its “API Base URL” input to that address while you test.

## Deploying to Google Cloud Run

1. **Build and push the container:**
   ```bash
   gcloud builds submit --tag gcr.io/PROJECT_ID/hcp-proxy ./proxy
   ```

2. **Deploy to Cloud Run:**
   ```bash
   gcloud run deploy hcp-proxy \
     --image gcr.io/PROJECT_ID/hcp-proxy \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars "ALLOWED_ORIGINS=https://scope.strongperimeter.com" \
     --set-env-vars "HCP_API_KEY=YOUR_API_KEY"
   ```

   Replace `PROJECT_ID`, region, and environment variables with values for your account. If you prefer to store secrets in Secret Manager, reference them with `--set-secrets` instead of `--set-env-vars`.

3. **Update the front-end:**
   After deployment, note the Cloud Run service URL (for example `https://hcp-proxy-xyz.a.run.app`). In the scope generator UI update the “API Base URL” field to that URL plus `/api/hcp` (e.g. `https://hcp-proxy-xyz.a.run.app/api/hcp`).

## Cloud Function (2nd gen) alternative

The same code runs unmodified on Cloud Functions (2nd gen):

```bash
gcloud functions deploy hcp-proxy \
  --gen2 \
  --runtime nodejs18 \
  --region us-central1 \
  --source ./proxy \
  --entry-point handle \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars "ALLOWED_ORIGINS=https://scope.strongperimeter.com" \
  --set-env-vars "HCP_API_KEY=YOUR_API_KEY"
```

Cloud Functions will start the HTTP server and route `/` to the proxy prefix (e.g. `/api/hcp`).

## Front-end expectations

- The Housecall Pro API key is no longer required in the browser. If the key field is left blank, the proxy must provide credentials via `HCP_API_KEY` or `HCP_AUTH_HEADER`.
- When a user supplies a key, the browser sends it only to this proxy. It is never sent directly to `api.housecallpro.com`.
- Ensure your proxy origin is added to `ALLOWED_ORIGINS` so the browser can reach it.

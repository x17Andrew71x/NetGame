# CLAUDE.md

## Project Context

This is a hackathon project. A small team is building something quick and fun in a single session. There is no production environment, no CI/CD, no deployment pipeline. This code will never go to production. Speed and fun are all that matter.

The client is a **single-page React app** built with Vite. **Game picker → per-game login → play** is all one bundle (`vite-plugin-singlefile` inlines JS/CSS into `dist/index.html`). The browser talks to a **Node server** over **Socket.IO** for real-time play; some state (e.g. player name) also uses **localStorage**.

## App flow (client)

1. **Game picker** — Landing grid of game tiles. Only **NetGame** is wired; other tiles are “coming soon” and are not clickable.
2. **NetGame login** — Name input (alphanumeric, max 15, stored in `localStorage`) + Play; optional **← All games** returns to the picker.
3. **Game** — Canvas + Socket.IO sync.
4. **Dead** — Game over + Play again (still NetGame).

**Mock mode:** Set `MOCK_MODE` to `true` at the top of `src/App.jsx` to run the canvas loop without a server.

**API URL:** Production socket/HTTP base is `API_URL` in `App.jsx` (used when not in Vite dev). Dev uses `http://localhost:3000`.

## Where code lives

| Piece | Location |
|--------|-----------|
| UI + game client | `src/App.jsx` |
| Styles | `src/App.css` |
| HTTP + Socket.IO + game tick | `server/index.js` |
| Container image | `Dockerfile` — installs deps, `npm run build`, serves `dist` on port 3000, runs `node --expose-gc server/index.js` |
| Remote deploy helper | `deploy-remote.sh` — reads **`DEPLOY_PASSWORD`** (and optional **`RESTART_TOKEN`**) from **`.env`** in the repo root; builds `linux/amd64`, saves/loads on VPS, runs container with `--network host`. Requires `sshpass`, Docker, and SSH. **Never commit `.env`** — use `.env.example` as a template. |

## Build & deploy (required agent workflow)

The assistant **must** keep artifacts in sync with source and **tell the operator when finished** (or what failed).

### Frontend changes → new `dist/`

Whenever anything that affects the shipped client changes — including **`src/`** (e.g. `App.jsx`, `App.css`), **`public/`** (assets copied into `dist`), **`vite.config.js`**, **`index.html`**, or **`package.json` / lockfile** dependencies used at build time — run a **production Vite build** so `dist/index.html` (single-file bundle) is up to date:

```bash
npm run build
# or, if `vite` is not on PATH:
node node_modules/vite/bin/vite.js build
```

Commit `dist/index.html` when the team tracks built output in git.

### Server / container changes → new image + upload

Whenever anything that affects the **running Node server** or **Docker image** changes — including **`server/index.js`**, **`Dockerfile`**, or client files that must be **baked into the image** (the image runs `npm run build` during `docker build`, so a full image rebuild also refreshes `dist` inside the container) — **rebuild the `linux/amd64` image and deploy** to the VPS using `./deploy-remote.sh` (from bash/WSL with `sshpass` and Docker available), or the equivalent manual `docker build` → `docker save` → `scp` → remote `docker load` / `docker run`.

If deploy cannot run from the environment (e.g. WSL/SSH/`sshpass` unavailable), the assistant must **still run local `docker build`** when possible, then **state clearly** that the operator must run `deploy-remote.sh` (or manual steps) to update production.

### Operator notification

After attempting these steps, the assistant should **explicitly confirm**: e.g. “`dist` rebuilt”, “Docker image built locally”, “deploy to VPS completed”, or “deploy skipped — reason …”.

## Server behavior (summary)

- Serves static files from `dist/` and runs a **~30 Hz** game loop: movement, pellets (including rare **gold** pellets), player eat logic, broadcasts `gameState`.
- **Idle exit:** If there are **zero** Socket.IO clients for `IDLE_RESTART_MS` (default 15 minutes), the process exits so Docker can restart the container (fresh process memory).
- **Maintenance HTTP:** `POST /__netgame/restart` with a valid `RESTART_TOKEN` (body or query) exits the process after responding; wrong token returns 404. Configure via container env vars — **never document real tokens in this file.**
- Optional **manual GC** when Node is started with `--expose-gc` (enabled in Dockerfile).

## How to Work on This Project

- **Bias heavily toward speed over polish.** Skip best practices that slow things down — no tests, no prop-types, no elaborate error handling, no accessibility passes, no TypeScript. Just make it work.
- **Keep things simple.** One component in App.jsx is fine. If the file gets big, that's okay. Don't refactor into multiple components unless it's actually making things easier or the user directs separate components so that two devs can work on different parts of the game.
- **Don't over-engineer.** No state management libraries, no routing, no build optimizations. useState and useEffect are plenty.
- **If something is proving difficult or complex to implement, say so.** Suggest a simpler alternative. For example: "That physics simulation would take a while — want me to do a simpler version where things just bounce off walls?" The operator will often take the easier route.
- **Do not create README, CHANGELOG, or any other documentation files** unless specifically requested by the operator. **CLAUDE.md** is the exception: keep it updated when the operator asks for project documentation.

## Design Documents

Any design documents, references, or mockups for this project will be in the `/design` folder.

## Tech Setup

- Vite + React
- Dev: `npm run dev` (Vite `--host` so LAN teammates can open the app). For full multiplayer locally, run the server: `npm start` (or `node server/index.js`) on port 3000.
- Production build: `npm run build` → output in `dist/`
- All game UI and client logic: `src/App.jsx`
- Styling: `src/App.css`

## Style

- No linter, no formatter configured. Don't worry about code style.
- CSS are preferred over inline styles so that users can rapidly adjust styles at the end of the build.
- `console.log` for debugging is encouraged.

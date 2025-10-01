
# Agents.md — Discord Activity Multiplayer Template (Phaser + TypeScript + Colyseus + Express)

This repository is a **two‑package monorepo** for a Discord Activity built with **Phaser (client)** and **Colyseus + Express (server)**.

- **Client**: Vite + TypeScript + Phaser (`packages/client`)
- **Server**: Colyseus rooms + Express API (`packages/server`)

The client connects to the server using **WebSockets**:
- **Dev** (when opening `http://localhost:3000`): `ws://localhost:3001`
- **Prod** (when served behind a hostname): `wss://<host>/.proxy/api/colyseus`

The server serves the client’s `dist/` **statically in production** (`NODE_ENV=production`).

---

## Repository layout

```
packages/
  client/
    src/…               # Phaser game (scenes, assets, Discord SDK helper)
    public/…            # static assets
    dist/               # ✅ prebuilt client (index.html + /assets)
    vite.config.ts      # dev server on :3000; proxies API to :3001
    package.json        # scripts: dev | build | preview
  server/
    src/server.ts       # Express + Colyseus bootstrap (PORT defaults to 3001)
    src/rooms/GameRoom.ts, src/schemas/GameState.ts
    dist/server.js      # transpiled server entry (requires node_modules)
    package.json        # scripts: dev | build | start
package.json            # convenience scripts (cloudflared helpers, etc.)
```

**Ports**
- Client dev: **3000** (Vite)
- Server dev: **3001** (Express + Colyseus)

**Vite proxy**
- In dev, Vite proxies `/.proxy/api/*` to `http://localhost:3001/*` and enables HMR.
- In production, the server mounts the client `dist/` and exposes routes under `/.proxy/api`.

---

## Environment variables

Create a root `.env` (at the repo root) when you want to test inside Discord:
```
VITE_CLIENT_ID=<your Discord Activity client id>
CLIENT_SECRET=<your Discord Activity client secret>
PORT=3001
NODE_ENV=development
```
> **Tip:** When **not embedded** (i.e., you open the client in a normal browser without `frame_id`), the code uses `DiscordSDKMock`. You can test locally **without Discord OAuth**.

---

## Install & Run (Full local dev – Internet available)

> Works on any machine with Node ≥ **18** (repo sets `>=21` but 18+ is fine for dev). Use **two terminals**:

### 1) Server
```bash
cd packages/server
npm install
npm run build
npm run dev          # runs Express + Colyseus on http://localhost:3001
```

### 2) Client
```bash
cd packages/client
npm install
npm run dev          # opens Vite on http://localhost:3000
# The client will auto-connect to ws://localhost:3001
```

### Test
Open **http://localhost:3000** in a browser. Because you’re not embedded in Discord, the app switches to **DiscordSDKMock** and runs without OAuth.

---

## Single‑port Production Preview (serve client from the server)

This serves `packages/client/dist/` via Express and proxies websocket + API under `/.proxy/api`:

```bash
# Ensure a client build exists (it already does in this repo)
cd packages/client
npm install
npm run build         # (optional if /dist already present)

# Start the server in production mode
cd ../server
npm install
npm run build
NODE_ENV=production PORT=3001 node dist/server.js
# Visit http://localhost:3001   (server will serve the built client)
```

The client will connect to `wss://<host>/.proxy/api/colyseus` when not on localhost.

---

## How to test inside **Codex** (no Internet)

Codex sandboxes **cannot fetch npm packages**, so anything that **requires `npm install` will fail** unless the dependencies are already included.

You have **three workable options** inside Codex:

### A) **Client‑only** UI check (no server, no networking)
Use the prebuilt client in `packages/client/dist/` to verify the Phaser UI boots and the Discord mock flows:

```bash
# In Codex terminal
cd packages/client/dist
python -m http.server 8000
# Then open the served index.html from the file browser if supported, or use the provided preview link.
```
- You will see the menu and assets load.
- The game will **fail to connect** to a Colyseus room (expected offline). The UI will show “Connection failed”. This still confirms client assets + DiscordSDKMock + scene boot are working in the sandbox.

**Optional quick tweak (safe for Codex):**
If you want the game to silently skip networking in Codex, add this small guard in `packages/client/src/scenes/Game.ts` and rebuild outside Codex:
```ts
// near the top of connect():
if (import.meta.env?.VITE_OFFLINE === "1" || new URLSearchParams(location.search).get("offline") === "1") {
  console.log("Offline mode: skipping Colyseus connect()");
  return;
}
```
Then build locally (`npm run build`) and re‑upload the updated `dist/` to Codex. Open `/index.html?offline=1`.

### B) **Full stack in Codex with prebundled server** (recommended preparation)
Before uploading to Codex, bundle the server **with its dependencies included** into a single file. Two easy bundlers:

**Using @vercel/ncc:**
```bash
# On your own machine (with Internet)
cd packages/server
npm install
npm install -D @vercel/ncc
npm run build
npx ncc build dist/server.js -o dist-bundle
# This produces dist-bundle/index.js with node_modules inlined
```

**Using esbuild:**
```bash
npm install -D esbuild
npx esbuild dist/server.js --platform=node --bundle --outfile=dist-bundle/server.cjs
```

Now zip the repo **including** `packages/server/dist-bundle/` and `packages/client/dist/`, upload to Codex, and run:

```bash
cd packages/server
NODE_ENV=production PORT=3001 node dist-bundle/index.js    # (or server.cjs if using esbuild)
# Open the preview URL at http://localhost:3001
```

Because the server serves the client’s `dist/`, this gives you a **working end‑to‑end test** in Codex without any online installs.

### C) **Full stack in Codex with vendored node_modules**
Alternatively, on your machine run `npm install` in **both** `packages/client` and `packages/server`, then zip the repo **including the `node_modules/` directories**. Upload that zip to Codex and run the normal scripts:

```bash
# Server
cd packages/server
npm run build
npm run dev     # or: NODE_ENV=production PORT=3001 node dist/server.js

# Client (dev) – requires Vite already present in node_modules
cd ../client
npm run dev
```
This produces a dev setup on ports 3000/3001 inside Codex. The zip will be much larger, but no Internet is required.

---

## CLI, scripts, and useful commands

### Client (packages/client)
- `npm run dev` – Vite dev server on **:3000**
- `npm run build` – emits to `dist/`
- `npm run preview` – serves the built app

### Server (packages/server)
- `npm run dev` – hot‑restarts server from `src/` (via `dev-command.js`)
- `npm run build` – TypeScript → `dist/`
- `npm run start` – builds then runs dev mode
- `npm run start:prod` – `NODE_ENV=production PORT=3000 node dist/server.js`
- `npm run debug:start` – build then run with Node inspector

### Root
- Convenience scripts for **cloudflared** exist, but **not usable in Codex** (no Internet).
- Ignore `pnpm`-specific `dev` script at root if you’re using plain `npm`. Work directly in each package as shown above.

---

## Testing scenarios

1. **Local browser, not embedded (no OAuth)**  
   - Start server (:3001) and client dev (:3000).  
   - Open `http://localhost:3000`. The app uses `DiscordSDKMock`; you can start a room and see Colyseus state sync.

2. **Production‑like single host**  
   - Build client; run server with `NODE_ENV=production`.  
   - Open `http://localhost:3001`. Client connects over `/.proxy/api/colyseus` (wss).

3. **Codex offline (client‑only)**  
   - Serve `packages/client/dist/` with a simple HTTP server.  
   - Expect a network error message; add the optional `offline` guard if you want to suppress it.

4. **Codex offline (full stack)**  
   - Prebundle server (Option B) **or** vendor `node_modules` (Option C) before uploading.

---

## Troubleshooting

- **“Could not connect with the server” in the client**  
  Server not running or blocked. In dev, ensure:
  - `http://localhost:3001` is up
  - You can reach `http://localhost:3001/.proxy/api/colyseus` (in prod) or WS at `ws://localhost:3001` (in dev)

- **OAuth errors / Discord SDK handshake**  
  Only happens **when embedded** inside Discord (`frame_id` exists). Outside Discord, the app uses **DiscordSDKMock** and skips OAuth. For embedded tests you must set `VITE_CLIENT_ID` and `CLIENT_SECRET`, and expose `POST /api/token` (server handles this).

- **Port conflicts**  
  Change ports via `.env` (e.g., `PORT=4001`) and update your reverse proxy or dev URLs accordingly.

- **Codex: npm install fails**  
  Normal—Codex has **no Internet**. Use **Option B (prebundle)** or **Option C (vendor node_modules)**.

---

## URLs (when running locally)

- Client (dev): `http://localhost:3000`
- Server (dev): `http://localhost:3001`
- Colyseus monitor (dev): `http://localhost:3001/colyseus`
- Production single‑host: `http://localhost:3001` (serves client), API under `/.proxy/api`

---

## Minimal “offline guard” patch (client)

If you’d like a ready‑to‑apply diff to add an offline switch (useful for Codex demos):

```diff
diff --git a/packages/client/src/scenes/Game.ts b/packages/client/src/scenes/Game.ts
@@
   private async connect() {
+    // Allow a hard offline switch for sandboxed environments (e.g., Codex)
+    const params = new URLSearchParams(location.search);
+    if (import.meta.env?.VITE_OFFLINE === "1" || params.get("offline") === "1") {
+      console.log("[offline] Skipping Colyseus connect()");
+      this.scoreText?.setText("Offline mode");
+      return;
+    }
     const url =
       location.host === "localhost:3000"
         ? `ws://localhost:3001`
         : `wss://${{ '{' }}location.host{{ '}' }}/.proxy/api/colyseus`;
     const client = new Client(`${{ '{' }}url{{ '}' }}`);
```

Rebuild the client (`npm run build`) and re‑upload the updated `dist/` to Codex. Then open:  
`/index.html?offline=1`

---

**That’s it!** This doc is tailored for local dev, production‑like runs, and Codex’s offline sandbox. If you want me to fold the offline guard into the code and return a refreshed `dist/`, say the word.

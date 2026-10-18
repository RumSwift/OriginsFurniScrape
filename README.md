# furni-imager (Node.js)

Syncs the Habbo Origins furniture bundles listed in `furniture-index.json`, unpacks every sprite to its own folder, and serves an API that composes furniture like the client (layers, directions, states, colours).

Node 22.13+, Fastify, pngjs + gifenc (pure JS images), built-in `node:sqlite`. No native dependencies, so it runs on any CPU (including basic virtual CPUs). Single process.

## Coolify
1. New resource → Git repo (or upload) → Build pack **Dockerfile**, port **8000**.
2. **Storage** tab → add a persistent volume mounted at `/data`.
3. **Environment**: copy `.env.example`; set `ADMIN_TOKEN` and a real contact in `SYNC_USER_AGENT`.
4. Add a domain and deploy. The first sync runs on start (~1,850 bundles, ~100 MB; at the slow defaults expect roughly 15-30 min). Watch `/healthz`.

Run one replica only (sqlite + the in-process scheduler).

## Local
    npm install
    DATA_DIR=./data npm start             # API + scheduler
    DATA_DIR=./data npm run sync -- --only ads_goldtabl --force
    DATA_DIR=./data npm run sync -- --list-new 7
    npm test

## Data layout (`/data`)
- `hcb/<bundle>/<rev>-<sha>.hcb` raw downloads (`KEEP_RAW`)
- `furni/<bundle>/sprites/<name>.png`, `text/`, `meta.json` unpacked images
- `cache/` rendered output, `catalogue.sqlite` index with `first_seen` per bundle

## API
- `GET /furni?q=prefix`, `GET /furni/new?days=7` (newly seen bundles, for news posts), `GET /furni/{class}`
- `GET /render/{class}?direction=0-7&state=N&frame=N&size=64|32&colors=hex,hex&shadow=1&scale=1-4&bg=hex&pad=N&format=png|gif&fps=15`
  (gif animates the state; response headers `X-Origin-X/Y` give the tile anchor inside the image; ETag supported)
- `GET /render/{class}/sheet`, `GET /furni/{class}/icon`, static `/assets/<bundle>/sprites/...`
- `POST /admin/sync?force=1`, `GET /admin/status` with `Authorization: Bearer $ADMIN_TOKEN`

## Caveats (unverified; please check against the client)
- Missing directions fall back to the mirrored one `(6-d)%8`; disable with `mirror=0`.
- Layer ordering uses the sign convention positive z-shift = in front.
- Background removal defaults to an edge flood-fill (`matte=edge`); `matte=exact` strips only pure white.
- Colour variants multiply grey parts by the colour; `class*N` needs `FURNIDATA_URL`.
- Animation timing is a flat `fps`; the client's real timing isn't decoded.
- `data/` holds client data decoded from the game's runtime pack: `furniture-aliases.json` (the flip table: dir 4/6 are flipped aliases of 2/0) and
  `classmap.json` (which behaviour script a class runs). Animation follows the client scripts: barrier glow blinks 20 ticks on / 26 off, gates are
  closed=0 / open=1, lamps / dragon lamp / fan switch on=1 (the dragon lamp and fan cycle a layer). One tick = one client frame = 1/15 s.
  Unverified: ink 40/41 formulas, sprite 5 = layer `e` for the barrier, `.data` `random`/`sequences` (first sequence used), the real update rate.
- Only the `ads_goldtabl` bundle was tested against real data (2 directions, no states); animation and mirroring are covered by synthetic tests. Multi-direction and animated real items are the real test.
- Download politeness: my automated fetch of the index host was refused under its robots rules, so confirm an acceptable rate with Sulake. Defaults: 2 workers, 0.3 s delay, backoff, stops on 401/403 or repeated failures.

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

## How rendering follows the client
Floor items go through `src/client.js`, a transcription of the client's Lingo (Active Object Class, Active Object Extension Class and the
Divider / Lamp / DragonLamp / Fan / Barrier scripts):
- Direction search on layer `a`: the requested direction, else direction 0, else the next direction up (placeholder past 7). Other layers: the
  object's direction, else direction 0. The sprite list stops at the first missing layer letter.
- Flips come from the alias tables (`data/furniture-aliases.json` and the bundle's `memberalias.index`, `*` = flipped). Flipped sprites and
  shadows mirror around the regPoint and move one tile (`pXFactor`) right. Draw order = `zshift[dir] + (sprite number - 6)`; `locshift` per direction.
- Classes with a `.data` member and no script of their own run the extension engine: data layer *i* (sorted) drives sprite *i* with
  `<class>_<L>_0_<x>_<y>_<dir>_<frame>`, exact direction, no fallback (so a `.data` item has nothing to draw in a direction it has no sprites for).
  State ids are the `.data` values (server stuffdata + 1). `loop`, `delay`, `blend`, `random` and `sequences` are simulated (random draws are seeded).
- Behaviour scripts change frames by renaming the sprite's current member (its flip and position stay); the divider first tries
  `<...>_<dir>_1` (fresh flip, no locshift); the lamp re-derives `b`/`c` from layer `a`'s member and puts them 2 / 4 above it.
- Inks: 8 (matte) uses the bundle's pre-baked ink-8 alpha (else every exactly-white pixel transparent, the client's policy); 36 the
  pre-baked ink-36 alpha (else exact white); 41/40 are colour filters (pixels times the part colour, drawn normally) where only white
  touching the border is removed, so white inside a part takes the colour; add/subtract/lightest/darkest drop exact white.
  `matte=edge` / `matte=exact` override this.
- Plants (Furniture Plant Class): stage N = `<class>_<layer>_0_<x>_<y>_<dir>_N`, built from the current member even when stage 0 is shared art.
- Wall items with `.data` (Item Object Extension Class): `<leftwall|rightwall> <class>_<layer>_<frame>` per data layer.
- Shadow: `<class>_sd_<dir>` else `<class>_sd`, at 30% (private rooms draw shadows through the shadow manager at blend 30).
- The gallery shows the rotations the client can turn to (where layer `a` has a member); tick "Also show rotations..." for the rest.
- Wall items: leftwall = 2, rightwall = 4, no tile shift.
- A re-unpack (`POST /admin/reunpack`) also clears the render cache.

## Caveats
- Colour variants multiply the part by the colour; `class*N` needs `FURNIDATA_URL`.
- Scripts other than the ones above (fridges, TVs, trophies, teleports ...) are not emulated; their states are guessed from sprite frames (`states_inferred`).
- Ink 40 (lighten) is treated like 41; no furniture in the client's ink table uses it.
- Download politeness: my automated fetch of the index host was refused under its robots rules, so confirm an acceptable rate with Sulake. Defaults: 2 workers, 0.3 s delay, backoff, stops on 401/403 or repeated failures.

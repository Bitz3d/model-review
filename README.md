# Model Review

A public, static GitHub Pages review site for explicitly authorized 3D models. Visitors can browse static thumbnails and choose whether to download a heavy interactive model. There is no login, admin UI, upload endpoint, analytics, or client secret.

## Publication boundary

Only publish models and thumbnails whose public release has been explicitly authorized. `public/models.json` is the public catalog and the deployment allowlist. The workflow fails if `public/` contains an unlisted file, if a path escapes its allowed folder, if a part/decoded hash or size differs, if the active model is missing, if the GLB triangle count differs, or if an external GLB dependency/required decoder extension is found.

The listed models are full-quality GLBs transported as ordered gzip parts. The original Harabin entry/default is retained; the separately authorized Rollercoaster levels 1/2/3 are public review candidates, not yet human-approved encoded web appearances. Each Rollercoaster entry discloses its existing finite RGB8 normal-shader translation. Publication performs no further geometry or texture conversion. Gzip is transport-only: browser decoding must reproduce the manifest's exact decoded byte count and SHA-256. The Three/R3F viewer code is also loaded only after the visitor starts 3D. Do not rename gzip bytes to `.glb`, and do not describe this heavy desktop-browser review as phone readiness or universal performance.

## Change the active model

Edit only the top-level `activeModel` value in `public/models.json` to match one existing `models[].id`. Commit that manifest change, then use the manually dispatched owner-only publication workflow.

A visitor can link directly to a listed model with:

```text
https://bitz3d.github.io/model-review/?model=MODEL_ID
```

Unknown IDs show a catalog-level 404 message and do not download model data.

## Add an authorized model

1. Put its public thumbnail under `public/previews/`.
2. Gzip the approved GLB without changing its decoded bytes, then split the gzip stream into ordered files under `public/models/`. Keep every part below GitHub's normal 100 MB file limit; parts around 48 MiB are recommended.
3. Add one object to `models` in `public/models.json`. Use a unique lowercase kebab-case `id`. Record every ordered part's relative URL, exact byte count and SHA-256, plus the concatenated gzip byte count/SHA-256 and decoded GLB byte count/SHA-256. Record the verified triangle count and review scene scale.
4. Set `activeModel` to the new ID only if it should be the default.
5. Run the fail-closed validator and local browser review below. Inspect the actual front, quarter, side, and rear views before publishing.
6. Commit only authorized public assets and the intentional site/build changes. Never add source photos, references, `.blend` files, internal reports, private evidence, tokens, or machine-specific paths.

Removing a model is the reverse: choose another valid `activeModel`, remove its manifest object and only its listed public files, then validate again.

## Local build with the existing pinned dependencies

No dependency installation is needed or intended. Link the existing pinned dependency directory into this checkout (adjust the relative path only if these sibling workspaces moved):

```bash
ln -s ../blender-agnet/projects/phoenix/delivery/web_v001/viewer-test/node_modules node_modules
npm run build
python3 scripts/update_dist_lock.py
# Use a fresh output directory; the validator refuses to overwrite an existing one.
python3 scripts/validate_and_stage.py --output _site
```

`vite.config.mjs` uses `base: './'`, so emitted references work at the GitHub Pages repository subpath `/model-review/`. Source maps are disabled. `dist/` and `dist-files.json` are committed; `node_modules/`, `site/`, and `_site/` are not.

For a catalog/asset-only update, a rebuild is unnecessary unless site source changed. Run the validator/stager against the already locked `dist/`.

## Local subpath and browser verification

Use an unused loopback port; do not reuse another review server:

```bash
python3 scripts/serve_local.py --root _site --port 5298
```

Then open `http://127.0.0.1:5298/model-review/`. The browser automation intentionally requires an existing local Playwright installation and installed Chrome; it does not install anything:

```bash
PLAYWRIGHT_PACKAGE=../griplock-hub/frontend/package.json \
  node scripts/verify_browser.mjs \
  --url http://127.0.0.1:5298/model-review/ \
  --out-dir /path/outside/this/repository/browser-run
```

The command above is the preserved first-release Harabin-only regression: its one-card expectations do not match the later four-entry catalog. Current Rollercoaster release verification is maintained outside this public repository and checks each declared model/hash, four camera views, cancellation/retry and disposal. Do not report the legacy command as a passing multi-model test.

Keep screenshots and verification JSON outside this public repository. Desktop Chrome tests are not physical-phone, network, FPS, memory-ceiling, or universal compatibility claims.

## Deployment assembly

The repository keeps one copy of the large assets under `public/`. It does **not** commit a second `site/` copy. Publication uses the committed prebuilt `dist/` plus the manifest-listed files from `public/`:

```bash
python3 scripts/validate_and_stage.py --output _site
```

The script creates `_site/` from only:

- files explicitly hash-locked in `dist-files.json`;
- `public/models.json`;
- thumbnails and transport parts explicitly referenced by that manifest;
- generated `.nojekyll`.

It never copies the whole checkout or the whole `public/` directory. This makes future updates fail closed instead of accidentally publishing unrelated files.

## Current Rollercoaster review

Direct links select a level without downloading it until the visitor presses **Uruchom 3D**:

- https://bitz3d.github.io/model-review/?model=rollercoaster-1
- https://bitz3d.github.io/model-review/?model=rollercoaster-2
- https://bitz3d.github.io/model-review/?model=rollercoaster-3

These controls were already display-normalized/centered, so their manifest `modelScale` is `1`. Full-scene entries at scale at least `1` use camera distance `3.0` to keep the entire footprint visible; the original Harabin scale `0.55` retains distance `2.4`. Lights/materials remain unchanged. Interactive cream background differs from the white source preview captures. The three public files require about57–58 MB of gzip payload each, not a mobile-readiness guarantee.

## Owner-only manual publication

`.github/workflows/publish.yml` has only `workflow_dispatch`; there are no push or pull-request deployment triggers. The deployment job additionally requires repository `Bitz3d/model-review`, branch `main`, and both the original `github.actor` and any `github.triggering_actor` on a rerun to equal `Bitz3d`. It uses official GitHub Pages actions and least-purpose permissions (`contents: read`, `pages: write`, `id-token: write`).

The repository owner configures Pages for GitHub Actions and the `github-pages` environment with a main-only deployment branch policy. Public visitors cannot dispatch a workflow without repository write permission, and the workflow's explicit owner checks also reject other actors. Do not grant write access to reviewers.

To publish: open **Actions → Publish authorized model review → Run workflow**, select **main**, and confirm. Committing a new model or changing `activeModel` does not deploy Pages automatically. Pushing assets to this public repository does make them publicly downloadable before the Pages workflow is dispatched, so explicit public-release authority is required before pushing as well. The public URL is https://bitz3d.github.io/model-review/ . Model files and the repository are public and downloadable; publication is owner-controlled, not private access.

# Hackathon credentials & branches — kajota-mesh

One section per active hackathon target on this repo. Each section
pins:

- the dedicated branch
- where local secrets live (gitignored)
- which `.env.<hack>.example` template seeds local config
- the human-side credential-mint steps (gcloud / dashboard / faucet)

Branches use the `hackathon/<id>` convention, mirroring the existing
`hackathon/coach` / `hackathon/coach-agent-v2` branches across the
KaJota repos.

---

## Mantle Turing Test (Jun 15, 2026)

| | |
|---|---|
| **Branch** | `hackathon/mantle-turing` |
| **Local env** | `.env.mantle-turing` (gitignored; template `.env.mantle-turing.example`) |
| **Secret store** | `secrets/mantle-turing/` (gitignored; `.gitkeep` keeps the dir) |
| **Render env group** | _(none yet — add once a hosted service exists for this hack)_ |
| **GCP service account** | _(not used on this hack)_ |

### Credentials to mint

1. **Mantle Sepolia deployer EOA.** Generate fresh (e.g.
   `cast wallet new`) and fund via
   <https://faucet.sepolia.mantle.xyz>. Set as
   `DEPLOYER_PRIVATE_KEY` in `.env.mantle-turing`.
2. **Mantlescan API key.** Create at
   <https://explorer.sepolia.mantle.xyz/api-keys> — needed for
   contract verification on deploy. Set as `MANTLESCAN_API_KEY`.
3. **Managed Mantle RPC** _(optional, recommended)_. Alchemy /
   QuickNode endpoint. Set as `MANTLE_SEPOLIA_RPC` to avoid public
   rate limits during dev loops.

### TODO before the demo

- [ ] Mantle Turing track prize prompt published → pin
      Turing-specific env vars in `.env.mantle-turing.example`
      (replace the placeholder `TURING_TEST_TODO`).
- [ ] Confirm Mantle Sepolia USDC address; pin in template under
      `USDC_MANTLE_SEPOLIA`.
- [ ] First successful Mantle Sepolia deploy → record tx hash + addr
      in this doc under "Deployed".

### Deployed

_(none yet — fill once the first deploy lands)_

---

## Adding a new hackathon

1. Cut the branch off `main`: `git checkout -b hackathon/<id>`.
2. Copy `.env.mantle-turing.example` → `.env.<id>.example` and
   adjust.
3. `mkdir -p secrets/<id> && touch secrets/<id>/.gitkeep`.
4. Add a new top-level section to this file mirroring the structure
   above.
5. The repo `.gitignore` already covers `.env.<anything>` and
   `secrets/**/*` (with `.gitkeep` un-ignored) — no changes needed.

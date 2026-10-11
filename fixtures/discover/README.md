# fixtures/discover

Captured 2026-10-10 with read-only calls (`audible collections wishlist list -o json`,
`audible api GET /1.0/catalog/products/<asin>` and `.../sims`), then SCRUBBED: titles, names,
summaries, image hosts, and wishlist dates are synthetic ("Sample ..."), ASINs are placeholders.
The shapes and value ranges (runtimes, ratings, lengths) are real. Do not edit.

| File | What |
|---|---|
| wishlist-list.json | `audible collections wishlist list -o json`, first 6 of 89 entries (SCRUBBED) |
| catalog-product.json | `audible api GET /1.0/catalog/products/<asin>`, `result.product` kept, scrubbed (SYNTHETIC text) |
| catalog-sims.json | `audible api GET /1.0/catalog/products/<asin>/sims`, first 3 items, scrubbed |

Write commands (`audible collections wishlist add|remove`) were NOT run; their argv is only built and tested.

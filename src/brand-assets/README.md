# Brand assets

Editable marks from the 2026-09 brand, refined for aligned eyes and a clearer barcode at small sizes. Navy `#14213D`, teal `#00C2A8`.
Wordmark is live type (`Inter, Helvetica, Arial, sans-serif`), lowercase `botpasses`,
no `.com`.

| File | Use |
| --- | --- |
| `mark.svg` | Navy ticket. Light surfaces: site header, console rail. |
| `mark-on-dark.svg` | White ticket. Dark surfaces and social cards. |
| `favicon.svg` | Simplified eyes / perforation / barcode on a navy tile. 16 px and home-screen icons. The full ticket muddies at favicon size. |
| `source/` | Original PNG lockups and marks, retained as brand references. Derived icons are rendered from `favicon.svg`. |

Rebuild derived files after changing an SVG:

```
cp src/brand-assets/favicon.svg site/public/favicon.svg
cp src/brand-assets/mark.svg site/public/mark.svg
cp src/brand-assets/mark-on-dark.svg site/public/mark-on-dark.svg
node site/scripts/write-icons.mjs
npm --prefix site run og
```

Social cards use the same brand tokens and tagline as the site. They are rendered from HTML with local fonts, so typography and colors remain reproducible. No generated raster artwork is required.

# Brand assets

Source lockups and marks from the 2026-09 brand. Navy `#14213D`, teal `#00C2A8`.
Wordmark is live type (`Inter, Helvetica, Arial, sans-serif`), lowercase `botpasses`,
no `.com`.

| File | Use |
| --- | --- |
| `mark.svg` | Navy ticket. Light surfaces: site header, console rail. |
| `mark-on-dark.svg` | White ticket. Dark surfaces and social cards. |
| `favicon.svg` | Simplified eyes / perforation / barcode on a navy tile. 16 px and home-screen icons. The full ticket muddies at favicon size. |
| `source/` | Official PNG lockups and marks. Do not edit; replace the set when the brand file changes. |

Rebuild derived files after changing an SVG:

```
cp src/brand-assets/favicon.svg site/public/favicon.svg
cp src/brand-assets/mark.svg site/public/mark.svg
cp src/brand-assets/mark-on-dark.svg site/public/mark-on-dark.svg
node site/scripts/write-icons.mjs
node site/scripts/og.mjs
```

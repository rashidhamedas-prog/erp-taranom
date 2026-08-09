# ORCH — Mount product-variants router

Implementer (`cursor:app1`) must **not** edit `server/server.js`.

## Required mount

Near the existing products mount:

```js
app.use('/api/products', require('./routes/products'));
app.use('/api/product-variants', require('./routes/product-variants'));
```

Router file: `server/routes/product-variants.js` (exports Express router).

## Sync capture

`server/sync/capture.js` already maps (specific before general):

- `/api/product-variants/colors` → `product_colors`
- `/api/product-variants/sizes` → `product_sizes`
- `/api/product-variants/generate-matrix` → `product_variants`
- `/api/product-variants/ensure-default` → `product_variants`
- `/api/product-variants` → `product_variants`

## Also see

`server/lib/product-variants/ORCH-DB.md` for `initProductVariantsSchema` + `sync_seq_backfill_v7`.

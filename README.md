# Grocery Budget

Mobile-first static budget tracker for grocery spending. Data lives in `public/data.json`; access is gated by a password hash in `public/config.json`.

## Develop

```bash
npm install
npm run dev
```

## Deploy

Pushes to `main` run [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) and publish to GitHub Pages at `/grocery-budget/`.

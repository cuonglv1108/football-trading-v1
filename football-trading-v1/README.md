# Football Trading V1

Minimal live scanner for the V1 football trading rules.

## Important data-safety behavior

The app now shows **no fixtures by default** until a verified live provider is connected. This prevents synthetic or historical test fixtures from being mistaken for real live matches.

Optional demo data exists only for UI testing. To enable it deliberately:

```bash
ENABLE_DEMO_DATA=true npm run dev
```

Demo mode is clearly labeled in the interface and uses generic DEMO team names.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## V1 focus

- MLS
- Allsvenskan
- Liga MX
- Prematch corner line >= 10
- Prematch goals line >= 2.75
- HT follow-up according to the V1 rule engine

## Next step

Connect a verified live match/statistics provider and a bookmaker-odds provider. The UI should only switch to `LIVE` mode when the backend is receiving verified current data.

# Scout Backend

Product research agent — scans TikTok, Amazon, and Reddit every 3 hours and scores products.

## Setup

1. Deploy to Railway
2. Set environment variable: `APIFY_TOKEN=your_token_here`

## API

- `GET /health` — server status
- `GET /products` — latest scored products
- `POST /scan` — trigger manual scan

## Scoring weights

- TikTok velocity: 40%
- Amazon BSR movement: 30%
- Reddit organic buzz: 15%
- Margin estimate: 15%

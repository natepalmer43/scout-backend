const express = require('express');
const cron = require('node-cron');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let products = [];
let lastScan = null;
let scanLog = [];
let scanning = false;

// ─── Claude research engine ───────────────────────────────────────────────────

async function researchProducts() {
  console.log('Running Claude product research...');

  const prompt = `You are a dropshipping product researcher. Search the web for physical products trending right now that would make good dropshipping products.

Search for: tiktok trending products this week, amazon best sellers rising, viral products to buy online 2026.

Return ONLY a JSON array, no other text:
[
  {
    "name": "Product Name",
    "category": "home/fitness/kitchen/gadgets/beauty/outdoor/pet/office",
    "tiktok": 75,
    "amazon": 68,
    "reddit": 55,
    "margin": 65,
    "signals": ["tiktok","amazon"],
    "source": "tiktok",
    "retailPrice": "$29.99",
    "wholesaleEstimate": "$8-12",
    "whyTrending": "Specific reason with real data points",
    "whyDropship": "Why good for dropshipping",
    "tiktokUrl": "real url or null",
    "amazonUrl": "real url or null",
    "redditUrl": "real url or null",
    "imageUrl": "real image url or null",
    "searchQuery": "aliexpress search term"
  }
]

Find 10 products. Only physical goods. No food, regulated items, or branded products. signals only includes sources with score >= 65.`;

  try {
    const messages = [{ role: 'user', content: prompt }];

    let response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages,
    });

    // Agentic loop
    let loops = 0;
    while (response.stop_reason === 'tool_use' && loops < 5) {
      loops++;
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`  Searching: ${block.input?.query || '...'}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Search completed',
          });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      });
    }

    const finalText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const clean = finalText.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in response');

    const parsed = JSON.parse(clean.slice(start, end + 1));
    console.log(`Claude found ${parsed.length} products`);
    return parsed;

  } catch (err) {
    console.error('Claude research error:', err.message);
    return [];
  }
}

// ─── Process ──────────────────────────────────────────────────────────────────

function clamp(v) { return Math.min(100, Math.max(0, Math.round(Number(v) || 0))); }

function processProducts(raw) {
  return raw
    .filter(p => p.name)
    .map((p, i) => ({
      id: `p_${Date.now()}_${i}`,
      name: p.name,
      category: p.category || 'general',
      tiktok: clamp(p.tiktok),
      amazon: clamp(p.amazon),
      reddit: clamp(p.reddit),
      margin: clamp(p.margin),
      score: Math.round(clamp(p.tiktok)*0.40 + clamp(p.amazon)*0.30 + clamp(p.reddit)*0.15 + clamp(p.margin)*0.15),
      signals: p.signals || [],
      source: p.source || 'web',
      retailPrice: p.retailPrice || null,
      wholesaleEstimate: p.wholesaleEstimate || null,
      whyTrending: p.whyTrending || '',
      whyDropship: p.whyDropship || '',
      tiktokUrl: p.tiktokUrl && p.tiktokUrl !== 'null' ? p.tiktokUrl : null,
      amazonUrl: p.amazonUrl && p.amazonUrl !== 'null' ? p.amazonUrl : null,
      redditUrl: p.redditUrl && p.redditUrl !== 'null' ? p.redditUrl : null,
      imageUrl: p.imageUrl && p.imageUrl !== 'null' ? p.imageUrl : null,
      searchQuery: p.searchQuery || p.name,
      scannedAt: new Date().toISOString(),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function runScan() {
  console.log(`\n[${new Date().toISOString()}] Starting scan...`);
  const raw = await researchProducts();
  products = processProducts(raw);
  lastScan = new Date().toISOString();
  scanLog.unshift({ scannedAt: lastScan, count: products.length });
  if (scanLog.length > 20) scanLog = scanLog.slice(0, 20);
  console.log(`Scan complete. ${products.length} products.`);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', lastScan, productCount: products.length }));

app.get('/products', (req, res) => res.json({
  products, lastScan,
  nextScan: lastScan ? new Date(new Date(lastScan).getTime() + 3*60*60*1000).toISOString() : null,
  scanLog,
}));

app.post('/scan', async (req, res) => {
  res.json({ status: scanning ? 'already_scanning' : 'started' });
  if (!scanning) { scanning = true; await runScan(); scanning = false; }
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

cron.schedule('0 */3 * * *', async () => {
  if (!scanning) { scanning = true; await runScan(); scanning = false; }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Scout backend running on port ${PORT}`);
  scanning = true;
  await runScan();
  scanning = false;
});

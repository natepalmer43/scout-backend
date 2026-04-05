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
  console.log('Running Claude product research with web search...');

  const prompt = `You are an expert dropshipping product researcher. Use web search extensively to find physical products trending RIGHT NOW that would be great dropshipping candidates.

Search for ALL of the following:
1. "tiktok trending products this week 2026"
2. "amazon best sellers rising 2026"
3. "reddit shutupandtakemymoney top posts this week"
4. "reddit amazonfinds trending"
5. "viral products to sell online 2026"
6. Any specific products you find — search each one individually to get more detail

For each product you identify, I need RICH details. Search for each product individually to find:
- Real product links (Amazon listing URL, TikTok video URL, Reddit post URL — actual URLs you find)
- Real image URLs from product pages or listings
- Specific reasons why it is trending (viral video views, Amazon rank, Reddit upvotes etc)
- Price range (what it sells for retail)
- Estimated wholesale/supplier cost
- Why it would make a good dropship product

Return ONLY a valid JSON array with this exact structure, no markdown, no explanation, just the array:
[
  {
    "name": "Exact Product Name",
    "category": "home decor / fitness / kitchen / gadgets / beauty / outdoor / pet / office",
    "tiktok": 82,
    "amazon": 74,
    "reddit": 61,
    "margin": 65,
    "signals": ["tiktok", "amazon"],
    "source": "tiktok",
    "retailPrice": "$29.99",
    "wholesaleEstimate": "$8-12",
    "whyTrending": "Specific reason this is trending right now with real data points — views, rank, upvotes etc",
    "whyDropship": "Why this is a good dropship product — margin, demand, competition level",
    "tiktokUrl": "https://www.tiktok.com/... or null if not found",
    "amazonUrl": "https://www.amazon.com/... or null if not found",
    "redditUrl": "https://www.reddit.com/... or null if not found",
    "imageUrl": "https://... real product image URL or null",
    "searchQuery": "exact search term someone would use to find this product on AliExpress or Alibaba"
  }
]

Rules:
- Only physical products — no food, no regulated items, no branded/trademarked products
- Aim for 12-18 products
- signals array only includes sources where score >= 65
- ALL URLs must be real URLs you actually found during your searches — use null if you did not find one
- imageUrl should be a direct image URL ending in .jpg .png .webp if possible
- whyTrending must include specific data points (views counts, rank numbers, upvote counts)
- Make scores realistic based on actual evidence you found`;

  try {
    const messages = [{ role: 'user', content: prompt }];
    let response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages,
    });

    // Agentic loop — keep going until Claude stops using tools
    while (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`  Searching: ${block.input?.query || '...'}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Search executed successfully',
          });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      });
    }

    // Extract final text
    const finalText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON
    const clean = finalText.replace(/```json/g, '').replace(/```/g, '').trim();
    const startIdx = clean.indexOf('[');
    const endIdx = clean.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1) throw new Error('No JSON array in response');
    const parsed = JSON.parse(clean.slice(startIdx, endIdx + 1));
    console.log(`Claude found ${parsed.length} products with rich data`);
    return parsed;

  } catch (err) {
    console.error('Claude research error:', err.message);
    return [];
  }
}

// ─── Process and score ────────────────────────────────────────────────────────

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
      score: Math.round(clamp(p.tiktok) * 0.40 + clamp(p.amazon) * 0.30 + clamp(p.reddit) * 0.15 + clamp(p.margin) * 0.15),
      signals: p.signals || [],
      source: p.source || 'web',
      retailPrice: p.retailPrice || null,
      wholesaleEstimate: p.wholesaleEstimate || null,
      whyTrending: p.whyTrending || '',
      whyDropship: p.whyDropship || '',
      tiktokUrl: p.tiktokUrl || null,
      amazonUrl: p.amazonUrl || null,
      redditUrl: p.redditUrl || null,
      imageUrl: p.imageUrl || null,
      searchQuery: p.searchQuery || p.name,
      scannedAt: new Date().toISOString(),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function clamp(v) { return Math.min(100, Math.max(0, Math.round(Number(v) || 0))); }

// ─── Main scan ────────────────────────────────────────────────────────────────

async function runScan() {
  console.log(`\n[${new Date().toISOString()}] Starting scan...`);
  const raw = await researchProducts();
  products = processProducts(raw);
  lastScan = new Date().toISOString();
  scanLog.unshift({ scannedAt: lastScan, count: products.length });
  if (scanLog.length > 20) scanLog = scanLog.slice(0, 20);
  console.log(`Scan complete. ${products.length} products scored.`);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastScan, productCount: products.length });
});

app.get('/products', (req, res) => {
  res.json({ products, lastScan, nextScan: lastScan ? new Date(new Date(lastScan).getTime() + 3 * 60 * 60 * 1000).toISOString() : null, scanLog });
});

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

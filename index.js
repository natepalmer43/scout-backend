const express = require('express');
const cron = require('node-cron');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { searchProduct } = require('./cj');
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
let currentMinPrice = 0;

// ─── Claude research ──────────────────────────────────────────────────────────

async function researchProducts(minPrice = 0) {
  const priceContext = minPrice > 0
    ? `IMPORTANT: Only find products that retail for $${minPrice} or more. Ignore anything cheaper.`
    : 'Include products at any price point.';

  const priceSearch = minPrice > 0
    ? `trending products over $${minPrice} 2026, premium dropshipping products $${minPrice}+`
    : 'tiktok trending products 2026, amazon best sellers rising this week';

  console.log(`Researching products — min price: ${minPrice > 0 ? '$' + minPrice : 'any'}`);

  const prompt = `You are a dropshipping product researcher. Search the web for physical products trending right now.

Search for: ${priceSearch}, viral products to sell online 2026.

${priceContext}

Return ONLY a JSON array, no other text, starting with [ and ending with ]:
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
    "retailPrice": "$49.99",
    "wholesaleEstimate": "$14-18",
    "whyTrending": "Specific reason with real data points",
    "whyDropship": "Why good for dropshipping",
    "tiktokUrl": null,
    "amazonUrl": "https://amazon.com/s?k=product+name",
    "redditUrl": null,
    "imageUrl": null,
    "searchQuery": "aliexpress search term"
  }
]

Find 10 products. Only physical goods. No food, regulated items, or branded products. signals only includes sources with score >= 65.${minPrice > 0 ? ` Every product must retail for $${minPrice} or more.` : ''}`;

  try {
    const messages = [{ role: 'user', content: prompt }];
    let response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages,
    });

    let loops = 0;
    while (response.stop_reason === 'tool_use' && loops < 4) {
      loops++;
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`  Searching: ${block.input?.query || '...'}`);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Search completed' });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      });
    }

    const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    console.log('Response preview:', finalText.slice(0, 150));

    const parsed = extractJSON(finalText);
    if (parsed) { console.log(`Found ${parsed.length} products`); return parsed; }

    // Retry
    console.log('Retrying JSON extraction...');
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: 'Respond with ONLY the JSON array. Start with [ and end with ]. No other text.' });
    const retry = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages,
    });
    const retryText = retry.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const retryParsed = extractJSON(retryText);
    if (retryParsed) { console.log(`Found ${retryParsed.length} products on retry`); return retryParsed; }

    throw new Error('Could not extract JSON after retry');
  } catch (err) {
    console.error('Claude research error:', err.message);
    return [];
  }
}

function extractJSON(text) {
  if (!text) return null;
  let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(clean.slice(start, end + 1));
    if (Array.isArray(arr) && arr.length > 0) return arr;
  } catch {
    try {
      const fixed = clean.slice(start, end + 1).replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      const arr = JSON.parse(fixed);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch { }
  }
  return null;
}

// ─── CJ supplier matching ─────────────────────────────────────────────────────

async function enrichWithCJ(products) {
  if (!process.env.CJ_API_KEY) {
    console.log('No CJ_API_KEY — skipping supplier matching');
    return products;
  }

  console.log(`Matching ${products.length} products against CJ catalog...`);

  const enriched = await Promise.all(products.map(async (p) => {
    try {
      const cj = await searchProduct(p.searchQuery || p.name);
      if (!cj) return p;

      console.log(`  CJ match for "${p.name}": "${cj.cjProductName}" (${cj.cjMatchScore}% match) @ $${cj.cjPrice}`);

      return {
        ...p,
        cj: {
          found: true,
          matchScore: cj.cjMatchScore,
          productId: cj.cjProductId,
          productName: cj.cjProductName,
          price: cj.cjPrice,
          currency: cj.cjCurrency,
          shippingTime: cj.cjShippingTime,
          imageUrl: cj.cjImageUrl,
          productUrl: cj.cjProductUrl,
          allMatches: cj.allMatches,
        },
        // Override wholesale estimate with real CJ price
        wholesaleEstimate: cj.cjPrice ? `$${cj.cjPrice} (CJ)` : p.wholesaleEstimate,
        // Use CJ image if we don't have one
        imageUrl: p.imageUrl || cj.cjImageUrl || null,
      };
    } catch (err) {
      console.error(`CJ enrichment error for ${p.name}:`, err.message);
      return p;
    }
  }));

  const matched = enriched.filter(p => p.cj?.found).length;
  console.log(`CJ matching complete: ${matched}/${products.length} products matched`);
  return enriched;
}

// ─── Process ──────────────────────────────────────────────────────────────────

function clamp(v) { return Math.min(100, Math.max(0, Math.round(Number(v) || 0))); }
function validUrl(u) {
  if (!u || u === 'null' || u === 'undefined') return null;
  try { new URL(u); return u; } catch { return null; }
}

function processProducts(raw, minPrice = 0) {
  return raw
    .filter(p => {
      if (!p || !p.name) return false;
      if (minPrice > 0) {
        const match = String(p.retailPrice || '').match(/[\d.]+/);
        const price = match ? parseFloat(match[0]) : null;
        if (price === null || price < minPrice) return false;
      }
      return true;
    })
    .map((p, i) => ({
      id: `p_${Date.now()}_${i}`,
      name: String(p.name).slice(0, 80),
      category: p.category || 'general',
      tiktok: clamp(p.tiktok),
      amazon: clamp(p.amazon),
      reddit: clamp(p.reddit),
      margin: clamp(p.margin),
      score: Math.round(clamp(p.tiktok)*0.40 + clamp(p.amazon)*0.30 + clamp(p.reddit)*0.15 + clamp(p.margin)*0.15),
      signals: Array.isArray(p.signals) ? p.signals : [],
      source: p.source || 'web',
      retailPrice: p.retailPrice || null,
      wholesaleEstimate: p.wholesaleEstimate || null,
      whyTrending: p.whyTrending || '',
      whyDropship: p.whyDropship || '',
      tiktokUrl: validUrl(p.tiktokUrl),
      amazonUrl: validUrl(p.amazonUrl),
      redditUrl: validUrl(p.redditUrl),
      imageUrl: validUrl(p.imageUrl),
      searchQuery: p.searchQuery || p.name,
      cj: p.cj || null,
      scannedAt: new Date().toISOString(),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

// ─── Main scan ────────────────────────────────────────────────────────────────

async function runScan(minPrice = 0) {
  console.log(`\n[${new Date().toISOString()}] Starting scan (minPrice: $${minPrice})...`);
  currentMinPrice = minPrice;

  const raw = await researchProducts(minPrice);
  if (raw.length === 0) {
    console.log('No products returned — keeping previous results');
    lastScan = new Date().toISOString();
    return;
  }

  let processed = processProducts(raw, minPrice);
  processed = await enrichWithCJ(processed);

  products = processed;
  lastScan = new Date().toISOString();
  scanLog.unshift({ scannedAt: lastScan, count: products.length, minPrice });
  if (scanLog.length > 20) scanLog = scanLog.slice(0, 20);

  const cjMatched = products.filter(p => p.cj?.found).length;
  console.log(`Scan complete. ${products.length} products (${cjMatched} matched on CJ).`);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok', lastScan, productCount: products.length,
  cjEnabled: !!process.env.CJ_API_KEY, currentMinPrice
}));

app.get('/products', (req, res) => res.json({
  products, lastScan, currentMinPrice,
  nextScan: lastScan ? new Date(new Date(lastScan).getTime() + 3*60*60*1000).toISOString() : null,
  scanLog,
}));

app.post('/scan', async (req, res) => {
  const minPrice = parseInt(req.body?.minPrice) || 0;
  res.json({ status: scanning ? 'already_scanning' : 'started', minPrice });
  if (!scanning) { scanning = true; await runScan(minPrice); scanning = false; }
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

cron.schedule('0 */3 * * *', async () => {
  if (!scanning) { scanning = true; await runScan(currentMinPrice); scanning = false; }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Scout backend running on port ${PORT}`);
  console.log(`CJ Dropshipping: ${process.env.CJ_API_KEY ? 'enabled' : 'disabled (no CJ_API_KEY)'}`);
  scanning = true;
  await runScan(0);
  scanning = false;
});

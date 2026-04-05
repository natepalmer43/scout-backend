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

// ─── Claude research ──────────────────────────────────────────────────────────

async function researchProducts() {
  console.log('Running Claude product research...');

  const prompt = `Search the web for physical products trending right now for dropshipping. Search for "tiktok trending products 2026" and "amazon best sellers this week".

Respond with ONLY a JSON array. No intro text, no explanation, no markdown. Start your response with [ and end with ].

Example format:
[{"name":"LED Sunset Lamp","category":"home decor","tiktok":82,"amazon":71,"reddit":55,"margin":68,"signals":["tiktok","amazon"],"source":"tiktok","retailPrice":"$24.99","wholesaleEstimate":"$6-9","whyTrending":"Viral on TikTok with 5M views this week","whyDropship":"High margin, easy to ship, no brand restrictions","tiktokUrl":null,"amazonUrl":"https://amazon.com/s?k=led+sunset+lamp","redditUrl":null,"imageUrl":null,"searchQuery":"LED sunset projection lamp"}]

Find 8 products. Only physical goods. No food or regulated items.`;

  try {
    const messages = [{ role: 'user', content: prompt }];
    let response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages,
    });

    // Agentic loop — max 4 search rounds
    let loops = 0;
    while (response.stop_reason === 'tool_use' && loops < 4) {
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
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      });
    }

    // Extract all text blocks
    const finalText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    console.log('Raw response preview:', finalText.slice(0, 200));

    // Try to extract JSON array — handle markdown fences, leading text etc
    const parsed = extractJSON(finalText);
    if (parsed) {
      console.log(`Claude found ${parsed.length} products`);
      return parsed;
    }

    // If still no JSON — ask Claude to reformat
    console.log('No JSON found, asking Claude to reformat...');
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: 'Your response did not contain valid JSON. Please respond with ONLY the JSON array, starting with [ and ending with ]. Nothing else.',
    });
    const retry = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages,
    });
    const retryText = retry.content.filter(b => b.type === 'text').map(b => b.text).join('');
    console.log('Retry preview:', retryText.slice(0, 200));
    const retryParsed = extractJSON(retryText);
    if (retryParsed) {
      console.log(`Claude found ${retryParsed.length} products on retry`);
      return retryParsed;
    }

    throw new Error('Could not extract JSON after retry');

  } catch (err) {
    console.error('Claude research error:', err.message);
    return [];
  }
}

function extractJSON(text) {
  if (!text) return null;
  // Strip markdown fences
  let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  // Find outermost array
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(clean.slice(start, end + 1));
    if (Array.isArray(arr) && arr.length > 0) return arr;
    return null;
  } catch (e) {
    // Try to fix common JSON issues — trailing commas
    try {
      const fixed = clean.slice(start, end + 1)
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      const arr = JSON.parse(fixed);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (e2) { /* fall through */ }
    return null;
  }
}

// ─── Process ──────────────────────────────────────────────────────────────────

function clamp(v) { return Math.min(100, Math.max(0, Math.round(Number(v) || 0))); }

function processProducts(raw) {
  return raw
    .filter(p => p && p.name)
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
      scannedAt: new Date().toISOString(),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function validUrl(u) {
  if (!u || u === 'null' || u === 'undefined') return null;
  try { new URL(u); return u; } catch { return null; }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function runScan() {
  console.log(`\n[${new Date().toISOString()}] Starting scan...`);
  const raw = await researchProducts();
  if (raw.length > 0) {
    products = processProducts(raw);
  } else {
    console.log('No products returned — keeping previous results');
  }
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

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

  const prompt = `You are a dropshipping product researcher. Use web search to find physical products that are trending RIGHT NOW and would be good candidates for a dropshipping business.

Search for:
1. Products going viral on TikTok this week
2. Amazon best sellers moving up in rankings this week  
3. Products being talked about on Reddit in r/BuyItForLife, r/amazonfinds, r/shutupandtakemymoney this week
4. Any other trending consumer products you find

For each product you identify, evaluate:
- TikTok trend score (0-100): how viral is it on TikTok right now
- Amazon score (0-100): how well is it selling on Amazon
- Reddit score (0-100): how much organic buzz on Reddit
- Margin score (0-100): estimated dropship margin potential (higher margin = better)

Return ONLY a JSON array with exactly this structure, no other text:
[
  {
    "name": "Product Name",
    "category": "category",
    "tiktok": 75,
    "amazon": 68,
    "reddit": 55,
    "margin": 60,
    "signals": ["tiktok", "amazon"],
    "summary": "2-3 sentence explanation of why this product is trending and worth considering",
    "source": "tiktok"
  }
]

Rules:
- Only physical products someone could buy wholesale and resell
- No food, no regulated items, no branded/trademarked products
- Aim for 10-15 products
- signals array should only include sources where score >= 65
- source field = where you found the strongest signal (tiktok/amazon/reddit)
- Make scores realistic based on what you actually find, not made up`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract the final text response after web searches complete
    let resultText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        resultText += block.text;
      }
    }

    // Handle multi-turn if web search was used
    let finalText = resultText;
    if (response.stop_reason === 'tool_use') {
      // Continue conversation after tool use
      const messages = [
        { role: 'user', content: prompt },
        { role: 'assistant', content: response.content },
      ];

      // Add tool results
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: block.input?.query ? `Search completed for: ${block.input.query}` : 'Search completed',
          });
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
        const followUp = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages,
        });
        finalText = followUp.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');
      }
    }

    // Parse JSON from response
    const clean = finalText
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    const startIdx = clean.indexOf('[');
    const endIdx = clean.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1) throw new Error('No JSON array found in response');

    const jsonStr = clean.slice(startIdx, endIdx + 1);
    const parsed = JSON.parse(jsonStr);

    console.log(`Claude found ${parsed.length} products`);
    return parsed;

  } catch (err) {
    console.error('Claude research error:', err.message);
    return [];
  }
}

// ─── Score and format ─────────────────────────────────────────────────────────

function processProducts(raw) {
  return raw
    .filter(p => p.name && p.tiktok !== undefined)
    .map((p, i) => ({
      id: `p_${Date.now()}_${i}`,
      name: p.name,
      category: p.category || 'general',
      tiktok: Math.min(100, Math.max(0, Math.round(p.tiktok))),
      amazon: Math.min(100, Math.max(0, Math.round(p.amazon))),
      reddit: Math.min(100, Math.max(0, Math.round(p.reddit))),
      margin: Math.min(100, Math.max(0, Math.round(p.margin))),
      score: Math.round(p.tiktok * 0.40 + p.amazon * 0.30 + p.reddit * 0.15 + p.margin * 0.15),
      signals: p.signals || [],
      summary: p.summary || '',
      source: p.source || 'web',
      scannedAt: new Date().toISOString(),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

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
  res.json({
    products,
    lastScan,
    nextScan: lastScan
      ? new Date(new Date(lastScan).getTime() + 3 * 60 * 60 * 1000).toISOString()
      : null,
    scanLog,
  });
});

app.post('/scan', async (req, res) => {
  res.json({ status: scanning ? 'already_scanning' : 'started' });
  if (!scanning) {
    scanning = true;
    await runScan();
    scanning = false;
  }
});

// ─── Scheduler — every 3 hours ────────────────────────────────────────────────

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

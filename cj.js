const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

let accessToken = null;
let tokenExpiry = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getToken() {
  if (accessToken && tokenExpiry && new Date() < new Date(tokenExpiry)) {
    return accessToken;
  }
  const CJ_API_KEY = process.env.CJ_API_KEY;
  if (!CJ_API_KEY) { console.error('No CJ_API_KEY'); return null; }
  try {
    const res = await axios.post(
      `${CJ_BASE}/authentication/getAccessToken`,
      { apiKey: CJ_API_KEY },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    if (res.data && res.data.result && res.data.data && res.data.data.accessToken) {
      accessToken = res.data.data.accessToken;
      tokenExpiry = res.data.data.accessTokenExpiryDate;
      console.log('CJ authenticated');
      return accessToken;
    }
    console.error('CJ auth failed:', res.data && res.data.message);
    return null;
  } catch (err) {
    console.error('CJ auth error:', (err.response && err.response.data && err.response.data.message) || err.message);
    return null;
  }
}

// ─── Category IDs ─────────────────────────────────────────────────────────────
// CJ category IDs for our target categories

// Real category IDs from CJ API — using second-level category IDs
// which are broad enough to get good product variety
const TARGET_CATEGORIES = [
  // Pet Supplies subcategories
  { name: 'Pet Supplies',      id: '2410110335471602500' }, // Pet Toys
  { name: 'Pet Supplies',      id: '2410110338591602500' }, // Pet Furniture
  { name: 'Pet Supplies',      id: '2410110339121629200' }, // Pet Bedding
  { name: 'Pet Supplies',      id: '2410110337231611800' }, // Pet Outdoor Supplies
  { name: 'Pet Supplies',      id: '2410110338151629800' }, // Pet Apparels
  // Sports & Outdoors
  { name: 'Sports & Outdoors', id: '36492F79-E7EB-42F0-8DCC-6129BD9D2AE1' }, // Other Sports Equipment
  { name: 'Sports & Outdoors', id: '66C86053-159B-436E-B4A9-4A7CCB5CAC8A' }, // Sportswear
  // Home & Garden
  { name: 'Home & Garden',     id: '1AD00A3C-465A-430A-9820-F2D097FDA53A' }, // Home Textiles
  { name: 'Home & Garden',     id: 'ED8E61AA-2260-4E03-BA66-DEAE3DF02CDC' }, // Home Storage
  { name: 'Home & Garden',     id: 'D5D120D0-1262-461A-97C5-74AC732625B5' }, // Kitchen, Dining & Bar
  // Beauty & Health
  { name: 'Beauty & Health',   id: 'CE5FADBB-B432-40B9-8B20-200F6928762A' }, // Beauty Tools
  { name: 'Beauty & Health',   id: '6289460B-5660-468A-AE43-3D619A05AAC2' }, // Skin Care
  { name: 'Beauty & Health',   id: '7EAF3E36-620B-4D78-818F-EE80955462A4' }, // Makeup
  // Baby & Kids
  { name: 'Baby & Kids',       id: '8C946349-0DC4-4B1E-AC41-E4FE30288DEE' }, // Baby & Mother
  { name: 'Baby & Kids',       id: '04D68B68-1048-4971-BAFA-18FA0A6DB95C' }, // Toys & Hobbies
];

// ─── Pull products from CJ by category ───────────────────────────────────────

async function fetchCategoryProducts(token, categoryId, categoryName, pageSize) {
  try {
    const res = await axios.get(`${CJ_BASE}/product/list`, {
      headers: { 'CJ-Access-Token': token },
      params: {
        categoryId: categoryId,
        pageNum: 1,
        pageSize: pageSize,
        sortField: 'orderCount',  // sort by most ordered = proven sellers
        sortType: 'DESC',
      },
      timeout: 20000,
    });

    if (!res.data || !res.data.result || !res.data.data || !res.data.data.list) {
      console.log('  No results for category: ' + categoryName);
      return [];
    }

    const items = res.data.data.list;
    console.log('  ' + categoryName + ': ' + items.length + ' products fetched');

    return items.map(function(item) {
      return {
        cjProductId: item.pid,
        name: item.productName,
        category: categoryName,
        price: item.sellPrice,
        imageUrl: item.productImage || null,
        productUrl: 'https://cjdropshipping.com/product/' + item.pid + '.html',
        shippingTime: item.deliveryTime || null,
        weight: item.productWeight || null,
      };
    });
  } catch (err) {
    console.error('CJ category fetch error (' + categoryName + '):', (err.response && err.response.data && err.response.data.message) || err.message);
    return [];
  }
}

// ─── Pull all target categories ───────────────────────────────────────────────

async function fetchAllCJProducts(minPrice) {
  const token = await getToken();
  if (!token) return [];

  // Distribute pages across categories — aim for as many as possible
  // CJ QPS limit is 1/sec so we pace calls
  const perCategory = 10; // 10 per category x 15 categories = ~150 products
  const allProducts = [];

  for (var i = 0; i < TARGET_CATEGORIES.length; i++) {
    var cat = TARGET_CATEGORIES[i];
    console.log('Fetching CJ category: ' + cat.name);
    var products = await fetchCategoryProducts(token, cat.id, cat.name, perCategory);

    // Apply price filter if set
    if (minPrice > 0) {
      products = products.filter(function(p) {
        var price = parseFloat(p.price) || 0;
        return price >= minPrice;
      });
    }

    allProducts.push.apply(allProducts, products);
    await sleep(1200); // respect QPS limit
  }

  console.log('Total CJ products fetched: ' + allProducts.length);
  return allProducts;
}

// ─── Claude scores CJ products for trend potential ────────────────────────────

async function scoreBatch(products) {
  var productList = products.map(function(p, i) {
    return (i + 1) + '. "' + p.name + '" - $' + p.price + ' (' + p.category + ')';
  }).join('\n');

  var prompt = 'You are a dropshipping expert. Search the web to evaluate these ' + products.length + ' products from CJ Dropshipping for their current trend potential and dropshipping viability.\n\nProducts:\n' + productList + '\n\nFor each product search for current social media buzz, Amazon sales data, and consumer demand. Then return ONLY a JSON array:\n[\n  {\n    "index": 1,\n    "tiktok": 72,\n    "amazon": 68,\n    "reddit": 45,\n    "margin": 70,\n    "whyTrending": "specific reason with data points",\n    "whyDropship": "why good for dropshipping",\n    "tiktokUrl": null,\n    "amazonUrl": "https://amazon.com/s?k=search+term",\n    "redditUrl": null\n  }\n]\n\nScoring 0-100. signals threshold >= 65. Be honest — low scores for products with no buzz. Return all ' + products.length + ' products scored.';

  try {
    var messages = [{ role: 'user', content: prompt }];
    var response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: messages,
    });

    var loops = 0;
    while (response.stop_reason === 'tool_use' && loops < 5) {
      loops++;
      var toolResults = [];
      for (var i = 0; i < response.content.length; i++) {
        var block = response.content[i];
        if (block.type === 'tool_use') {
          console.log('  Searching: ' + (block.input && block.input.query));
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Search completed' });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      response = await claude.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: messages,
      });
    }

    var finalText = response.content
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('');

    var parsed = extractJSON(finalText);
    if (!parsed) {
      // Retry
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: 'Return ONLY the JSON array, starting with [ and ending with ].' });
      var retry = await claude.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: messages,
      });
      var retryText = retry.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
      parsed = extractJSON(retryText);
    }

    return parsed || [];
  } catch (err) {
    console.error('Claude scoring error:', err.message);
    return [];
  }
}

function extractJSON(text) {
  if (!text) return null;
  var clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  var start = clean.indexOf('[');
  var end = clean.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    var arr = JSON.parse(clean.slice(start, end + 1));
    if (Array.isArray(arr) && arr.length > 0) return arr;
  } catch(e) {
    try {
      var fixed = clean.slice(start, end + 1).replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      var arr2 = JSON.parse(fixed);
      if (Array.isArray(arr2) && arr2.length > 0) return arr2;
    } catch(e2) {}
  }
  return null;
}

function validUrl(u) {
  if (!u || u === 'null' || u === 'undefined') return null;
  try { new URL(u); return u; } catch(e) { return null; }
}

function clamp(v) { return Math.min(100, Math.max(0, Math.round(Number(v) || 0))); }

// ─── Main export — replaces old approach entirely ─────────────────────────────

async function fetchAndScoreCJProducts(minPrice) {
  // Step 1: Pull real products from CJ
  var cjProducts = await fetchAllCJProducts(minPrice || 0);
  if (!cjProducts.length) {
    console.log('No CJ products fetched');
    return [];
  }

  // Step 2: Score in batches of 10 to stay within rate limits
  var batchSize = 10;
  var allScored = [];

  for (var i = 0; i < cjProducts.length; i += batchSize) {
    var batch = cjProducts.slice(i, i + batchSize);
    console.log('Scoring batch ' + (Math.floor(i/batchSize)+1) + '/' + Math.ceil(cjProducts.length/batchSize) + ' (' + batch.length + ' products)...');

    var scores = await scoreBatch(batch);

    scores.forEach(function(s) {
      var idx = (s.index || 0) - 1;
      if (idx < 0 || idx >= batch.length) return;
      var cjProduct = batch[idx];

      var tiktok = clamp(s.tiktok);
      var amazon = clamp(s.amazon);
      var reddit = clamp(s.reddit);
      var margin = clamp(s.margin);
      var overall = Math.round(tiktok*0.40 + amazon*0.30 + reddit*0.15 + margin*0.15);

      var signals = [];
      if (tiktok >= 65) signals.push('tiktok');
      if (amazon >= 65) signals.push('amazon');
      if (reddit >= 65) signals.push('reddit');
      if (margin >= 65) signals.push('margin');

      allScored.push({
        id: 'cj_' + cjProduct.cjProductId,
        name: cjProduct.name,
        category: cjProduct.category,
        tiktok: tiktok,
        amazon: amazon,
        reddit: reddit,
        margin: margin,
        score: overall,
        signals: signals,
        source: 'cj',
        retailPrice: null,  // Claude will estimate or leave blank
        wholesaleEstimate: cjProduct.price ? '$' + cjProduct.price + ' (CJ)' : null,
        whyTrending: s.whyTrending || '',
        whyDropship: s.whyDropship || '',
        tiktokUrl: validUrl(s.tiktokUrl),
        amazonUrl: validUrl(s.amazonUrl),
        redditUrl: validUrl(s.redditUrl),
        imageUrl: cjProduct.imageUrl || null,
        searchQuery: cjProduct.name,
        cj: {
          found: true,
          productId: cjProduct.cjProductId,
          productName: cjProduct.name,
          price: cjProduct.price,
          shippingTime: cjProduct.shippingTime,
          imageUrl: cjProduct.imageUrl,
          productUrl: cjProduct.productUrl,
          allMatches: [],
        },
        scannedAt: new Date().toISOString(),
      });
    });

    // Pause between batches
    if (i + batchSize < cjProducts.length) {
      await sleep(2000);
    }
  }

  console.log('Scored ' + allScored.length + ' products from CJ');
  return allScored.sort(function(a, b) { return b.score - a.score; });
}

module.exports = { fetchAndScoreCJProducts: fetchAndScoreCJProducts };

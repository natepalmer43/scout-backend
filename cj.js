const axios = require('axios');

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

let accessToken = null;
let tokenExpiry = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Auth — call once, reuse token ───────────────────────────────────────────

async function getToken() {
  if (accessToken && tokenExpiry && new Date() < new Date(tokenExpiry)) {
    return accessToken;
  }

  const CJ_API_KEY = process.env.CJ_API_KEY;
  if (!CJ_API_KEY) { console.error('No CJ_API_KEY set'); return null; }

  // Extract key portion after @api@ if present
  const keyPart = CJ_API_KEY.includes('@api@')
    ? CJ_API_KEY.split('@api@')[1]
    : CJ_API_KEY;

  try {
    const res = await axios.post(
      `${CJ_BASE}/authentication/getAccessToken`,
      { apiKey: keyPart },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    if (res.data?.result && res.data?.data?.accessToken) {
      accessToken = res.data.data.accessToken;
      tokenExpiry = res.data.data.accessTokenExpiryDate;
      console.log('CJ authenticated successfully, token expires:', tokenExpiry);
      return accessToken;
    }

    console.error('CJ auth failed:', res.data?.message);
    return null;
  } catch (err) {
    console.error('CJ auth error:', err.response?.data?.message || err.message);
    return null;
  }
}

// ─── Search single product — with retry on rate limit ────────────────────────

async function searchProduct(productName) {
  const token = await getToken();
  if (!token) return null;

  try {
    const res = await axios.get(`${CJ_BASE}/product/list`, {
      headers: { 'CJ-Access-Token': token },
      params: { productName, pageNum: 1, pageSize: 5 },
      timeout: 15000,
    });

    if (!res.data?.result || !res.data?.data?.list?.length) {
      console.log(`  CJ: no results for "${productName}"`);
      return null;
    }

    const items = res.data.data.list;
    const best = items[0];

    return {
      cjProductId: best.pid,
      cjProductName: best.productName,
      cjPrice: best.sellPrice,
      cjShippingTime: best.deliveryTime || null,
      cjImageUrl: best.productImage || null,
      cjProductUrl: `https://cjdropshipping.com/product/${best.pid}.html`,
      cjMatchScore: calcMatchScore(productName, best.productName),
      allMatches: items.slice(0, 3).map(item => ({
        id: item.pid,
        name: item.productName,
        price: item.sellPrice,
        image: item.productImage,
        url: `https://cjdropshipping.com/product/${item.pid}.html`,
      })),
    };
  } catch (err) {
    console.error(`CJ search error for "${productName}":`, err.response?.data?.message || err.message);
    return null;
  }
}

// ─── Search all products sequentially with 1.2s delay between calls ──────────

async function searchAllProducts(products) {
  // Authenticate once before starting
  const token = await getToken();
  if (!token) {
    console.log('CJ auth failed — skipping supplier matching');
    return products;
  }

  const results = [];

  for (const product of products) {
    const cj = await searchProduct(product.searchQuery || product.name);

    if (cj) {
      console.log(`  CJ match: "${product.name}" → "${cj.cjProductName}" (${cj.cjMatchScore}% match) @ $${cj.cjPrice}`);
      results.push({
        ...product,
        cj: {
          found: true,
          matchScore: cj.cjMatchScore,
          productId: cj.cjProductId,
          productName: cj.cjProductName,
          price: cj.cjPrice,
          shippingTime: cj.cjShippingTime,
          imageUrl: cj.cjImageUrl,
          productUrl: cj.cjProductUrl,
          allMatches: cj.allMatches,
        },
        wholesaleEstimate: cj.cjPrice ? `$${cj.cjPrice} (CJ live)` : product.wholesaleEstimate,
        imageUrl: product.imageUrl || cj.cjImageUrl || null,
      });
    } else {
      results.push({ ...product, cj: { found: false } });
    }

    // 1.2 second delay between calls to stay within QPS limit
    await sleep(1200);
  }

  const matched = results.filter(p => p.cj?.found).length;
  console.log(`CJ matching complete: ${matched}/${products.length} matched`);
  return results;
}

function calcMatchScore(query, result) {
  const q = (query || '').toLowerCase().split(' ').filter(w => w.length > 2);
  const r = (result || '').toLowerCase();
  const matches = q.filter(w => r.includes(w)).length;
  return Math.round((matches / Math.max(q.length, 1)) * 100);
}

module.exports = { searchAllProducts, getToken };

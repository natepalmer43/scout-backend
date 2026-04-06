const axios = require('axios');

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const CJ_API_KEY = process.env.CJ_API_KEY;

let accessToken = null;
let tokenExpiry = null;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getToken() {
  if (accessToken && tokenExpiry && new Date() < new Date(tokenExpiry)) {
    return accessToken;
  }
  if (!CJ_API_KEY) { console.error('No CJ_API_KEY set'); return null; }

  try {
    // CJ key format: CJ5301941@api@94d6a6cc0a6848b8a32e2f718058892b
    // Extract the actual API key portion after the last @
    const keyPart = CJ_API_KEY.includes('@api@')
      ? CJ_API_KEY.split('@api@')[1]
      : CJ_API_KEY;

    const res = await axios.post(
      `${CJ_BASE}/authentication/getAccessToken`,
      { apiKey: keyPart },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    if (res.data?.result && res.data?.data?.accessToken) {
      accessToken = res.data.data.accessToken;
      tokenExpiry = res.data.data.accessTokenExpiryDate;
      console.log('CJ authenticated successfully');
      return accessToken;
    }

    // Try with full key if extract didn't work
    const res2 = await axios.post(
      `${CJ_BASE}/authentication/getAccessToken`,
      { apiKey: CJ_API_KEY },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    if (res2.data?.result && res2.data?.data?.accessToken) {
      accessToken = res2.data.data.accessToken;
      tokenExpiry = res2.data.data.accessTokenExpiryDate;
      console.log('CJ authenticated with full key');
      return accessToken;
    }

    console.error('CJ auth failed:', res.data?.message);
    return null;
  } catch (err) {
    console.error('CJ auth error:', err.response?.data?.message || err.message);
    return null;
  }
}

// ─── Product search ───────────────────────────────────────────────────────────

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
      cjCategoryName: best.categoryName,
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

function calcMatchScore(query, result) {
  const q = (query || '').toLowerCase().split(' ').filter(w => w.length > 2);
  const r = (result || '').toLowerCase();
  const matches = q.filter(w => r.includes(w)).length;
  return Math.round((matches / Math.max(q.length, 1)) * 100);
}

module.exports = { searchProduct, getToken };

const axios = require('axios');
require('dotenv').config();

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const CJ_API_KEY = process.env.CJ_API_KEY;

async function getToken() {
  const res = await axios.post(
    `${CJ_BASE}/authentication/getAccessToken`,
    { apiKey: CJ_API_KEY },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  if (res.data && res.data.result) return res.data.data.accessToken;
  throw new Error('Auth failed: ' + res.data.message);
}

async function getCategories() {
  const token = await getToken();
  const res = await axios.get(`${CJ_BASE}/product/getCategory`, {
    headers: { 'CJ-Access-Token': token },
    timeout: 15000,
  });
  return res.data;
}

getCategories().then(data => {
  console.log(JSON.stringify(data, null, 2));
}).catch(e => {
  console.error('Error:', e.response && e.response.data || e.message);
});

/**
 * Bloom Fragrances USA - Shopify OAuth + Sync Server
 * 1. Handles Shopify OAuth to get a real access token
 * 2. Runs product/inventory/order sync on a schedule
 */

const https = require("https");
const http = require("http");
const url = require("url");

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const COSMO_TOKEN = process.env.COSMO_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // izt0qr-mh.myshopify.com
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PORT = process.env.PORT || 3000;
const MARKUP = 20;

let SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || null;

// ─── HELPERS ────────────────────────────────────────────────────────────────
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── OAUTH ──────────────────────────────────────────────────────────────────
function getInstallUrl(host) {
  const scopes = "read_products,write_products,read_orders,write_orders,read_inventory,write_inventory,read_fulfillments,write_fulfillments,read_customers,write_customers";
  const redirectUri = `${host}/auth/callback`;
  return `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

async function exchangeCodeForToken(code, host) {
  const body = `client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}&code=${code}`;
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SHOPIFY_STORE,
      path: "/admin/oauth/access_token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  return res.body.access_token;
}

// ─── SYNC FUNCTIONS ─────────────────────────────────────────────────────────
async function fetchCosmoProducts() {
  let products = [];
  let path = "/v1/products?page=1";
  while (path) {
    const res = await request({ hostname: "api.cosmopolitanusa.com", path, method: "GET", headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" } });
    if (res.status !== 200 || !res.body.Results) break;
    products = products.concat(res.body.Results);
    path = res.body.NextUrl ? res.body.NextUrl.replace("https://api.cosmopolitanusa.com", "") : null;
  }
  return products;
}

async function fetchCosmoProductDetail(itemCode) {
  const res = await request({ hostname: "api.cosmopolitanusa.com", path: `/v1/products/${encodeURIComponent(itemCode)}`, method: "GET", headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" } });
  return res.status === 200 ? res.body : null;
}

async function getShopifyProducts() {
  const res = await request({ hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/products.json?limit=250&fields=id,variants,tags", method: "GET", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } });
  const products = res.body.products || [];
  const skuMap = {};
  for (const p of products) for (const v of p.variants || []) if (v.sku) skuMap[v.sku] = { productId: p.id, variantId: v.id };
  return skuMap;
}

async function createShopifyProduct(detail) {
  const price = (parseFloat(detail.Net) + MARKUP).toFixed(2);
  const comparePrice = detail.Retail ? parseFloat(detail.Retail).toFixed(2) : null;
  const res = await request({ hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/products.json", method: "POST", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { product: { title: detail.Desc, body_html: [detail.Desc2, detail.Desc3].filter(Boolean).join("<br>"), vendor: detail.Designer || "Cosmopolitan Cosmetics", product_type: "Fragrance", tags: ["fragrance", detail.ProductLine, detail.ProductClass].filter(Boolean).join(", "), images: detail.ImageURL ? [{ src: detail.ImageURL }] : [], variants: [{ sku: detail.Item, price, compare_at_price: comparePrice, inventory_management: "shopify", inventory_quantity: detail.Available || 0, weight: detail.Weight || 0, weight_unit: "oz", fulfillment_service: "manual", requires_shipping: true, taxable: true }] } });
  return res.status === 201 ? res.body.product : null;
}

async function updateShopifyInventory(variantId, available) {
  const varRes = await request({ hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/variants/${variantId}.json`, method: "GET", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } });
  const inventoryItemId = varRes.body?.variant?.inventory_item_id;
  if (!inventoryItemId) return;
  const locRes = await request({ hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/locations.json", method: "GET", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } });
  const locationId = locRes.body?.locations?.[0]?.id;
  if (!locationId) return;
  await request({ hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/inventory_levels/set.json", method: "POST", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } }, { location_id: locationId, inventory_item_id: inventoryItemId, available });
}

async function processOrders() {
  const res = await request({ hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/orders.json?fulfillment_status=unfulfilled&status=open&limit=50", method: "GET", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } });
  const orders = res.body.orders || [];
  for (const order of orders) {
    if ((order.tags || "").includes("cosmo-submitted")) continue;
    const shipping = order.shipping_address;
    if (!shipping) continue;
    const suborder = { Suborder: `BLOOM-${order.order_number}`, ShipTo: { Name: `${shipping.first_name} ${shipping.last_name}`.trim(), Line1: shipping.address1, Line2: shipping.address2 || undefined, City: shipping.city, State: shipping.province_code, Zip: shipping.zip, Country: shipping.country_code, Phone: shipping.phone || undefined, Email: order.email || undefined, Residence: true }, Lines: order.line_items.map(item => ({ SKU: item.sku, QTY: item.quantity, NET: (parseFloat(item.price) - MARKUP > 0 ? parseFloat(item.price) - MARKUP : parseFloat(item.price)).toFixed(2), EndPrice: shipping.country_code !== "US" ? parseFloat(item.price).toFixed(2) : undefined })) };
    const subRes = await request({ hostname: "api.cosmopolitanusa.com", path: "/v1/suborders", method: "POST", headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" } }, suborder);
    if (subRes.status === 201 || subRes.status === 200) {
      console.log(`✅ Submitted order BLOOM-${order.order_number}`);
      await request({ hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/orders/${order.id}.json`, method: "PUT", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } }, { order: { id: order.id, tags: ((order.tags || "") + ",cosmo-submitted").replace(/^,/, "") } });
    }
  }
  const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
  await request({ hostname: "api.cosmopolitanusa.com", path: "/v1/dropship", method: "POST", headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" } }, { PO: `BLOOM-PO-${today}`, Comment: "Bloom Fragrances USA daily order" });
}

async function syncTracking() {
  const res = await request({ hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/orders.json?fulfillment_status=unfulfilled&status=open&limit=50", method: "GET", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } });
  const orders = (res.body.orders || []).filter(o => (o.tags || "").includes("cosmo-submitted") && !(o.tags || "").includes("cosmo-tracked"));
  for (const order of orders) {
    const orderNum = `BLOOM-${order.order_number}`;
    const trackRes = await request({ hostname: "api.cosmopolitanusa.com", path: `/v1/suborders/${encodeURIComponent(orderNum)}`, method: "GET", headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" } });
    const tracking = trackRes.body?.TrackingNumber;
    if (!tracking) continue;
    const foRes = await request({ hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/orders/${order.id}/fulfillment_orders.json`, method: "GET", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } });
    const fulfillmentOrderId = foRes.body?.fulfillment_orders?.[0]?.id;
    if (!fulfillmentOrderId) continue;
    const carrier = trackRes.body?.Carrier || "other";
    const carrierMap = { FEDEX: "FedEx", UPS: "UPS", USPS: "USPS", FEDGND: "FedEx", UPSGND: "UPS", USPSP: "USPS" };
    const fulfillRes = await request({ hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/fulfillments.json", method: "POST", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } }, { fulfillment: { line_items_by_fulfillment_order: [{ fulfillment_order_id: fulfillmentOrderId }], tracking_info: { number: tracking, company: carrierMap[carrier.toUpperCase()] || carrier }, notify_customer: true } });
    if (fulfillRes.status === 201) {
      console.log(`✅ Tracked order ${orderNum}`);
      await request({ hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/orders/${order.id}.json`, method: "PUT", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } }, { order: { id: order.id, tags: ((order.tags || "") + ",cosmo-tracked").replace(/^,/, "") } });
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

async function runSync() {
  if (!SHOPIFY_TOKEN) { console.log("⚠️ No Shopify token yet — visit /install to authenticate"); return; }
  console.log("🌸 Bloom Fragrances USA - Sync starting...", new Date().toISOString());
  try {
    const existingSkus = await getShopifyProducts();
    const allProducts = await fetchCosmoProducts();
    let created = 0, updated = 0, skipped = 0;
    for (const product of allProducts) {
      const detail = await fetchCosmoProductDetail(product.Item);
      if (!detail || detail.ProductLine !== "FRAG") { skipped++; continue; }
      if (detail.Available <= 0 && !existingSkus[detail.Item]) { skipped++; continue; }
      if (existingSkus[detail.Item]) { await updateShopifyInventory(existingSkus[detail.Item].variantId, detail.Available || 0); updated++; }
      else { const p = await createShopifyProduct(detail); if (p) { created++; console.log(`✅ Created: ${detail.Desc}`); } }
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`📊 Created: ${created}, Updated: ${updated}, Skipped: ${skipped}`);
    await processOrders();
    await syncTracking();
    console.log("🌸 Sync complete!");
  } catch (err) { console.error("❌ Sync error:", err.message); }
}

// ─── WEB SERVER ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  if (path === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>🌸 Bloom Fragrances USA Sync</h1><p>Status: ${SHOPIFY_TOKEN ? "✅ Connected to Shopify" : "⚠️ Not connected"}</p>${!SHOPIFY_TOKEN ? '<a href="/install"><button>Connect to Shopify</button></a>' : '<p>Sync runs every 6 hours automatically.</p>'}`);
  }
  else if (path === "/install") {
    const host = `https://${req.headers.host}`;
    res.writeHead(302, { Location: getInstallUrl(host) });
    res.end();
  }
  else if (path === "/auth/callback") {
    const code = parsed.query.code;
    if (!code) { res.writeHead(400); res.end("Missing code"); return; }
    try {
      const host = `https://${req.headers.host}`;
      SHOPIFY_TOKEN = await exchangeCodeForToken(code, host);
      console.log("✅ Shopify OAuth complete! Token received.");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h1>✅ Connected!</h1><p>Your Shopify store is now connected. Sync will start automatically every 6 hours.</p><p><a href="/">Go back</a></p>`);
      // Run first sync immediately
      runSync();
    } catch (err) {
      res.writeHead(500);
      res.end("OAuth failed: " + err.message);
    }
  }
  else if (path === "/sync") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Sync started! Check logs.");
    runSync();
  }
  else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`🌸 Bloom Fragrances USA server running on port ${PORT}`);
  // Run sync every 6 hours
  setInterval(runSync, 30 * 60 * 1000);
  // Run once on startup if token exists
  if (SHOPIFY_TOKEN) setTimeout(runSync, 5000);
});

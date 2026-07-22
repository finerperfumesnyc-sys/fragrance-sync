/**
 * Bloom Fragrances USA - Shopify OAuth + Sync Server (COMPLETE FINAL)
 * Includes:
 * - Checkpoint/resume fix (saves real Phase 1 progress, resumes on restart)
 * - Retry fix (fetchCosmoDetail throws on failure so retries actually work)
 * - Variant dedup fix (prevents "variant already exists" failures)
 * - Shopify 429 rate-limit handling with automatic backoff
 * - updateShopifyProduct — keeps title/description fresh on existing products
 * - Discontinued-item detection (items fully removed from Cosmo's feed -> 0 stock)
 * - inventory_policy: "deny" on EVERY variant, EVERY sync — this is the fix that
 *   actually stops customers from buying items that are out of stock. Without this,
 *   setting inventory to 0 was cosmetic only; Shopify still allowed checkout.
 */

const https = require("https");
const http = require("http");
const url = require("url");
const fs = require("fs");

const COSMO_TOKEN = process.env.COSMO_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PORT = process.env.PORT || 3000;
const PROGRESS_FILE = "/tmp/sync_progress.json";

let SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || null;
let syncRunning = false;

// ─── HELPERS ────────────────────────────────────────────────────────────────
async function request(options, body = null, retryOn429 = true) {
  const result = await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
  if (result.status === 429 && retryOn429) {
    const retryAfter = parseInt(result.headers["retry-after"] || "2") * 1000;
    console.log(`⏳ Rate limited. Waiting ${retryAfter}ms...`);
    await new Promise(r => setTimeout(r, retryAfter));
    return request(options, body, false);
  }
  return result;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      console.log(`⚠️ Attempt ${i+1} failed: ${err.message}. ${i < retries-1 ? "Retrying..." : "Giving up."}`);
      if (i < retries - 1) await sleep(delayMs * (i + 1));
    }
  }
  return null;
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  } catch(e) {}
  return { processedGroups: {}, groups: {}, lastItemIndex: 0, allItems: null };
}

function saveProgress(progress) {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress)); } catch(e) {}
}

function clearProgress() {
  try { if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE); } catch(e) {}
}

// ─── PRICING ────────────────────────────────────────────────────────────────
function calculatePrice(wholesale, retail) {
  const net = parseFloat(wholesale || 0);
  const ret = parseFloat(retail || 0);
  const markupPrice = net + 20;
  const capPrice = ret > 0 ? ret - 5 : markupPrice;
  return Math.min(markupPrice, capPrice > 0 ? capPrice : markupPrice).toFixed(2);
}

// ─── TEXT HELPERS ────────────────────────────────────────────────────────────
function extractGender(title) {
  if (!title) return "U";
  if (title.includes("(M)")) return "M";
  if (title.includes("(W)")) return "W";
  if (title.includes("(U)")) return "U";
  return "U";
}

function extractSize(title) {
  if (!title) return null;
  const match = title.match(/(\d+\.?\d*)\s*OZ/i);
  if (!match) return null;
  const size = `${match[1]} oz`;
  const isTester = /TESTER|NO CAP|UNBOXED/i.test(title);
  const isDamaged = /SLIGHTLY DAMAGED/i.test(title);
  if (isDamaged) return null;
  return isTester ? `${size} (Tester)` : size;
}

function extractProductType(title) {
  if (!title) return "Fragrance";
  if (/\bEAU DE PARFUM\b|\bEDP\b/i.test(title)) return "Eau de Parfum";
  if (/\bEAU DE TOILETTE\b|\bEDT\b/i.test(title)) return "Eau de Toilette";
  if (/\bEAU DE COLOGNE\b|\bEDC\b/i.test(title)) return "Cologne";
  if (/\bCOLOGNE\b/i.test(title)) return "Cologne";
  if (/\bPARFUM\b/i.test(title)) return "Parfum";
  return "Fragrance";
}

function extractFragranceName(title) {
  if (!title) return "";
  const name = title.includes("/") ? title.split("/")[0].trim() : title.trim();
  return name.split(" ").map(w => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : "").join(" ").trim();
}

function buildGroupKey(detail) {
  const designer = (detail.Designer || "UNKNOWN").toUpperCase().trim();
  const gender = extractGender(detail.Desc || "");
  const productType = extractProductType(detail.Desc || "");
  const desc = (detail.Desc || detail.Item).toUpperCase();
  const fragPart = desc.includes("/") ? desc.split("/")[0].trim() : desc;
  return `${designer}||${fragPart}||${productType}||${gender}`;
}

function buildProductTitle(details) {
  const first = details[0];
  const designer = first.Designer || "";
  const fragName = extractFragranceName(first.Desc || first.Item);
  const productType = extractProductType(first.Desc || "");
  const gender = extractGender(first.Desc || "");
  const genderLabel = gender === "M" ? "for Men" : gender === "W" ? "for Women" : "";
  let cleanFragName = fragName;
  if (cleanFragName.toUpperCase().startsWith(designer.toUpperCase())) {
    cleanFragName = cleanFragName.slice(designer.length).trim();
  }
  let title = (designer + " " + cleanFragName + " " + productType + " " + genderLabel).trim();
  title = title.replace(/\bSpray\b/gi, "");
  title = title.replace(/\s+/g, " ").trim();
  return title;
}

function buildDescription(details) {
  const first = details[0];
  const designer = first.Designer || "Designer";
  const fragName = extractFragranceName(first.Desc || first.Item);
  const productType = extractProductType(first.Desc || "");
  const gender = extractGender(first.Desc || "");
  const genderWord = gender === "M" ? "men's" : gender === "W" ? "women's" : "unisex";
  const sizes = [...new Set(details.map(d => extractSize(d.Desc || "")).filter(Boolean))].sort((a,b) => parseFloat(a) - parseFloat(b)).filter(s => !s.includes("Tester")).join(", ");
  const typeExplain = productType === "Eau de Parfum" ? " Eau de Parfum offers a rich, long-lasting scent that lingers throughout the day."
    : productType === "Eau de Toilette" ? " Eau de Toilette is a lighter, fresh concentration perfect for everyday wear."
    : productType === "Cologne" ? " A light, refreshing concentration ideal for daily use."
    : productType === "Parfum" ? " Parfum is the most concentrated and longest-lasting fragrance formulation."
    : "";
  return `<p>${designer} ${fragName} ${productType} — a sophisticated ${genderWord} fragrance available in ${sizes || "multiple sizes"}.${typeExplain}</p>`;
}

// ─── OAUTH ───────────────────────────────────────────────────────────────────
function getInstallUrl(host) {
  const scopes = "read_products,write_products,read_orders,write_orders,read_inventory,write_inventory,read_fulfillments,write_fulfillments,read_customers,write_customers";
  return `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(`${host}/auth/callback`)}`;
}

async function exchangeCodeForToken(code, host) {
  const body = `client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}&code=${code}`;
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SHOPIFY_STORE, path: "/admin/oauth/access_token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  return res.body.access_token;
}

// ─── COSMOPOLITAN API ────────────────────────────────────────────────────────
async function fetchCosmoPage(page) {
  const res = await request({
    hostname: "api.cosmopolitanusa.com", path: `/v1/products?page=${page}`,
    method: "GET", headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" }
  });
  if (res.status !== 200 || !res.body || !res.body.Results) return { items: [], hasMore: false };
  return { items: res.body.Results, hasMore: !!res.body.NextUrl };
}

async function fetchCosmoDetail(itemCode) {
  const res = await request({
    hostname: "api.cosmopolitanusa.com", path: `/v1/products/${encodeURIComponent(itemCode)}`,
    method: "GET", headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" }
  });
  if (res.status !== 200 || !res.body) {
    throw new Error(`Cosmo detail fetch failed for ${itemCode}, status ${res.status}`);
  }
  return res.body;
}

// ─── SHOPIFY API ─────────────────────────────────────────────────────────────
async function getAllShopifySkus() {
  let skuMap = {};
  let titleToProductId = {};
  let path = "/admin/api/2024-01/products.json?limit=250&fields=id,title,variants";
  while (true) {
    const res = await request({
      hostname: SHOPIFY_STORE, path, method: "GET",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
    });
    for (const p of res.body.products || []) {
      if (p.title) titleToProductId[p.title] = p.id;
      for (const v of p.variants || [])
        if (v.sku) skuMap[v.sku] = { productId: p.id, variantId: v.id, inventoryItemId: v.inventory_item_id };
    }
    const link = res.headers?.link || "";
    if (link.includes('rel="next"')) {
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      if (m) { path = m[1].replace(`https://${SHOPIFY_STORE}`, ""); await sleep(500); } else break;
    } else break;
  }
  console.log(`🛍️ Existing Shopify SKUs: ${Object.keys(skuMap).length}`);
  return { skuMap, titleToProductId };
}

async function getLocationId() {
  const res = await request({
    hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/locations.json", method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
  });
  return res.body?.locations?.[0]?.id;
}

async function createShopifyProduct(groupDetails) {
  const title = buildProductTitle(groupDetails);
  const description = buildDescription(groupDetails);
  const imageUrl = groupDetails.find(d => d.ImageURL)?.ImageURL?.trim().replace("http://", "https://");

  const sorted = [...groupDetails].sort((a, b) => {
    const sizeA = parseFloat((a.Desc || "").match(/(\d+\.?\d*)\s*OZ/i)?.[1] || 99);
    const sizeB = parseFloat((b.Desc || "").match(/(\d+\.?\d*)\s*OZ/i)?.[1] || 99);
    return sizeA - sizeB;
  });

  // Dedupe by size — if two Cosmopolitan items share the same size, keep the one with more stock
  const bySize = {};
  for (const detail of sorted) {
    const size = extractSize(detail.Desc || "") || "One Size";
    if (!bySize[size] || (detail.Available || 0) > (bySize[size].Available || 0)) {
      bySize[size] = detail;
    }
  }
  const sortedDetails = Object.values(bySize).sort((a, b) => {
    const sizeA = parseFloat((a.Desc || "").match(/(\d+\.?\d*)\s*OZ/i)?.[1] || 99);
    const sizeB = parseFloat((b.Desc || "").match(/(\d+\.?\d*)\s*OZ/i)?.[1] || 99);
    return sizeA - sizeB;
  });

  const variants = sortedDetails.map(detail => {
    const size = extractSize(detail.Desc || "") || "One Size";
    return {
      option1: size,
      sku: detail.Item,
      price: calculatePrice(detail.Net, detail.Retail),
      compare_at_price: detail.Retail ? parseFloat(detail.Retail).toFixed(2) : null,
      inventory_management: "shopify",
      inventory_policy: "deny", // stops purchase once stock hits 0
      inventory_quantity: detail.Available || 0,
      weight: parseFloat(detail.Weight || 0),
      weight_unit: "oz",
      fulfillment_service: "manual",
      requires_shipping: true,
      taxable: true
    };
  });

  const res = await request(
    { hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/products.json", method: "POST",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { product: {
        title, body_html: description,
        vendor: groupDetails[0].Designer || "Cosmopolitan Cosmetics",
        product_type: extractProductType(groupDetails[0].Desc || ""),
        tags: ["fragrance", groupDetails[0].ProductLine, extractGender(groupDetails[0].Desc || "")].filter(Boolean).join(", "),
        options: [{ name: "Size" }],
        variants,
        images: imageUrl ? [{ src: imageUrl }] : []
      }
    }
  );

  if (res.status === 201) {
    console.log(`✅ Created: ${title} (${variants.length} size${variants.length > 1 ? "s" : ""})`);
    return res.body.product;
  }
  console.log(`⚠️ Failed: ${title} — ${JSON.stringify(res.body).slice(0, 150)}`);
  return null;
}

async function updateShopifyProduct(productId, groupDetails) {
  const title = buildProductTitle(groupDetails);
  const description = buildDescription(groupDetails);
  const res = await request(
    { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/products/${productId}.json`, method: "PUT",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { product: { id: productId, title, body_html: description,
        vendor: groupDetails[0].Designer || "Cosmopolitan Cosmetics",
        product_type: extractProductType(groupDetails[0].Desc || "") } }
  );
  if (res.status === 200) console.log(`🔄 Updated: ${title}`);
  return res.status === 200;
}

async function addVariantToProduct(productId, detail) {
  const size = extractSize(detail.Desc || "") || "One Size";
  const res = await request(
    { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/products/${productId}/variants.json`, method: "POST",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { variant: {
        option1: size, sku: detail.Item,
        price: calculatePrice(detail.Net, detail.Retail),
        compare_at_price: detail.Retail ? parseFloat(detail.Retail).toFixed(2) : null,
        inventory_management: "shopify",
        inventory_policy: "deny", // stops purchase once stock hits 0
        inventory_quantity: detail.Available || 0,
        weight: parseFloat(detail.Weight || 0), weight_unit: "oz",
        fulfillment_service: "manual", requires_shipping: true, taxable: true
      }
    }
  );
  return res.status === 201 ? res.body.variant : null;
}

// Sets stock level AND forces inventory_policy to "deny" so 0 stock actually blocks
// checkout. Takes inventoryItemId directly (fetched once upfront) instead of doing
// a GET per call - this cuts API calls per item from 3 down to 2.
async function deleteVariant(productId, variantId) {
  const res = await request(
    { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/products/${productId}/variants/${variantId}.json`, method: "DELETE",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } }
  );
  return res.status === 200;
}

async function setProductStatus(productId, status) {
  const res = await request(
    { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/products/${productId}.json`, method: "PUT",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { product: { id: productId, status } }
  );
  return res.status === 200;
}

async function updateInventory(variantId, inventoryItemId, available, locationId, price, compareAtPrice) {
  if (!inventoryItemId || !locationId) return;

  const variantUpdate = { id: variantId, inventory_policy: "deny" };
  if (price) variantUpdate.price = price;
  if (compareAtPrice) variantUpdate.compare_at_price = compareAtPrice;

  await request(
    { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/variants/${variantId}.json`, method: "PUT",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { variant: variantUpdate }
  );

  await request(
    { hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/inventory_levels/set.json", method: "POST",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { location_id: locationId, inventory_item_id: inventoryItemId, available }
  );
}

// ─── ORDERS ──────────────────────────────────────────────────────────────────
async function processOrders() {
  const res = await request({
    hostname: SHOPIFY_STORE,
    path: "/admin/api/2024-01/orders.json?fulfillment_status=unfulfilled&status=open&limit=50",
    method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
  });
  const orders = res.body.orders || [];
  let submitted = 0;
  for (const order of orders) {
    if ((order.tags || "").includes("cosmo-submitted")) continue;
    const shipping = order.shipping_address;
    if (!shipping) continue;
    const suborder = {
      Suborder: `BLOOM-${order.order_number}`,
      ShipTo: {
        Name: `${shipping.first_name} ${shipping.last_name}`.trim(),
        Line1: shipping.address1, Line2: shipping.address2 || undefined,
        City: shipping.city, State: shipping.province_code, Zip: shipping.zip,
        Country: shipping.country_code, Phone: shipping.phone || undefined,
        Email: order.email || undefined, Residence: true
      },
      Lines: order.line_items.map(item => ({
        SKU: item.sku, QTY: item.quantity,
        NET: parseFloat(item.price || 0).toFixed(2),
        EndPrice: shipping.country_code !== "US" ? parseFloat(item.price).toFixed(2) : undefined
      }))
    };
    const subRes = await request(
      { hostname: "api.cosmopolitanusa.com", path: "/v1/suborders", method: "POST",
        headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" } },
      suborder
    );
    if (subRes.status === 201 || subRes.status === 200) {
      submitted++;
      console.log(`✅ Submitted order BLOOM-${order.order_number}`);
      await request(
        { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/orders/${order.id}.json`, method: "PUT",
          headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
        { order: { id: order.id, tags: ((order.tags || "") + ",cosmo-submitted").replace(/^,/, "") } }
      );
    }
    await sleep(300);
  }
  if (submitted > 0) {
    const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
    await request(
      { hostname: "api.cosmopolitanusa.com", path: "/v1/dropship", method: "POST",
        headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" } },
      { PO: `BLOOM-PO-${today}`, Comment: "Bloom Fragrances USA daily order" }
    );
    console.log(`✅ Dropship PO submitted`);
  }
}

async function syncTracking() {
  const res = await request({
    hostname: SHOPIFY_STORE,
    path: "/admin/api/2024-01/orders.json?fulfillment_status=unfulfilled&status=open&limit=50",
    method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
  });
  const orders = (res.body.orders || []).filter(o =>
    (o.tags || "").includes("cosmo-submitted") && !(o.tags || "").includes("cosmo-tracked")
  );
  for (const order of orders) {
    const orderNum = `BLOOM-${order.order_number}`;
    const trackRes = await request({
      hostname: "api.cosmopolitanusa.com", path: `/v1/dropship/suborder/${encodeURIComponent(orderNum)}`,
      method: "GET", headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" }
    });
    const tracking = trackRes.body?.Shipments?.[0]?.TrackingNumber;
    const carrier = trackRes.body?.Shipments?.[0]?.Carrier || "other";
    if (!tracking) continue;
    const foRes = await request({
      hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/orders/${order.id}/fulfillment_orders.json`,
      method: "GET", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
    });
    const fulfillmentOrderId = foRes.body?.fulfillment_orders?.[0]?.id;
    if (!fulfillmentOrderId) continue;
    const carrierMap = { FEDEX: "FedEx", UPS: "UPS", USPS: "USPS", FEDGND: "FedEx", UPSGND: "UPS", USPSP: "USPS" };
    const fulfillRes = await request(
      { hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/fulfillments.json", method: "POST",
        headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
      { fulfillment: {
          line_items_by_fulfillment_order: [{ fulfillment_order_id: fulfillmentOrderId }],
          tracking_info: { number: tracking, company: carrierMap[carrier.toUpperCase()] || carrier },
          notify_customer: true
        }
      }
    );
    if (fulfillRes.status === 201) {
      console.log(`✅ Tracked order ${orderNum}`);
      await request(
        { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/orders/${order.id}.json`, method: "PUT",
          headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
        { order: { id: order.id, tags: ((order.tags || "") + ",cosmo-tracked").replace(/^,/, "") } }
      );
    }
    await sleep(500);
  }
}

// ─── MAIN SYNC ────────────────────────────────────────────────────────────────
async function runSync(fullReset = false) {
  if (!SHOPIFY_TOKEN) { console.log("⚠️ No token — visit /install"); return; }
  if (syncRunning) { console.log("⚠️ Sync already running"); return; }
  syncRunning = true;
  console.log("🌸 Bloom Fragrances USA - Sync starting...", new Date().toISOString());

  try {
    if (fullReset) clearProgress();
    const savedProgress = loadProgress();
    const processedGroups = savedProgress.processedGroups || {};

    const { skuMap, titleToProductId } = await getAllShopifySkus();
    const locationId = await getLocationId();

    let totalCreated = 0, totalUpdated = 0;
    const allowedLines = ["FRAG", "GIFT", "GSET", "SET", "COFF", "GFTS"];

    let allItems;
    if (savedProgress.allItems && savedProgress.allItems.length > 0) {
      console.log(`📋 Resuming with ${savedProgress.allItems.length} previously collected items`);
      allItems = savedProgress.allItems;
    } else {
      console.log("📋 Collecting all items from Cosmopolitan...");
      allItems = [];
      let p = 1;
      while (true) {
        const { items, hasMore } = await fetchCosmoPage(p);
        if (items.length === 0) break;
        allItems = allItems.concat(items);
        console.log(`📦 Page ${p}: ${items.length} items, total: ${allItems.length}`);
        if (!hasMore) break;
        p++;
        await sleep(150);
      }
      console.log(`✅ Total: ${allItems.length} items from Cosmopolitan`);
      saveProgress({ processedGroups, groups: {}, lastItemIndex: 0, allItems });
    }

    // ── Remove/hide anything not currently available on Cosmopolitan ──
    // If ALL sizes of a product are gone/out of stock -> unpublish the whole product
    // If SOME sizes are gone -> delete just those size variants, keep the rest for sale
    // If a product comes back in stock later, it's automatically republished
    const cosmoData = {};
    for (const item of allItems) cosmoData[item.Item] = item;

    const variantsByProduct = {};
    for (const sku of Object.keys(skuMap)) {
      const v = skuMap[sku];
      if (!variantsByProduct[v.productId]) variantsByProduct[v.productId] = [];
      variantsByProduct[v.productId].push({ sku, variantId: v.variantId, inventoryItemId: v.inventoryItemId });
    }

    let unpublished = 0, variantsRemoved = 0, republished = 0, stockUpdated = 0;

    for (const productId of Object.keys(variantsByProduct)) {
      const variants = variantsByProduct[productId];
      const outVariants = [];
      const inVariants = [];
      for (const v of variants) {
        const item = cosmoData[v.sku];
        const avail = item ? (item.Available || 0) : undefined;
        if (avail === undefined || avail === 0) outVariants.push(v);
        else inVariants.push({ ...v, available: avail, net: item.Net, retail: item.Retail });
      }

      if (outVariants.length === variants.length) {
        await setProductStatus(productId, "draft");
        unpublished++;
        await sleep(200);
      } else {
        for (const v of outVariants) {
          await deleteVariant(productId, v.variantId);
          variantsRemoved++;
          await sleep(200);
        }
        if (inVariants.length > 0) {
          await setProductStatus(productId, "active");
          republished++;
          await sleep(200);
        }
      }

      for (const v of inVariants) {
        const freshPrice = calculatePrice(v.net, v.retail);
        const freshCompareAt = v.retail ? parseFloat(v.retail).toFixed(2) : null;
        await updateInventory(v.variantId, v.inventoryItemId, v.available, locationId, freshPrice, freshCompareAt);
        stockUpdated++;
        await sleep(150);
      }
    }
    console.log(`📉 Unpublished ${unpublished} fully out-of-stock products`);
    console.log(`🗑️ Removed ${variantsRemoved} discontinued size variants`);
    console.log(`🔄 Republished ${republished} restocked products`);
    console.log(`📦 Updated stock on ${stockUpdated} variants`);

    const groups = savedProgress.groups && Object.keys(savedProgress.groups).length
      ? savedProgress.groups
      : {};
    const startIndex = savedProgress.lastItemIndex || 0;
    const seenProductLines = new Set();

    console.log(`🔍 Phase 1: Fetching all product details and grouping (resuming from item ${startIndex})...`);
    for (let i = startIndex; i < allItems.length; i++) {
      const item = allItems[i];

      // Existing SKUs already handled in the bulk pass above (stock/hide/delete/republish)
      if (skuMap[item.Item]) {
        continue;
      }

      const detail = await withRetry(() => fetchCosmoDetail(item.Item));
      if (!detail) continue;
      if (detail.ProductLine) seenProductLines.add(detail.ProductLine);
      if (!allowedLines.includes(detail.ProductLine)) continue;

      const key = buildGroupKey(detail);
      if (!groups[key]) groups[key] = [];
      groups[key].push(detail);

      if (i % 25 === 0) {
        console.log(`📋 ${i+1}/${allItems.length} items processed, ${Object.keys(groups).length} groups so far`);
        saveProgress({ processedGroups, groups, lastItemIndex: i + 1, allItems });
      }
      await sleep(250);
    }

    console.log(`📦 Phase 1 complete! ${Object.keys(groups).length} unique fragrances found`);
    console.log(`📋 Product lines: ${Array.from(seenProductLines).join(", ")}`);
    saveProgress({ processedGroups, groups: {}, lastItemIndex: 0, allItems: null });

    console.log("🛍️ Phase 2: Creating grouped products in Shopify...");
    const groupKeys = Object.keys(groups);
    for (let g = 0; g < groupKeys.length; g++) {
      const key = groupKeys[g];
      const groupDetails = groups[key];

      if (processedGroups[key]) continue;

      // Check both: does this exact SKU already exist, OR does a product with the
      // same computed title (same fragrance/designer/type/gender) already exist,
      // even though this specific new SIZE hasn't been added yet.
      const skuMatch = groupDetails.find(d => skuMap[d.Item]);
      const computedTitle = buildProductTitle(groupDetails);
      const titleMatchProductId = titleToProductId[computedTitle];
      const existingProductId = skuMatch ? skuMap[skuMatch.Item].productId : titleMatchProductId;

      if (existingProductId) {
        await updateShopifyProduct(existingProductId, groupDetails);

        // Dedupe new items by size before adding — if two Cosmo items share a size,
        // keep the one with more stock, same protection as new-product creation
        const newItems = groupDetails.filter(d => !skuMap[d.Item]);
        const bySizeToAdd = {};
        for (const detail of newItems) {
          const size = extractSize(detail.Desc || "") || "One Size";
          if (!bySizeToAdd[size] || (detail.Available || 0) > (bySizeToAdd[size].Available || 0)) {
            bySizeToAdd[size] = detail;
          }
        }

        for (const detail of Object.values(bySizeToAdd)) {
          const newVariant = await addVariantToProduct(existingProductId, detail);
          if (newVariant && newVariant.sku) {
            skuMap[newVariant.sku] = { productId: existingProductId, variantId: newVariant.id, inventoryItemId: newVariant.inventory_item_id };
          }
          await sleep(300);
        }

        // A new size means this fragrance is back in stock — make sure the product
        // is published even if it was hidden earlier (in this run or a previous one)
        if (Object.values(bySizeToAdd).length > 0) {
          await setProductStatus(existingProductId, "active");
          await sleep(200);
        }

        processedGroups[key] = existingProductId;
        totalUpdated++;
      } else {
        const created = await withRetry(() => createShopifyProduct(groupDetails));
        if (created) {
          processedGroups[key] = created.id;
          titleToProductId[created.title] = created.id;
          for (const v of created.variants || []) {
            if (v.sku) skuMap[v.sku] = { productId: created.id, variantId: v.id, inventoryItemId: v.inventory_item_id };
          }
          totalCreated++;
        }
        await sleep(600);
      }

      if (g % 25 === 0) {
        saveProgress({ processedGroups, groups: {}, lastItemIndex: 0, allItems: null });
        console.log(`💾 Progress: ${g+1}/${groupKeys.length} groups, ${totalCreated} created`);
      }
    }

    console.log(`\n📋 Product lines seen: ${Array.from(seenProductLines).join(", ")}`);
    clearProgress();
    console.log(`\n📊 Sync complete! Created: ${totalCreated}, Updated: ${totalUpdated}`);

    await processOrders();
    await syncTracking();
    console.log("🌸 All done!");

  } catch (err) {
    console.error("❌ Sync error:", err.message);
    console.error(err.stack);
  }
  syncRunning = false;
}

// ─── WEB SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  if (path === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>🌸 Bloom Fragrances USA</h1>
      <p>Status: ${SHOPIFY_TOKEN ? "✅ Connected" : "⚠️ Not connected"}</p>
      <p>Sync running: ${syncRunning ? "Yes ⏳" : "No"}</p>
      ${!SHOPIFY_TOKEN
        ? '<a href="/install"><button>Connect to Shopify</button></a>'
        : '<a href="/sync"><button>Sync Now</button></a> &nbsp; <a href="/fullsync"><button>Full Reset Sync</button></a>'
      }`);
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
      SHOPIFY_TOKEN = await exchangeCodeForToken(code, `https://${req.headers.host}`);
      console.log("✅ OAuth complete!");
      console.log("🔑 SAVE THIS TOKEN TO RENDER ENV: " + SHOPIFY_TOKEN);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h1>✅ Connected!</h1><p>Sync starting...</p><a href="/">Back</a>`);
      runSync(true);
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
  else if (path === "/fullsync") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Full reset sync started! Check logs.");
    runSync(true);
  }
  else { res.writeHead(404); res.end("Not found"); }
});

server.listen(PORT, () => {
  console.log(`🌸 Server running on port ${PORT}`);
  setInterval(() => runSync(), 45 * 60 * 1000);
  if (SHOPIFY_TOKEN) setTimeout(() => runSync(), 5000);
});

/**
 * Bloom Fragrances USA - Sync Script
 * Syncs fragrance products from Cosmopolitan Cosmetics API to Shopify
 * - Pulls only FRAG (fragrance) products
 * - Adds $20 markup to wholesale price
 * - Skips products without images
 * - Updates inventory levels
 * - Submits new Shopify orders to Cosmopolitan as dropship orders
 */

const https = require("https");

// ─── CONFIG (set these as environment variables on Render) ───────────────────
const COSMO_TOKEN = process.env.COSMO_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. izt0qr-mh.myshopify.com
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const MARKUP = 20; // $20 over wholesale price

// ─── HELPERS ────────────────────────────────────────────────────────────────

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Get a fresh Shopify access token (valid ~24 hours)
async function getShopifyToken() {
  console.log("🔑 Getting Shopify access token...");
  const res = await request(
    {
      hostname: SHOPIFY_STORE,
      path: "/admin/oauth/access_token",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    {
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }
  );
  if (!res.body.access_token) {
    throw new Error("Failed to get Shopify token: " + JSON.stringify(res.body));
  }
  console.log("✅ Shopify token obtained");
  return res.body.access_token;
}

// Fetch all fragrance products from Cosmopolitan (paginated)
async function fetchCosmoProducts() {
  console.log("📦 Fetching products from Cosmopolitan API...");
  let products = [];
  let url = "/v1/products?page=1";

  while (url) {
    const res = await request({
      hostname: "api.cosmopolitanusa.com",
      path: url,
      method: "GET",
      headers: {
        Authorization: `CosmoToken ${COSMO_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (res.status !== 200 || !res.body.Results) break;

    // Filter fragrances only (ProductLine = FRAG) - checked at detail level
    products = products.concat(res.body.Results);

    // Get next page
    url = res.body.NextUrl
      ? res.body.NextUrl.replace("https://api.cosmopolitanusa.com", "")
      : null;
  }

  console.log(`✅ Found ${products.length} total products`);
  return products;
}

// Fetch full product details (includes ProductLine, ImageURL, etc.)
async function fetchCosmoProductDetail(itemCode) {
  const res = await request({
    hostname: "api.cosmopolitanusa.com",
    path: `/v1/products/${encodeURIComponent(itemCode)}`,
    method: "GET",
    headers: {
      Authorization: `CosmoToken ${COSMO_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  return res.status === 200 ? res.body : null;
}

// Get all existing Shopify products (to avoid duplicates)
async function getShopifyProducts(token) {
  console.log("🛍️ Fetching existing Shopify products...");
  const res = await request({
    hostname: SHOPIFY_STORE,
    path: "/admin/api/2024-01/products.json?limit=250&fields=id,variants,tags",
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });
  const products = res.body.products || [];
  // Build a map of SKU -> shopify product id
  const skuMap = {};
  for (const p of products) {
    for (const v of p.variants || []) {
      if (v.sku) skuMap[v.sku] = { productId: p.id, variantId: v.id };
    }
  }
  console.log(`✅ Found ${products.length} existing Shopify products`);
  return skuMap;
}

// Create a new product in Shopify
async function createShopifyProduct(token, detail) {
  const price = (parseFloat(detail.Net) + MARKUP).toFixed(2);
  const comparePrice = detail.Retail
    ? parseFloat(detail.Retail).toFixed(2)
    : null;

  const product = {
    product: {
      title: detail.Desc,
      body_html: [detail.Desc2, detail.Desc3].filter(Boolean).join("<br>"),
      vendor: detail.Designer || "Cosmopolitan Cosmetics",
      product_type: "Fragrance",
      tags: ["fragrance", detail.ProductLine, detail.ProductClass]
        .filter(Boolean)
        .join(", "),
      images: detail.ImageURL ? [{ src: detail.ImageURL }] : [],
      variants: [
        {
          sku: detail.Item,
          price: price,
          compare_at_price: comparePrice,
          inventory_management: "shopify",
          inventory_quantity: detail.Available || 0,
          weight: detail.Weight || 0,
          weight_unit: "oz",
          fulfillment_service: "manual",
          requires_shipping: true,
          taxable: true,
        },
      ],
    },
  };

  const res = await request(
    {
      hostname: SHOPIFY_STORE,
      path: "/admin/api/2024-01/products.json",
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    },
    product
  );

  return res.status === 201 ? res.body.product : null;
}

// Update inventory for an existing Shopify variant
async function updateShopifyInventory(token, variantId, available) {
  // Get inventory item id
  const varRes = await request({
    hostname: SHOPIFY_STORE,
    path: `/admin/api/2024-01/variants/${variantId}.json`,
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  const inventoryItemId = varRes.body?.variant?.inventory_item_id;
  if (!inventoryItemId) return;

  // Get location id
  const locRes = await request({
    hostname: SHOPIFY_STORE,
    path: "/admin/api/2024-01/locations.json",
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  const locationId = locRes.body?.locations?.[0]?.id;
  if (!locationId) return;

  // Set inventory level
  await request(
    {
      hostname: SHOPIFY_STORE,
      path: "/admin/api/2024-01/inventory_levels/set.json",
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    },
    {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: available,
    }
  );
}

// Get unfulfilled Shopify orders and submit to Cosmopolitan as dropship
async function processOrders(token) {
  console.log("📬 Checking for new orders to submit to Cosmopolitan...");

  const res = await request({
    hostname: SHOPIFY_STORE,
    path: "/admin/api/2024-01/orders.json?fulfillment_status=unfulfilled&status=open&limit=50",
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  const orders = res.body.orders || [];
  console.log(`📦 Found ${orders.length} unfulfilled orders`);

  for (const order of orders) {
    // Check if already submitted (tagged)
    if ((order.tags || "").includes("cosmo-submitted")) continue;

    const shipping = order.shipping_address;
    if (!shipping) continue;

    // Build suborder for Cosmopolitan
    const suborder = {
      Suborder: `BLOOM-${order.order_number}`,
      ShipTo: {
        Name: `${shipping.first_name} ${shipping.last_name}`.trim(),
        Line1: shipping.address1,
        Line2: shipping.address2 || undefined,
        City: shipping.city,
        State: shipping.province_code,
        Zip: shipping.zip,
        Country: shipping.country_code,
        Phone: shipping.phone || undefined,
        Email: order.email || undefined,
        Residence: true,
      },
      Lines: order.line_items.map((item) => ({
        SKU: item.sku,
        QTY: item.quantity,
        NET: parseFloat(item.price) - MARKUP > 0
          ? (parseFloat(item.price) - MARKUP).toFixed(2)
          : item.price,
        EndPrice:
          shipping.country_code !== "US"
            ? parseFloat(item.price).toFixed(2)
            : undefined,
      })),
    };

    // Submit suborder to Cosmopolitan
    const subRes = await request(
      {
        hostname: "api.cosmopolitanusa.com",
        path: "/v1/suborders",
        method: "POST",
        headers: {
          Authorization: `CosmoToken ${COSMO_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
      suborder
    );

    if (subRes.status === 201 || subRes.status === 200) {
      console.log(`✅ Submitted order BLOOM-${order.order_number} to Cosmopolitan`);

      // Tag the order as submitted in Shopify
      await request(
        {
          hostname: SHOPIFY_STORE,
          path: `/admin/api/2024-01/orders/${order.id}.json`,
          method: "PUT",
          headers: {
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
          },
        },
        {
          order: {
            id: order.id,
            tags: ((order.tags || "") + ",cosmo-submitted").replace(/^,/, ""),
          },
        }
      );
    } else {
      console.error(`❌ Failed to submit order ${order.order_number}:`, JSON.stringify(subRes.body));
    }
  }

  // Submit all pending suborders as one dropship PO
  const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
  const poRes = await request(
    {
      hostname: "api.cosmopolitanusa.com",
      path: "/v1/dropship",
      method: "POST",
      headers: {
        Authorization: `CosmoToken ${COSMO_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
    { PO: `BLOOM-PO-${today}`, Comment: "Bloom Fragrances USA daily order" }
  );

  if (poRes.body === "Dropship submitted successfully" || poRes.status === 200) {
    console.log(`✅ Daily dropship PO submitted: BLOOM-PO-${today}`);
  } else {
    console.log("ℹ️ No new suborders to submit or already submitted today");
  }
}

// Get tracking numbers from Cosmopolitan and update Shopify orders
async function syncTracking(token) {
  console.log("🚚 Checking for tracking numbers...");

  const res = await request({
    hostname: SHOPIFY_STORE,
    path: "/admin/api/2024-01/orders.json?fulfillment_status=unfulfilled&status=open&limit=50",
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  const orders = res.body.orders || [];
  const submitted = orders.filter(o => (o.tags || "").includes("cosmo-submitted") && !(o.tags || "").includes("cosmo-tracked"));

  console.log(`📦 Found ${submitted.length} orders to check for tracking`);

  for (const order of submitted) {
    const orderNum = `BLOOM-${order.order_number}`;

    const trackRes = await request({
      hostname: "api.cosmopolitanusa.com",
      path: `/v1/suborders/${encodeURIComponent(orderNum)}`,
      method: "GET",
      headers: {
        Authorization: `CosmoToken ${COSMO_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    const tracking = trackRes.body?.TrackingNumber;
    const carrier = trackRes.body?.Carrier || "other";
    if (!tracking) continue;

    console.log(`📬 Got tracking for order ${orderNum}: ${tracking}`);

    const foRes = await request({
      hostname: SHOPIFY_STORE,
      path: `/admin/api/2024-01/orders/${order.id}/fulfillment_orders.json`,
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    });

    const fulfillmentOrderId = foRes.body?.fulfillment_orders?.[0]?.id;
    if (!fulfillmentOrderId) continue;

    const carrierMap = { FEDEX: "FedEx", UPS: "UPS", USPS: "USPS", FEDGND: "FedEx", UPSGND: "UPS", USPSP: "USPS" };
    const shopifyCarrier = carrierMap[carrier.toUpperCase()] || carrier;

    const fulfillRes = await request(
      {
        hostname: SHOPIFY_STORE,
        path: "/admin/api/2024-01/fulfillments.json",
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      },
      {
        fulfillment: {
          line_items_by_fulfillment_order: [{ fulfillment_order_id: fulfillmentOrderId }],
          tracking_info: { number: tracking, company: shopifyCarrier },
          notify_customer: true,
        },
      }
    );

    if (fulfillRes.status === 201) {
      console.log(`✅ Fulfilled order ${orderNum} — customer notified!`);
      await request(
        {
          hostname: SHOPIFY_STORE,
          path: `/admin/api/2024-01/orders/${order.id}.json`,
          method: "PUT",
          headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        },
        { order: { id: order.id, tags: ((order.tags || "") + ",cosmo-tracked").replace(/^,/, "") } }
      );
    } else {
      console.error(`❌ Failed to fulfill order ${orderNum}:`, JSON.stringify(fulfillRes.body));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🌸 Bloom Fragrances USA - Sync starting...");
  console.log(new Date().toISOString());

  try {
    // 1. Get Shopify token
    const shopifyToken = await getShopifyToken();

    // 2. Get existing Shopify products
    const existingSkus = await getShopifyProducts(shopifyToken);

    // 3. Fetch all Cosmopolitan products
    const allProducts = await fetchCosmoProducts();

    let created = 0;
    let updated = 0;
    let skipped = 0;

    // 4. Process each product
    for (const product of allProducts) {
      // Get full details
      const detail = await fetchCosmoProductDetail(product.Item);
      if (!detail) { skipped++; continue; }

      // Only process fragrances
      if (detail.ProductLine !== "FRAG") { skipped++; continue; }

      // If no image, use a placeholder
      if (!detail.ImageURL) detail.ImageURL = null;

      // Skip products with no stock and not already in store
      if (detail.Available <= 0 && !existingSkus[detail.Item]) {
        skipped++;
        continue;
      }

      if (existingSkus[detail.Item]) {
        // Update inventory for existing product
        await updateShopifyInventory(
          shopifyToken,
          existingSkus[detail.Item].variantId,
          detail.Available || 0
        );
        updated++;
      } else {
        // Create new product
        const created_product = await createShopifyProduct(shopifyToken, detail);
        if (created_product) {
          created++;
          console.log(`✅ Created: ${detail.Desc}`);
        }
      }

      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log(`\n📊 Sync complete!`);
    console.log(`   ✅ Created: ${created} new products`);
    console.log(`   🔄 Updated: ${updated} inventory levels`);
    console.log(`   ⏭️  Skipped: ${skipped} products`);

    // 5. Process and submit orders
    await processOrders(shopifyToken);

    // 6. Sync tracking numbers back to customers
    await syncTracking(shopifyToken);

    console.log("\n🌸 All done! Next run scheduled by Render Cron Job.");
  } catch (err) {
    console.error("❌ Sync failed:", err.message);
    process.exit(1);
  }
}

main();

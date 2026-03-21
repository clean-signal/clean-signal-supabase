import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const STALE_DAYS = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { barcode } = await req.json();

    console.log(`[lookup-barcode] Request for barcode: ${barcode}`);

    if (!barcode || typeof barcode !== "string") {
      console.warn(`[lookup-barcode] Bad request — missing barcode`);
      return new Response(
        JSON.stringify({ error: "barcode is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Connect to Supabase using the service role (bypasses RLS)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Check cache
    const { data: cached } = await supabase
      .from("products")
      .select("*")
      .eq("barcode", barcode)
      .single();

    if (cached) {
      const fetchedAt = new Date(cached.fetched_at);
      const ageMs = Date.now() - fetchedAt.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      if (ageDays < STALE_DAYS) {
        console.log(`[lookup-barcode] Cache HIT for ${barcode} — "${cached.product_name}" (age: ${ageDays.toFixed(1)} days)`);
        return new Response(
          JSON.stringify({ source: "cache", product: cached }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      console.log(`[lookup-barcode] Cache STALE for ${barcode} (age: ${ageDays.toFixed(1)} days) — refreshing`);
    }

    // Fetch from Open Food Facts
    const offRes = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=code,product_name,brands,ingredients_text,nutriments,nova_group`,
      { headers: { "User-Agent": "CleanSignal/1.0" } },
    );

    if (!offRes.ok && offRes.status !== 404) {
      console.error(`[lookup-barcode] Open Food Facts API error: ${offRes.status} for ${barcode}`);
      return new Response(
        JSON.stringify({ error: "Failed to fetch from Open Food Facts" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const offData = await offRes.json();

    if (offRes.status === 404 || offData.status === 0 || !offData.product) {
      console.warn(`[lookup-barcode] Product not found for ${barcode}`);

      // Track not-found barcode
      const { data: existing } = await supabase
        .from("not_found_barcodes")
        .select("scan_count")
        .eq("barcode", barcode)
        .single();

      if (existing) {
        await supabase
          .from("not_found_barcodes")
          .update({ scan_count: existing.scan_count + 1, last_scanned_at: new Date().toISOString() })
          .eq("barcode", barcode);
      } else {
        await supabase
          .from("not_found_barcodes")
          .insert({ barcode });
      }

      return new Response(
        JSON.stringify({ error: "Product not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const p = offData.product;
    const nutriments = p.nutriments || {};

    const product = {
      barcode,
      product_name: p.product_name || null,
      brand: p.brands || null,
      energy_kcal_100g: nutriments["energy-kcal_100g"] ?? null,
      proteins_100g: nutriments["proteins_100g"] ?? null,
      carbohydrates_100g: nutriments["carbohydrates_100g"] ?? null,
      fat_100g: nutriments["fat_100g"] ?? null,
      nova_group: p.nova_group ?? null,
      ingredients_text: p.ingredients_text || null,
      fetched_at: new Date().toISOString(),
    };

    // Upsert into cache
    const { error: upsertError } = await supabase
      .from("products")
      .upsert(product, { onConflict: "barcode" });

    if (upsertError) {
      console.error("Upsert error:", upsertError);
    }

    console.log(`[lookup-barcode] API fetch for ${barcode} — "${product.product_name}" by "${product.brand}"`);

    return new Response(
      JSON.stringify({ source: "api", product }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("Function error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

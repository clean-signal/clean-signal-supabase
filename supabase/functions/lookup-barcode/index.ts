import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const STALE_DAYS = 30;

const SEED_OIL_IDS = new Set([
  "en:sunflower-oil",
  "en:soybean-oil",
  "en:corn-oil",
  "en:cottonseed-oil",
  "en:palm-oil",
  "en:palm-kernel-oil",
  "en:rice-bran-oil",
  "en:grapeseed-oil",
  "en:safflower-oil",
  "en:canola-oil",
]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Estimate NOVA group when OFF doesn't provide one.
 * Simple heuristic — needs a proper ingredient→NOVA database long term.
 *
 * Logic:
 *   - Has additives or UPF marker words → NOVA 4
 *   - ≤3 ingredients, no additives → NOVA 1 (simple whole food)
 *   - >5 ingredients → NOVA 3 (processed food)
 *   - Otherwise → NOVA 2 (processed culinary ingredient)
 */
function estimateNova(product: {
  additives_tags: string[] | null;
  ingredients: any[] | null;
  ingredients_n: number | null;
  ingredients_text: string | null;
}): number {
  const addCount = product.additives_tags?.length ?? 0;
  const ingCount = product.ingredients_n ?? 0;
  const ingText = (product.ingredients_text || "").toLowerCase();

  // NOVA 4: has additives or UPF marker ingredients
  if (addCount > 0) return 4;

  const upfMarkers = [
    "high-fructose", "hydrogenated", "maltodextrin", "dextrose",
    "modified starch", "protein isolate", "invert sugar", "glucose syrup",
    "flavour", "flavor", "colour", "color",
  ];
  if (upfMarkers.some((m) => ingText.includes(m))) return 4;

  // NOVA 1: few ingredients, no additives, no UPF markers → simple whole food
  if (ingCount <= 3) return 1;

  // NOVA 3: many ingredients suggests a processed food product
  if (ingCount > 5) return 3;

  // NOVA 2: 4-5 ingredients, no additives — likely a simple processed ingredient
  return 2;
}

/** Recursively check if any ingredient (or nested sub-ingredient) matches a seed oil ID. */
function containsSeedOil(ingredients: any[]): boolean {
  for (const ing of ingredients) {
    if (ing.id && SEED_OIL_IDS.has(ing.id)) return true;
    if (Array.isArray(ing.ingredients) && containsSeedOil(ing.ingredients)) return true;
  }
  return false;
}

/** Resolve additive E-number IDs to human-readable names via OFF taxonomy. */
async function resolveAdditiveNames(tags: string[]): Promise<{ id: string; name: string }[]> {
  if (!tags || tags.length === 0) return [];
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/taxonomy?tagtype=additives&tags=${tags.join(",")}&fields=name`,
      { headers: { "User-Agent": "CleanSignal/1.0" } },
    );
    if (!res.ok) throw new Error(`Taxonomy API returned ${res.status}`);
    const data = await res.json();
    return tags.map((tag) => {
      const entry = data[tag];
      const fullName = entry?.name?.en || tag.replace("en:", "").toUpperCase();
      // "E412 - Guar gum" → just "Guar gum"
      const name = fullName.includes(" - ") ? fullName.split(" - ").slice(1).join(" - ") : fullName;
      return { id: tag.replace("en:", "").toUpperCase(), name };
    });
  } catch (err) {
    console.warn("[lookup-barcode] Failed to resolve additive names:", err);
    return tags.map((tag) => ({ id: tag.replace("en:", "").toUpperCase(), name: tag.replace("en:", "").toUpperCase() }));
  }
}

/**
 * Compute the Clean Score (0-100) — evidence-based longevity scoring.
 *
 * Factor weights based on strength of association with all-cause/CVD mortality:
 *   NOVA (30) — strongest single predictor of UPF-related mortality
 *   Sugars (20) — robust link to obesity, diabetes, CVD at high intakes
 *   Salt (15) — clear dose-response for CVD above ~1.5g/100g
 *   Saturated fat (10) — modest but consistent CHD/cancer associations
 *   Additives (10) — emerging evidence for emulsifiers/mixtures
 *   Nutri-Score (5) — validated composite predictor, sanity-check overlay
 *
 * Hard red flags (override score):
 *   Industrial trans fats → cap at 20 (strongest single villain per meta-analyses)
 *   Processed meat + nitrites → extra penalty (IARC Group 1 carcinogen)
 *   Alcohol → cap at 50 (clear dose-response for cancer/mortality)
 *
 * NOT scored (display only): seed oils, palm oil — weak/controversial evidence
 */

const NITRITE_NITRATE_IDS = new Set(["en:e249", "en:e250", "en:e251", "en:e252"]);

const PROCESSED_MEAT_CATEGORIES = new Set([
  "en:bacon", "en:ham", "en:salami", "en:sausages", "en:hot-dogs",
  "en:chorizo", "en:pepperoni", "en:mortadella", "en:prosciutto",
  "en:smoked-bacon", "en:unsmoked-bacon", "en:back-bacon", "en:bacon-rashers",
  "en:processed-meats", "en:dried-meats", "en:cured-meats",
]);

function computeCleanScore(product: {
  nova_group: number | null;
  additives: { id: string; name: string }[] | null;
  additives_raw: string[] | null;
  sugars_100g: number | null;
  saturated_fat_100g: number | null;
  salt_100g: number | null;
  nutriscore_grade: string | null;
  ingredients_text: string | null;
  categories_tags: string[] | null;
  alcohol_100g: number | null;
}): { score: number; breakdown: { factor: string; points: number; maxPoints: number; verdict: string }[] } {
  const breakdown: { factor: string; points: number; maxPoints: number; verdict: string; estimated: boolean }[] = [];

  // 1. NOVA group (0-35 pts)
  const novaMax = 35;
  let novaPoints = novaMax;
  let novaVerdict = "No data";
  let novaEstimated = true;
  if (product.nova_group != null) {
    novaEstimated = false;
    const novaMap: Record<number, { pts: number; verdict: string }> = {
      1: { pts: 35, verdict: "Unprocessed" },
      2: { pts: 26, verdict: "Processed ingredient" },
      3: { pts: 14, verdict: "Processed" },
      4: { pts: 0, verdict: "Ultra-processed" },
    };
    const entry = novaMap[product.nova_group] || { pts: 0, verdict: `NOVA ${product.nova_group}` };
    novaPoints = entry.pts;
    novaVerdict = entry.verdict;
  }
  breakdown.push({ factor: "Processing", points: novaPoints, maxPoints: novaMax, verdict: novaVerdict, estimated: novaEstimated });

  // 2. Sugars (0-20 pts) — linear decay 0g→25g
  const sugarMax = 20;
  let sugarPoints = sugarMax;
  let sugarVerdict = "No data";
  let sugarEstimated = true;
  if (product.sugars_100g != null) {
    sugarEstimated = false;
    sugarPoints = Math.round(Math.max(0, sugarMax * (1 - product.sugars_100g / 25)));
    if (product.sugars_100g <= 2) sugarVerdict = "Very low sugar";
    else if (product.sugars_100g <= 5) sugarVerdict = "Low sugar";
    else if (product.sugars_100g <= 10) sugarVerdict = "Moderate sugar";
    else if (product.sugars_100g <= 20) sugarVerdict = "High sugar";
    else sugarVerdict = "Very high sugar";
  }
  breakdown.push({ factor: "Sugars", points: sugarPoints, maxPoints: sugarMax, verdict: sugarVerdict, estimated: sugarEstimated });

  // 3. Salt (0-20 pts) — linear decay 0g→1.5g
  const saltMax = 20;
  let saltPoints = saltMax;
  let saltVerdict = "No data";
  let saltEstimated = true;
  if (product.salt_100g != null) {
    saltEstimated = false;
    saltPoints = Math.round(Math.max(0, saltMax * (1 - product.salt_100g / 1.5)));
    if (product.salt_100g <= 0.3) saltVerdict = "Low salt";
    else if (product.salt_100g <= 0.6) saltVerdict = "Moderate salt";
    else if (product.salt_100g <= 1.2) saltVerdict = "High salt";
    else saltVerdict = "Very high salt";
  }
  breakdown.push({ factor: "Salt", points: saltPoints, maxPoints: saltMax, verdict: saltVerdict, estimated: saltEstimated });

  // 4. Saturated fat (0-10 pts) — linear decay 0g→10g
  const satMax = 10;
  let satPoints = satMax;
  let satVerdict = "No data";
  let satEstimated = true;
  if (product.saturated_fat_100g != null) {
    satEstimated = false;
    satPoints = Math.round(Math.max(0, satMax * (1 - product.saturated_fat_100g / 10)));
    if (product.saturated_fat_100g <= 1.5) satVerdict = "Low saturated fat";
    else if (product.saturated_fat_100g <= 5) satVerdict = "Moderate saturated fat";
    else satVerdict = "High saturated fat";
  }
  breakdown.push({ factor: "Saturated fat", points: satPoints, maxPoints: satMax, verdict: satVerdict, estimated: satEstimated });

  // 5. Additives (0-10 pts) — softer curve
  const addMax = 10;
  const addCount = product.additives?.length ?? 0;
  let addPoints: number;
  let addVerdict: string;
  let addEstimated = false;
  if (product.additives == null) {
    addPoints = addMax;
    addVerdict = "No data";
    addEstimated = true;
  } else {
    const addMap: Record<number, number> = { 0: 10, 1: 8, 2: 6, 3: 4, 4: 2 };
    addPoints = addMap[addCount] ?? 0;
    if (addCount === 0) addVerdict = "No additives";
    else addVerdict = `${addCount} additive${addCount > 1 ? "s" : ""}`;
  }
  breakdown.push({ factor: "Additives", points: addPoints, maxPoints: addMax, verdict: addVerdict, estimated: addEstimated });

  // 6. Nutri-Score (0-5 pts)
  const nutriMax = 5;
  let nutriPoints = nutriMax;
  let nutriVerdict = "No data";
  let nutriEstimated = true;
  if (product.nutriscore_grade && product.nutriscore_grade.toLowerCase() !== "unknown" && product.nutriscore_grade.toLowerCase() !== "not-applicable") {
    nutriEstimated = false;
    const nutriMap: Record<string, { pts: number; verdict: string }> = {
      a: { pts: 5, verdict: "Nutri-Score A" },
      b: { pts: 3, verdict: "Nutri-Score B" },
      c: { pts: 2, verdict: "Nutri-Score C" },
      d: { pts: 1, verdict: "Nutri-Score D" },
      e: { pts: 0, verdict: "Nutri-Score E" },
    };
    const entry = nutriMap[product.nutriscore_grade.toLowerCase()] || { pts: 0, verdict: `Nutri-Score ${product.nutriscore_grade}` };
    nutriPoints = entry.pts;
    nutriVerdict = entry.verdict;
  }
  breakdown.push({ factor: "Nutri-Score", points: nutriPoints, maxPoints: nutriMax, verdict: nutriVerdict, estimated: nutriEstimated });

  let score = Math.round(breakdown.reduce((sum, b) => sum + b.points, 0));

  // --- Hard red flags (post-score overrides) ---

  // Trans fats: cap score at 20
  const ingText = (product.ingredients_text || "").toLowerCase();
  const hasTransFat = ingText.includes("partially hydrogenated") ||
    ingText.includes("hydrogenated vegetable oil") ||
    ingText.includes("shortening");
  if (hasTransFat) {
    score = Math.min(score, 20);
    breakdown.push({ factor: "Trans fats", points: 0, maxPoints: 0, verdict: "Contains industrial trans fats", estimated: false });
  }

  // Processed meat + nitrites: -10 penalty
  const categories = product.categories_tags || [];
  const hasProcessedMeatCategory = categories.some((c) => PROCESSED_MEAT_CATEGORIES.has(c));
  const rawAdditives = product.additives_raw || [];
  const hasNitrites = rawAdditives.some((a) => NITRITE_NITRATE_IDS.has(a));
  if (hasProcessedMeatCategory && hasNitrites) {
    score = Math.max(0, score - 10);
    breakdown.push({ factor: "Processed meat", points: 0, maxPoints: 0, verdict: "Processed meat with nitrites", estimated: false });
  }

  // Alcohol: cap at 50
  if (product.alcohol_100g != null && product.alcohol_100g > 1) {
    score = Math.min(score, 50);
    breakdown.push({ factor: "Alcohol", points: 0, maxPoints: 0, verdict: `Contains alcohol (${product.alcohol_100g}%)`, estimated: false });
  }

  return { score, breakdown };
}

// --- Ingredient DB helpers ---

const VITAMIN_MINERAL_PATTERNS = [
  "vitamin", "iron", "zinc", "calcium", "magnesium", "folic-acid", "niacin",
  "riboflavin", "thiamin", "biotin", "pantothenic", "selenium", "iodine",
  "potassium", "phosphorus", "manganese", "copper", "chromium", "molybdenum",
];

function deriveIngredientType(id: string, additivesTags: Set<string>): string {
  if (additivesTags.has(id)) return "additive";
  if (/^en:e\d{3}/.test(id)) return "additive";
  if (VITAMIN_MINERAL_PATTERNS.some((p) => id.includes(p))) return "vitamin";
  return "ingredient";
}

interface FlatIngredient {
  id: string;
  text: string;
  percent_estimate: number | null;
  vegan: string | null;
  vegetarian: string | null;
  parent_id: string | null;
  depth: number;
}

function flattenIngredientTree(
  ingredients: any[],
  parentId: string | null = null,
  depth: number = 0,
): FlatIngredient[] {
  const result: FlatIngredient[] = [];
  for (const ing of ingredients) {
    if (!ing.id) continue;
    result.push({
      id: ing.id,
      text: ing.text || ing.id.replace(/^en:/, "").replace(/-/g, " "),
      percent_estimate: ing.percent_estimate ?? null,
      vegan: ing.vegan ?? null,
      vegetarian: ing.vegetarian ?? null,
      parent_id: parentId,
      depth,
    });
    if (Array.isArray(ing.ingredients)) {
      result.push(...flattenIngredientTree(ing.ingredients, ing.id, depth + 1));
    }
  }
  return result;
}

async function processIngredients(
  supabase: any,
  barcode: string,
  ingredients: any[],
  additivesTags: string[],
): Promise<void> {
  if (!ingredients || ingredients.length === 0) return;

  const additivesSet = new Set(additivesTags || []);
  const flat = flattenIngredientTree(ingredients);
  if (flat.length === 0) return;

  // 1. Upsert unique ingredients into reference table
  const uniqueIngredients = new Map<string, FlatIngredient>();
  for (const ing of flat) {
    if (!uniqueIngredients.has(ing.id)) {
      uniqueIngredients.set(ing.id, ing);
    }
  }

  const ingredientRows = Array.from(uniqueIngredients.values()).map((ing) => ({
    id: ing.id,
    name: ing.text,
    type: deriveIngredientType(ing.id, additivesSet),
    vegan: ing.vegan,
    vegetarian: ing.vegetarian,
    updated_at: new Date().toISOString(),
  }));

  const { error: ingError } = await supabase
    .from("ingredients")
    .upsert(ingredientRows, { onConflict: "id", ignoreDuplicates: false });

  if (ingError) {
    console.error("[lookup-barcode] ingredients upsert error:", ingError);
    return;
  }

  // 2. Delete old product_ingredients for this barcode (trigger decrements counts)
  const { error: delError } = await supabase
    .from("product_ingredients")
    .delete()
    .eq("barcode", barcode);

  if (delError) {
    console.error("[lookup-barcode] product_ingredients delete error:", delError);
    return;
  }

  // 3. Insert new product_ingredients (trigger increments counts)
  const piRows = flat.map((ing, idx) => ({
    barcode,
    ingredient_id: ing.id,
    position: idx + 1,
    percent_estimate: ing.percent_estimate,
    parent_ingredient_id: ing.parent_id,
    depth: ing.depth,
  }));

  const { error: piError } = await supabase
    .from("product_ingredients")
    .insert(piRows);

  if (piError) {
    console.error("[lookup-barcode] product_ingredients insert error:", piError);
    return;
  }

  // 4. Refresh product_count for affected ingredients via RPC
  const ingredientIds = [...new Set(flat.map((ing) => ing.id))];
  const { error: rpcError } = await supabase.rpc("refresh_ingredient_counts", {
    ingredient_ids: ingredientIds,
  });
  if (rpcError) {
    console.error("[lookup-barcode] refresh_ingredient_counts error:", rpcError);
  }
}

/** Derive vegan/vegetarian status from ingredients_analysis_tags. */
function deriveStatus(tags: string[] | undefined, positive: string, negative: string): string {
  if (!Array.isArray(tags)) return "unknown";
  if (tags.includes(negative)) return negative.replace("en:", "");
  if (tags.includes(positive)) return positive.replace("en:", "");
  return "unknown";
}

/** Fetch structured ingredients for a barcode (joined with ingredient metadata). */
async function fetchStructuredIngredients(supabase: any, barcode: string) {
  // Get product_ingredients for this barcode
  const { data: piRows, error: piError } = await supabase
    .from("product_ingredients")
    .select("ingredient_id, position, percent_estimate, depth, parent_ingredient_id")
    .eq("barcode", barcode)
    .order("position");

  if (piError || !piRows || piRows.length === 0) return [];

  // Get ingredient metadata for all referenced IDs
  const ingredientIds = [...new Set(piRows.map((r: any) => r.ingredient_id))];
  const { data: ingredients } = await supabase
    .from("ingredients")
    .select("id, name, type, risk_tier")
    .in("id", ingredientIds);

  const ingMap = new Map((ingredients || []).map((i: any) => [i.id, i]));

  return piRows.map((row: any) => {
    const ing = ingMap.get(row.ingredient_id);
    return {
      id: row.ingredient_id,
      name: ing?.name ?? row.ingredient_id,
      type: ing?.type ?? "ingredient",
      risk_tier: ing?.risk_tier ?? null,
      percent_estimate: row.percent_estimate,
      position: row.position,
      depth: row.depth,
      parent_id: row.parent_ingredient_id,
    };
  });
}

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
        const structured_ingredients = await fetchStructuredIngredients(supabase, barcode);
        return new Response(
          JSON.stringify({ source: "cache", product: cached, structured_ingredients }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      console.log(`[lookup-barcode] Cache STALE for ${barcode} (age: ${ageDays.toFixed(1)} days) — refreshing`);
    }

    // Fetch from Open Food Facts
    const fields = [
      "code", "product_name", "brands", "ingredients_text", "nutriments", "nova_group",
      "nutriscore_grade", "nutriscore_score", "image_url", "image_small_url",
      "ingredients", "ingredients_n", "additives_tags", "allergens_tags", "traces_tags",
      "ingredients_analysis_tags", "ecoscore_grade", "categories_tags",
    ].join(",");

    const offRes = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`,
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
    const analysisTags: string[] = p.ingredients_analysis_tags || [];
    const ingredients: any[] = p.ingredients || [];

    // Derive boolean / status fields
    const hasPalmOil = analysisTags.includes("en:palm-oil");
    const hasSeedOil = containsSeedOil(ingredients);
    const veganStatus = deriveStatus(analysisTags, "en:vegan", "en:non-vegan");
    const vegetarianStatus = deriveStatus(analysisTags, "en:vegetarian", "en:non-vegetarian");

    // Estimate NOVA if OFF doesn't provide it
    const novaGroup = p.nova_group ?? estimateNova({
      additives_tags: p.additives_tags || null,
      ingredients: ingredients,
      ingredients_n: p.ingredients_n ?? null,
      ingredients_text: p.ingredients_text || null,
    });

    // Resolve additive names from taxonomy
    const additives = await resolveAdditiveNames(p.additives_tags || []);

    // Compute Clean Score (evidence-based longevity scoring)
    const { score: cleanScore, breakdown: cleanScoreBreakdown } = computeCleanScore({
      nova_group: novaGroup,
      additives: p.additives_tags != null ? additives : null,
      additives_raw: p.additives_tags || null,
      sugars_100g: nutriments["sugars_100g"] ?? null,
      saturated_fat_100g: nutriments["saturated-fat_100g"] ?? null,
      salt_100g: nutriments["salt_100g"] ?? null,
      nutriscore_grade: p.nutriscore_grade || null,
      ingredients_text: p.ingredients_text || null,
      categories_tags: p.categories_tags || null,
      alcohol_100g: nutriments["alcohol_100g"] ?? null,
    });

    const product = {
      barcode,
      product_name: p.product_name || null,
      brand: p.brands || null,
      energy_kcal_100g: nutriments["energy-kcal_100g"] ?? null,
      proteins_100g: nutriments["proteins_100g"] ?? null,
      carbohydrates_100g: nutriments["carbohydrates_100g"] ?? null,
      fat_100g: nutriments["fat_100g"] ?? null,
      nova_group: novaGroup,
      ingredients_text: p.ingredients_text || null,
      nutriscore_grade: p.nutriscore_grade || null,
      nutriscore_score: p.nutriscore_score ?? null,
      image_url: p.image_url || null,
      image_small_url: p.image_small_url || null,
      ingredients_count: p.ingredients_n ?? null,
      additives: p.additives_tags != null ? additives : null,
      allergens: p.allergens_tags ?? null,
      traces: p.traces_tags ?? null,
      has_palm_oil: hasPalmOil,
      has_seed_oil: hasSeedOil,
      vegan_status: veganStatus,
      vegetarian_status: vegetarianStatus,
      ecoscore_grade: p.ecoscore_grade || null,
      saturated_fat_100g: nutriments["saturated-fat_100g"] ?? null,
      sugars_100g: nutriments["sugars_100g"] ?? null,
      salt_100g: nutriments["salt_100g"] ?? null,
      fiber_100g: nutriments["fiber_100g"] ?? null,
      clean_score: cleanScore,
      clean_score_breakdown: cleanScoreBreakdown,
      fetched_at: new Date().toISOString(),
    };

    // Upsert into cache
    const { error: upsertError } = await supabase
      .from("products")
      .upsert(product, { onConflict: "barcode" });

    if (upsertError) {
      console.error("Upsert error:", upsertError);
    }

    // Process ingredients into normalized tables
    try {
      await processIngredients(supabase, barcode, ingredients, p.additives_tags || []);
    } catch (err) {
      console.error("[lookup-barcode] ingredient processing error:", err);
    }

    console.log(`[lookup-barcode] API fetch for ${barcode} — "${product.product_name}" by "${product.brand}"`);

    const structured_ingredients = await fetchStructuredIngredients(supabase, barcode);

    return new Response(
      JSON.stringify({ source: "api", product, structured_ingredients }),
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

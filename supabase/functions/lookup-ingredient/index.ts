import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { ingredient_id } = await req.json();

    if (!ingredient_id || typeof ingredient_id !== "string") {
      return new Response(
        JSON.stringify({ error: "ingredient_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Fetch ingredient
    const { data: ingredient, error: ingError } = await supabase
      .from("ingredients")
      .select("*")
      .eq("id", ingredient_id)
      .single();

    if (ingError || !ingredient) {
      return new Response(
        JSON.stringify({ error: "Ingredient not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch products containing this ingredient
    const { data: links } = await supabase
      .from("product_ingredients")
      .select("barcode")
      .eq("ingredient_id", ingredient_id);

    const barcodes = [...new Set((links || []).map((l: any) => l.barcode))];

    let products: any[] = [];
    if (barcodes.length > 0) {
      const { data: prods } = await supabase
        .from("products")
        .select("barcode, product_name, brand, clean_score, image_small_url")
        .in("barcode", barcodes)
        .order("product_name");

      products = prods || [];
    }

    return new Response(
      JSON.stringify({ ingredient, products }),
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

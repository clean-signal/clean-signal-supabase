import requests
from bs4 import BeautifulSoup
import json
import re
import time
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}

BASE_URL = "https://groceries.morrisons.com/products"


def parse_morrisons_product(html, url=""):
    soup = BeautifulSoup(html, "html.parser")
    product = {}

    # Source info
    product["source"] = "morrisons"
    product["source_url"] = url
    product["source_id"] = url.rstrip("/").split("/")[-1] if url else None

    # Name
    h1 = soup.find("h1")
    product["name"] = h1.get_text(strip=True) if h1 else None

    # Helper: find section content by heading text
    def get_section(heading_text):
        for tag in soup.find_all(["h2", "h3"]):
            if heading_text.lower() in tag.get_text(strip=True).lower():
                nxt = tag.find_next_sibling()
                if nxt:
                    return nxt.get_text(strip=True)
        return None

    product["brand"] = get_section("Brand")
    product["country_of_origin"] = get_section("Country Of Origin")
    product["allergens_raw"] = get_section("Dietary Information")

    # Ingredients — match heading that STARTS with "Ingredients"
    for tag in soup.find_all(["h2", "h3"]):
        if tag.get_text(strip=True).lower().startswith("ingredients"):
            nxt = tag.find_next_sibling()
            product["ingredients_raw"] = nxt.get_text(strip=True) if nxt else None
            break

    # Parse ingredients into list, keeping bracketed content together
    if product.get("ingredients_raw"):
        parts = [i.strip() for i in re.split(r",\s*(?![^()]*\))", product["ingredients_raw"])]
        product["ingredients_list"] = [p for p in parts if p]

    # Parse allergens into clean list
    if product.get("allergens_raw"):
        product["allergens"] = [
            a.replace("Contains ", "").strip()
            for a in product["allergens_raw"].split(",")
            if a.strip()
        ]

    # Nutrition table — per 100g values
    nutrition = {}
    table = soup.find("table")
    if table:
        for row in table.find_all("tr")[1:]:  # skip header row
            cells = row.find_all(["td", "th"])
            if len(cells) >= 2:
                label = cells[0].get_text(strip=True)
                value = cells[1].get_text(strip=True)
                num = re.search(r"[\d.]+", value)
                key = (label.lower()
                       .replace(" (g)", "_g")
                       .replace(" (kj)", "_kj")
                       .replace(" (kcal)", "_kcal")
                       .replace("of which ", "")
                       .replace(" ", "_"))
                nutrition[key] = float(num.group()) if num else value
    product["nutrition_per_100g"] = nutrition

    return product


def scrape_product(url, delay=1.5):
    """Fetch and parse a single product page."""
    logging.info(f"Scraping: {url}")
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        response.raise_for_status()
        time.sleep(delay)  # be polite
        return parse_morrisons_product(response.text, url)
    except requests.HTTPError as e:
        logging.error(f"HTTP error {e.response.status_code} for {url}")
        return None
    except Exception as e:
        logging.error(f"Failed to scrape {url}: {e}")
        return None


def scrape_product_list(product_ids, delay=1.5, output_file="products.jsonl"):
    """
    Scrape a list of Morrisons product IDs.

    Product URL format:
      https://groceries.morrisons.com/products/{slug}/{id}

    If you only have the numeric ID (not the slug), Morrisons redirects
    automatically so you can use a placeholder slug.

    Args:
        product_ids: list of (slug, id) tuples or just id strings
        delay: seconds between requests
        output_file: write results as newline-delimited JSON
    """
    results = []
    with open(output_file, "w") as f:
        for item in product_ids:
            if isinstance(item, tuple):
                slug, pid = item
                url = f"{BASE_URL}/{slug}/{pid}"
            else:
                # Just an ID — use placeholder slug, Morrisons will redirect
                url = f"{BASE_URL}/product/{item}"

            product = scrape_product(url, delay=delay)
            if product:
                results.append(product)
                f.write(json.dumps(product) + "\n")
                logging.info(f"  -> {product.get('name')} ✓")

    logging.info(f"Done. Scraped {len(results)} products -> {output_file}")
    return results


# ── Example usage ────────────────────────────────────────────────────────────

if __name__ == "__main__":

    # Single product
    url = "https://groceries.morrisons.com/products/hellmann-s-light-mayonnaise-580ml/300001790"
    product = scrape_product(url)
    print(json.dumps(product, indent=2))

    # --- Batch scrape example ---
    # product_ids = [
    #     ("hellmann-s-light-mayonnaise-580ml", "300001790"),
    #     ("heinz-baked-beanz-415g", "132891011"),
    #     ("kelloggs-cornflakes-500g", "251234567"),
    # ]
    # scrape_product_list(product_ids, delay=1.5, output_file="products.jsonl")

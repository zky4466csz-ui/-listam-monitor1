import { chromium } from "playwright";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MASTER_URL = process.env.LISTAM_MASTER_URL;
console.log("TEST URL:", MASTER_URL);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const WATCH_ID = "listam_master";

const MAX_PAGES = Number(process.env.MAX_PAGES || 30);

if (!MASTER_URL) throw new Error("LISTAM_MASTER_URL is missing");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is missing");
if (!SUPABASE_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

function cleanText(value) {
  return (value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprint(listing) {
  const raw = [
    listing.title,
    listing.address,
    listing.area,
    listing.rooms
  ]
    .map(cleanText)
    .join("|")
    .toLowerCase();

  return crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex");
}

function extractListingId(url) {
  const match = url.match(/\/item\/(\d+)/);
  return match ? match[1] : null;
}

function absoluteUrl(href) {
  try {
    return new URL(href, "https://www.list.am").href;
  } catch {
    return null;
  }
}

async function extractListings(page) {
  return await page.locator('a[href*="/item/"]').evaluateAll((links) => {
    const result = [];

    for (const link of links) {
      const href = link.getAttribute("href");

      if (!href || !href.includes("/item/")) continue;

      const match = href.match(/\/item\/(\d+)/);
      if (!match) continue;

      const listingId = match[1];

      const text = (link.innerText || "")
        .replace(/\s+/g, " ")
        .trim();

      result.push({
        listingId,
        href,
        text
      });
    }

    const unique = new Map();

    for (const item of result) {
      if (!unique.has(item.listingId)) {
        unique.set(item.listingId, item);
      }
    }

    return [...unique.values()];
  });
}

function parseCardText(item) {
  const text = item.text || "";

  const priceMatch = text.match(/\$[\d,]+/);

  const areaMatch = text.match(/(\d+(?:\.\d+)?)\s*քմ/);

  const roomsMatch = text.match(/(\d+)\s*սեն/);

  return {
    title: text.slice(0, 500),
    price: priceMatch
      ? Number(priceMatch[0].replace(/[$,]/g, ""))
      : null,
    area: areaMatch
      ? Number(areaMatch[1])
      : null,
    rooms: roomsMatch
      ? Number(roomsMatch[1])
      : null
  };
}

async function getListingDetails(browser, listing) {
  const page = await browser.newPage();

  try {
    await page.goto(listing.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(1000);

    const bodyText = await page.locator("body").innerText();

    const title = cleanText(
      await page.locator("h1").first().innerText().catch(() => "")
    );

    const priceText = cleanText(
      await page.locator("body").innerText().catch(() => "")
    );

    const priceMatch = priceText.match(/\$[\d,]+/);

    const areaMatch = bodyText.match(
      /(\d+(?:\.\d+)?)\s*քմ/
    );

    const roomsMatch = bodyText.match(
      /(\d+)\s*Սենյակների քանակ/
    );

    const floorMatch = bodyText.match(
      /(\d+)\s*Հարկ/
    );

    const addressMatch = bodyText.match(
      /(?:փողոց|պողոտա|նրբանցք)[^\n]{0,100}/
    );

    const createdMatch = bodyText.match(
      /Տեղադրված է\s+([^\n]+?)(?:\s+Թարմացվել է|$)/
    );

    const updatedMatch = bodyText.match(
      /Թարմացվել է\s+([^\n]+)/
    );

    return {
      ...listing,

      title:
        title ||
        listing.title ||
        `List.am #${listing.listingId}`,

      price: priceMatch
        ? Number(priceMatch[0].replace(/[$,]/g, ""))
        : listing.price,

      area: areaMatch
        ? Number(areaMatch[1])
        : listing.area,

      rooms: roomsMatch
        ? Number(roomsMatch[1])
        : listing.rooms,

      floor: floorMatch
        ? floorMatch[1]
        : null,

      address: addressMatch
        ? cleanText(addressMatch[0])
        : null,

      createdRaw: createdMatch
        ? cleanText(createdMatch[1])
        : null,

      updatedRaw: updatedMatch
        ? cleanText(updatedMatch[1])
        : null
    };
  } finally {
    await page.close();
  }
}

async function ensureWatch() {
  const { error } = await supabase
    .from("watches")
    .upsert(
      {
        watch_id: WATCH_ID,
        master_url: MASTER_URL,
        status: "ACTIVE"
      },
      {
        onConflict: "watch_id"
      }
    );

  if (error) throw error;
}

async function getPreviousListings() {
  const { data, error } = await supabase
    .from("snapshot_listings")
    .select(
      "listing_id, listing_fingerprint, title, url"
    )
    .limit(10000);

  if (error) throw error;

  return data || [];
}

async function createSnapshot(total) {
  const snapshotId =
    `${WATCH_ID}_${Date.now()}`;

  const { data, error } = await supabase
    .from("snapshots")
    .insert({
      watch_id: WATCH_ID,
      snapshot_id: snapshotId,
      check_time: new Date().toISOString(),
      total_listings: total,
      status: "SUCCESS"
    })
    .select()
    .single();

  if (error) throw error;

  return data;
}

async function saveListings(snapshotId, listings) {
  if (!listings.length) return;

  const rows = listings.map((item) => ({
    snapshot_id: snapshotId,
    listing_id: item.listingId,
    url: item.url,
    title: item.title || null,
    price: item.price ?? null,
    area: item.area ?? null,
    rooms: item.rooms ?? null,
    floor: item.floor ?? null,
    address: item.address ?? null,
    seller: item.seller ?? null,
    created_date: null,
    updated_date: null,
    listing_fingerprint: fingerprint(item)
  }));

  const { error } = await supabase
    .from("snapshot_listings")
    .insert(rows);

  if (error) throw error;
}

async function markCheck(total, newCount, status, errorText = null) {
  await supabase
    .from("check_history")
    .insert({
      watch_id: WATCH_ID,
      check_time: new Date().toISOString(),
      status,
      total_listings: total,
      new_count: newCount,
      error: errorText,
      recovery_info: null
    });
}

async function updateWatchSuccess() {
  await supabase
    .from("watches")
    .update({
      last_successful_check: new Date().toISOString(),
      status: "ACTIVE"
    })
    .eq("watch_id", WATCH_ID);
}

async function main() {
  console.log("=================================");
  console.log("LIST.AM MONITOR START");
  console.log("=================================");

  console.log("MASTER URL:");
  console.log(MASTER_URL);

  await ensureWatch();

  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage({
    viewport: {
      width: 1440,
      height: 1200
    }
  });

  const allListings = new Map();

  try {
    let currentUrl = MASTER_URL;

    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      console.log(`Scanning page ${pageNumber}`);

      await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      await page.waitForTimeout(15000);

for (let i = 0; i < 10; i++) {
  const title = await page.title();

  if (!title.toLowerCase().includes("just a moment")) {
    break;
  }

  console.log(`Cloudflare challenge detected — waiting... ${i + 1}/10`);
  await page.waitForTimeout(3000);
}

      const title = await page.title();

      console.log("PAGE TITLE:", title);

      if (
        title.toLowerCase().includes("error") ||
        title.toLowerCase().includes("captcha")
      ) {
        throw new Error(
          `List.am returned suspicious page: ${title}`
        );
      }

      const cards = await extractListings(page);

      console.log(
        `Found ${cards.length} listing links`
      );

      for (const card of cards) {
        const url = absoluteUrl(card.href);

        if (!url) continue;

        const parsed = parseCardText(card);

        allListings.set(card.listingId, {
          listingId: card.listingId,
          url,
          ...parsed
        });
      }

      /*
       * Try to discover the next pagination URL.
       * We intentionally do NOT modify the MASTER URL.
       */
      const nextUrl = await page.locator("a").evaluateAll(
        (links) => {
          for (const link of links) {
            const text = (link.innerText || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();

            const aria =
              (link.getAttribute("aria-label") || "")
                .toLowerCase();

            if (
              text === "next" ||
              text === "հաջորդ" ||
              text.includes("հաջորդ") ||
              aria.includes("next")
            ) {
              return link.href || null;
            }
          }

          return null;
        }
      );

      if (!nextUrl || nextUrl === currentUrl) {
        break;
      }

      currentUrl = nextUrl;
    }

    const listings = [...allListings.values()];

    if (listings.length === 0) {
      throw new Error(
        "ZERO LISTINGS — treating this as CHECK FAILED, not as 0 NEW."
      );
    }

    console.log(
      `TOTAL UNIQUE LISTINGS: ${listings.length}`
    );

    const previous = await getPreviousListings();

    const previousIds = new Set(
      previous.map((x) => x.listing_id)
    );

    const previousFingerprints = new Set(
      previous
        .map((x) => x.listing_fingerprint)
        .filter(Boolean)
    );

    const snapshot = await createSnapshot(
      listings.length
    );

    /*
     * Fetch details only for potentially new listings.
     * This saves a lot of browser time.
     */
    const candidates = listings.filter(
      (x) =>
        !previousIds.has(x.listingId)
    );

    console.log(
      `Potential NEW listings: ${candidates.length}`
    );

    const detailedCandidates = [];

    for (const candidate of candidates) {
      try {
        const details =
          await getListingDetails(
            browser,
            candidate
          );

        detailedCandidates.push(details);

        console.log(
          `DETAIL OK: ${candidate.listingId}`
        );
      } catch (error) {
        console.log(
          `DETAIL FAILED: ${candidate.listingId}`,
          error.message
        );

        detailedCandidates.push(candidate);
      }
    }

    const candidateMap = new Map(
      detailedCandidates.map((x) => [
        x.listingId,
        x
      ])
    );

    const enrichedListings = listings.map(
      (listing) =>
        candidateMap.get(listing.listingId) ||
        listing
    );

    await saveListings(
      snapshot.snapshot_id,
      enrichedListings
    );

    const trulyNew = enrichedListings.filter(
      (listing) => {
        if (previousIds.has(listing.listingId)) {
          return false;
        }

        const fp = fingerprint(listing);

        if (previousFingerprints.has(fp)) {
          console.log(
            `REPOST/DUPLICATE ignored: ${listing.listingId}`
          );

          return false;
        }

        return true;
      }
    );

    /*
     * Save NEW listings as sent.
     * This prevents the same listing from being reported
     * repeatedly in later runs.
     */
    for (const listing of trulyNew) {
      const { error } = await supabase
        .from("sent_listings")
        .upsert(
          {
            watch_id: WATCH_ID,
            listing_id: listing.listingId,
            sent_at: new Date().toISOString()
          },
          {
            onConflict:
              "watch_id,listing_id"
          }
        );

      if (error) {
        console.log(
          "sent_listings error:",
          error.message
        );
      }
    }

    await updateWatchSuccess();

    await markCheck(
      listings.length,
      trulyNew.length,
      "SUCCESS",
      null
    );

    console.log("");
    console.log("=================================");
    console.log("CHECK SUCCESS");
    console.log(`TOTAL: ${listings.length}`);
    console.log(`NEW: ${trulyNew.length}`);
    console.log("=================================");

    if (trulyNew.length > 0) {
      console.log("");
      console.log("NEW LISTINGS:");

      for (const listing of trulyNew) {
        console.log(
          JSON.stringify(
            {
              id: listing.listingId,
              title: listing.title,
              price: listing.price,
              area: listing.area,
              rooms: listing.rooms,
              url: listing.url
            },
            null,
            2
          )
        );
      }
    } else {
      console.log("NO NEW LISTINGS");
    }
  } catch (error) {
    console.error(
      "MONITOR FAILED:",
      error
    );

    await markCheck(
      0,
      0,
      "CHECK_FAILED",
      error.message
    );

    await supabase
      .from("watches")
      .update({
        status: "CHECK_FAILED"
      })
      .eq("watch_id", WATCH_ID);

    process.exitCode = 1;
  } finally {
    await page.close();
    await browser.close();
  }
}

main();

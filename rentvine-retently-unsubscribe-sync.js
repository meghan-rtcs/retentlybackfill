/**
 * One-time backfill script
 * Pulls all INACTIVE owners and tenants from Rentvine, and unsubscribes
 * their emails from Retently.
 *
 * Requires Node 18+ (built-in fetch). Designed to run in Replit.
 *
 * SET THESE AS REPLIT SECRETS (not hardcoded, not in a committed .env):
 *   RENTVINE_SUBDOMAIN     e.g. "coloradorpm"
 *   RENTVINE_API_KEY
 *   RENTVINE_API_SECRET
 *   RETENTLY_API_KEY
 *
 * Run with: node rentvine-retently-unsubscribe-sync.js
 */

const RENTVINE_SUBDOMAIN = process.env.RENTVINE_SUBDOMAIN;
const RENTVINE_API_KEY = process.env.RENTVINE_API_KEY;
const RENTVINE_API_SECRET = process.env.RENTVINE_API_SECRET;
const RETENTLY_API_KEY = process.env.RETENTLY_API_KEY;

if (!RENTVINE_SUBDOMAIN || !RENTVINE_API_KEY || !RENTVINE_API_SECRET || !RETENTLY_API_KEY) {
  console.error("Missing one or more required environment variables. Check Replit Secrets.");
  process.exit(1);
}

const RENTVINE_BASE = `https://${RENTVINE_SUBDOMAIN}.rentvine.com/api/manager`;
const RENTVINE_AUTH = "Basic " + Buffer.from(`${RENTVINE_API_KEY}:${RENTVINE_API_SECRET}`).toString("base64");

const RETENTLY_BASE = "https://app.retently.com/api/v2";

const PAGE_SIZE = 100;
const RETENTLY_BATCH_SIZE = 100; // keep requests small and easy to diagnose
const DELAY_MS = 500; // stay well under Retently's 150 req/min limit

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull every inactive contact (owner or tenant) from Rentvine, paginating
 * through all pages, and return an array of { contactID, name, email }.
 */
async function fetchAllInactive(kind) {
  // kind is "owners" or "tenants"
  const results = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${RENTVINE_BASE}/${kind}/search?isActive=false&pageSize=${PAGE_SIZE}&page=${page}&orderBy=contact.name`;
    const res = await fetch(url, {
      headers: {
        Authorization: RENTVINE_AUTH,
      },
    });

    if (!res.ok) {
      throw new Error(`Rentvine ${kind} search failed on page ${page}: ${res.status} ${await res.text()}`);
    }

    const body = await res.json();
    totalPages = Number(res.headers.get("pagination-total-pages")) || 1;

    for (const item of body) {
      const c = item.contact;
      if (c && c.email) {
        results.push({ contactID: c.contactID, name: c.name, email: c.email });
      }
    }

    console.log(`[${kind}] page ${page}/${totalPages} — ${body.length} records (running total with email: ${results.length})`);
    page++;
  } while (page <= totalPages);

  return results;
}

/**
 * Send a batch of emails to Retently's unsubscribe endpoint.
 */
async function unsubscribeBatch(emails) {
  const res = await fetch(`${RETENTLY_BASE}/customers/unsubscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": RETENTLY_API_KEY,
    },
    body: JSON.stringify({
      subscribers: emails.map((email) => ({ email })),
    }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  return { ok: res.ok, status: res.status, body: json };
}

async function main() {
  console.log("=== Fetching inactive owners ===");
  const owners = await fetchAllInactive("owners");

  console.log("\n=== Fetching inactive tenants ===");
  const tenants = await fetchAllInactive("tenants");

  // Combine and dedupe by email (in case someone shows up as both an owner
  // and a tenant, or Rentvine returns the same contact twice).
  const allContacts = [...owners, ...tenants];
  const emailSet = new Set();
  const uniqueEmails = [];
  for (const c of allContacts) {
    const email = c.email.trim().toLowerCase();
    if (!emailSet.has(email)) {
      emailSet.add(email);
      uniqueEmails.push(c.email.trim());
    }
  }

  console.log(`\nTotal inactive contacts with an email: ${allContacts.length}`);
  console.log(`Unique emails to unsubscribe: ${uniqueEmails.length}\n`);

  console.log("=== Unsubscribing from Retently in batches ===");
  const failedBatches = [];
  let successCount = 0;

  for (let i = 0; i < uniqueEmails.length; i += RETENTLY_BATCH_SIZE) {
    const batch = uniqueEmails.slice(i, i + RETENTLY_BATCH_SIZE);
    const batchNum = Math.floor(i / RETENTLY_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(uniqueEmails.length / RETENTLY_BATCH_SIZE);

    try {
      const result = await unsubscribeBatch(batch);
      if (result.ok) {
        successCount += batch.length;
        console.log(`Batch ${batchNum}/${totalBatches}: OK (${batch.length} emails)`);
      } else {
        console.warn(`Batch ${batchNum}/${totalBatches}: FAILED (status ${result.status})`);
        console.warn(JSON.stringify(result.body));
        failedBatches.push({ batchNum, emails: batch, response: result.body });
      }
    } catch (err) {
      console.warn(`Batch ${batchNum}/${totalBatches}: ERROR — ${err.message}`);
      failedBatches.push({ batchNum, emails: batch, error: err.message });
    }

    await sleep(DELAY_MS);
  }

  console.log("\n=== Done ===");
  console.log(`Successfully sent for unsubscribe: ${successCount} / ${uniqueEmails.length}`);

  if (failedBatches.length > 0) {
    console.log(`\n${failedBatches.length} batch(es) had issues. Details:`);
    console.log(JSON.stringify(failedBatches, null, 2));
    console.log(
      "\nNote: Retently returning an error for a whole batch may just mean one or more emails" +
      " in that batch were never enrolled as customers to begin with (expected for very old" +
      " terminations). Check the response body above — if it names specific emails, those are" +
      " the ones to investigate; the rest of the batch may still have processed."
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

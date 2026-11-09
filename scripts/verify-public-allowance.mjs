import pg from "pg";

const databaseUrl = process.env.PUBLIC_ALLOWANCE_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Set PUBLIC_ALLOWANCE_TEST_DATABASE_URL to an isolated migrated test database.");
}
if (process.env.PUBLIC_ALLOWANCE_TEST_CONFIRM !== "clear-test-buckets") {
  throw new Error("Set PUBLIC_ALLOWANCE_TEST_CONFIRM=clear-test-buckets to confirm the isolated allowance buckets may be cleared.");
}

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 20 });
const visitor = "a".repeat(64);

async function clearBuckets() {
  await pool.query("truncate table public.public_allowance_buckets");
}

async function admit(visitorId) {
  const result = await pool.query(
    "select public.admit_public_action($1) as admission",
    [visitorId]
  );
  return result.rows[0].admission;
}

try {
  await clearBuckets();
  const sameVisitor = await Promise.all(Array.from({ length: 12 }, () => admit(visitor)));
  const sameVisitorAdmitted = sameVisitor.filter((result) => result.admitted).length;
  if (sameVisitorAdmitted !== 3) {
    throw new Error(`Expected exactly 3 concurrent same-Visitor admissions, received ${sameVisitorAdmitted}.`);
  }
  if (!sameVisitor.filter((result) => !result.admitted).every((result) => result.limited_by === "visitor_minute")) {
    throw new Error("Same-Visitor concurrency did not consistently enforce the Visitor minute bucket.");
  }

  await clearBuckets();
  const visitors = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(64, "0"));
  const globalBurst = await Promise.all(visitors.map(admit));
  const globalAdmitted = globalBurst.filter((result) => result.admitted).length;
  if (globalAdmitted !== 15) {
    throw new Error(`Expected exactly 15 concurrent global admissions, received ${globalAdmitted}.`);
  }
  if (!globalBurst.filter((result) => !result.admitted).every((result) => result.limited_by === "global_minute")) {
    throw new Error("Global concurrency did not consistently enforce the global minute bucket.");
  }

  await clearBuckets();
  await pool.query(`
    insert into public.public_allowance_buckets (
      bucket_type, bucket_key, window_start, action_count, expires_at
    ) values (
      'visitor_day',
      $1,
      date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles',
      9,
      (date_trunc('day', now() at time zone 'America/Los_Angeles') + interval '1 day') at time zone 'America/Los_Angeles'
    )
  `, [visitor]);
  const visitorDailyRace = await Promise.all([admit(visitor), admit(visitor)]);
  const visitorDayAdmitted = visitorDailyRace.filter((result) => result.admitted).length;
  const dailyLimit = visitorDailyRace.find((result) => !result.admitted);
  const expectedReset = await pool.query(`
    select (date_trunc('day', now() at time zone 'America/Los_Angeles') + interval '1 day')
      at time zone 'America/Los_Angeles' as reset_at
  `);
  if (visitorDayAdmitted !== 1 || dailyLimit?.limited_by !== "visitor_day") {
    throw new Error("Concurrent requests oversubscribed the Visitor Pacific-day limit.");
  }
  if (new Date(dailyLimit.reset_at).getTime() !== new Date(expectedReset.rows[0].reset_at).getTime()) {
    throw new Error("The daily reset did not resolve to the next Pacific midnight.");
  }

  await clearBuckets();
  await pool.query(`
    insert into public.public_allowance_buckets (
      bucket_type, bucket_key, window_start, action_count, expires_at
    ) values (
      'global_day',
      'global',
      date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles',
      49,
      (date_trunc('day', now() at time zone 'America/Los_Angeles') + interval '1 day') at time zone 'America/Los_Angeles'
    )
  `);
  const globalDailyRace = await Promise.all([admit("b".repeat(64)), admit("c".repeat(64))]);
  if (globalDailyRace.filter((result) => result.admitted).length !== 1
    || globalDailyRace.find((result) => !result.admitted)?.limited_by !== "global_day") {
    throw new Error("Concurrent requests oversubscribed the global Pacific-day limit.");
  }

  console.log("Verified atomic concurrency for all four public allowance buckets and Pacific-day reset behavior.");
} finally {
  await clearBuckets().catch(() => undefined);
  await pool.end();
}

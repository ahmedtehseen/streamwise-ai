import "server-only";

import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

type AdmissionResult = {
  admitted: boolean;
  limited_by: "visitor_minute" | "global_minute" | "visitor_day" | "global_day" | null;
  reset_at: string | null;
};

const PACIFIC_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function unavailable(error: string, code: "visitor_identity_unavailable" | "allowance_unavailable") {
  return Response.json({ error, code, retryable: true }, { status: 503 });
}

function trustedClientAddress(request: Request) {
  const value = request.headers.get("x-vercel-forwarded-for")?.trim();
  if (!value || value.length > 200 || value.includes(",")) return null;
  return value;
}

function dailyVisitorId(address: string, secret: string, now = new Date()) {
  const date = PACIFIC_DATE.formatToParts(now).reduce<Record<string, string>>((parts, part) => {
    if (part.type !== "literal") parts[part.type] = part.value;
    return parts;
  }, {});
  const pacificDay = `${date.year}-${date.month}-${date.day}`;
  return createHmac("sha256", secret).update(`${pacificDay}\0${address}`).digest("hex");
}

function limitDescription(limit: AdmissionResult["limited_by"]) {
  return limit?.endsWith("_day")
    ? "The shared daily allowance has been used up."
    : "The shared minute allowance has been used up.";
}

function formatPacificReset(resetAt: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(resetAt));
}

export async function admitPublicAction(request: Request): Promise<Response | null> {
  const address = trustedClientAddress(request);
  if (!address) {
    return unavailable(
      "Streamwise could not verify the Visitor network identity required for public access. Please try again.",
      "visitor_identity_unavailable"
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const visitorIdSecret = process.env.VISITOR_ID_SECRET;
  if (!supabaseUrl || !serviceRoleKey || !visitorIdSecret || visitorIdSecret.length < 32) {
    return unavailable("Public usage allowance is temporarily unavailable. Please try again later.", "allowance_unavailable");
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const { data, error } = await client.rpc("admit_public_action", {
    p_visitor_id: dailyVisitorId(address, visitorIdSecret)
  });
  if (error || !data || typeof data !== "object" || !("admitted" in data)) {
    return unavailable("Public usage allowance is temporarily unavailable. Please try again later.", "allowance_unavailable");
  }

  const admission = data as AdmissionResult;
  if (admission.admitted) return null;
  if (!admission.limited_by || !admission.reset_at) {
    return unavailable("Public usage allowance is temporarily unavailable. Please try again later.", "allowance_unavailable");
  }

  return Response.json({
    error: `${limitDescription(admission.limited_by)} Try again after ${formatPacificReset(admission.reset_at)}.`,
    code: "public_allowance_limited",
    retryable: true,
    limitedBy: admission.limited_by,
    resetAt: admission.reset_at
  }, {
    status: 429,
    headers: { "Retry-After": new Date(admission.reset_at).toUTCString() }
  });
}

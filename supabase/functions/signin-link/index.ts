// Stopgap until pgsheritage.com is verified in Resend: an admin generates a personal
// sign-in link for an invited user and sends it to them directly (WhatsApp, Teams, etc.).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who, error: whoErr } = await admin.auth.getUser(token);
    if (whoErr || !who?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("app_user").select("role,active").eq("id", who.user.id).maybeSingle();
    if (!me || !me.active || me.role !== "admin") return json({ error: "Only admins can create sign-in links" }, 403);

    const { email, redirectTo } = await req.json();
    const e = String(email || "").trim().toLowerCase();
    const { data: inv } = await admin.from("staff_invite").select("email").eq("email", e).maybeSingle();
    if (!inv) return json({ error: "That email has not been invited yet" }, 400);

    let r = await admin.auth.admin.generateLink({ type: "magiclink", email: e, options: { redirectTo } });
    if (r.error) r = await admin.auth.admin.generateLink({ type: "invite", email: e, options: { redirectTo } });
    if (r.error) return json({ error: r.error.message }, 400);
    return json({ link: r.data.properties.action_link });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

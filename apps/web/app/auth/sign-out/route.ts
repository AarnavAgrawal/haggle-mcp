import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/** POST only (a link prefetch must never sign anyone out). */
export async function POST(request: NextRequest) {
  await (await supabaseServer()).auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}

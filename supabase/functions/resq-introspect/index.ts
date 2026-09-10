// NEUTRALIZED 2026-06-27. This was a temporary probe used to verify ResQ/SF
// API shapes during the apbg-resq-sync build. It made live calls to Service
// Fusion and ResQ. It is now an inert stub that makes NO external calls, so it
// can no longer add load to those APIs. Safe to delete from the dashboard.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() =>
  new Response(
    JSON.stringify({
      status: "retired",
      message:
        "resq-introspect was a one-time API-shape probe and has been neutralized. It makes no external calls. Safe to delete.",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);

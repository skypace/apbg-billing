// RETIRED — do not build on this. Kept only as a signpost, because a deployed
// function that quietly does work is worse than one that says it is gone.
//
// Geocoding moved INTO the database on 2026-09-07, before this ever ran once.
// Two reasons, and the second is the one that matters:
//
//   1. It needed a credential to invoke. `verify_jwt: true` on this project is
//      not a gate at all — the anon key is public and shipped in every bundle,
//      so anyone holding it could have triggered geocoding here.
//   2. It could not be VERIFIED BY RUNNING IT, which is this repo's whole
//      discipline. Shipping it would have meant shipping unproven code.
//
// The live implementation is SQL, uses pg_net, needs no secret, and is scheduled
// natively:
//
//   dispatch.fn_geocode_run(max)      -- collect, then ask for the next batch
//   dispatch.fn_geocode_enqueue(max)  -- phase 1, fires the Census requests
//   dispatch.fn_geocode_collect()     -- phase 2, lands them in the cache
//   dispatch.geocode_cache            -- one row per distinct service address
//   pg_cron 'dispatch-geocode'        -- hourly at :35
//   ops.fn_dispatch_geocode_health()  -- the watcher, on ops.sync_health()
//
// See apbg-dispatch migrations 20260907d/e/f and that repo's CLAUDE.md.

Deno.serve(() =>
  new Response(JSON.stringify({
    ok: false,
    gone: true,
    error: 'dispatch-geocode is retired. Geocoding runs in the database: select dispatch.fn_geocode_run(60); scheduled hourly by pg_cron as dispatch-geocode.'
  }), { status: 410, headers: { 'Content-Type': 'application/json' } })
);

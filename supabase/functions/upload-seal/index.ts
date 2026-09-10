import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUCKET = 'brix-catalog-images';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('not allowed', { status: 405 });
  }
  let body: { path?: string; base64?: string; contentType?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const { path, base64, contentType } = body;
  if (!path || !base64) {
    return new Response(JSON.stringify({ error: 'missing path or base64' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Decode base64 to Uint8Array.
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const { error } = await supa.storage.from(BUCKET).upload(path, bytes, {
    contentType: contentType ?? 'image/jpeg',
    upsert: true,
    cacheControl: '2592000',
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const publicUrl = `${Deno.env.get('SUPABASE_URL')!.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${path}`;
  return new Response(JSON.stringify({ ok: true, path, url: publicUrl }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

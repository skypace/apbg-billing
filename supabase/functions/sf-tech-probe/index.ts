import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const SF_API = "https://api.servicefusion.com/v1";
const SF_TOKEN_URL = "https://api.servicefusion.com/oauth/access_token";
function getSB() { return createClient(Deno.env.get("SUPABASE_URL")||"", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"", { db: { schema: "ops" } }); }
let accessToken=""; let tokenExpires=0;
async function getSFToken(sb:any):Promise<string> {
  if (accessToken&&tokenExpires>Date.now()) return accessToken;
  const {data:c}=await sb.from("sf_token_cache").select("*").eq("id",1).single();
  if (c?.access_token&&new Date(c.access_expires_at).getTime()>Date.now()){accessToken=c.access_token;tokenExpires=new Date(c.access_expires_at).getTime();return accessToken;}
  const rt=c?.refresh_token||Deno.env.get("SF_REFRESH_TOKEN")||"";
  const res=await fetch(SF_TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=refresh_token&client_id="+(Deno.env.get("SF_CLIENT_ID")||"")+"&client_secret="+(Deno.env.get("SF_CLIENT_SECRET")||"")+"&refresh_token="+rt});
  const data=await res.json();accessToken=data.access_token;tokenExpires=Date.now()+50*60*1000;
  const u:any={id:1,access_token:data.access_token,access_expires_at:new Date(tokenExpires).toISOString(),updated_at:new Date().toISOString()};
  if(data.refresh_token)u.refresh_token=data.refresh_token;
  await sb.from("sf_token_cache").upsert(u);return accessToken;
}
async function sfGet(sb:any,ep:string):Promise<any> {
  const t=await getSFToken(sb);const r=await fetch(SF_API+ep,{headers:{Authorization:"Bearer "+t,Accept:"application/json"}});
  if(!r.ok)throw new Error("SF "+r.status+" "+(await r.text()).substring(0,300));
  return r.json();
}
Deno.serve(async(req:Request)=>{
  const sb=getSB();
  const results:Record<string,any>={};
  try{
    await getSFToken(sb);
    // Get job 1087912045 with ALL expandable fields
    const j=await sfGet(sb,"/jobs/1087912045");
    results.base_keys = Object.keys(j).sort();
    results.base_job = j;
    // Now with all expands
    const j2=await sfGet(sb,"/jobs/1087912045?expand=agents,custom_fields,invoices,notes,products,services,other_charges,labor_charges,expenses,payments,signatures,printable_work_order,visits,visits.techs_assigned");
    results.expanded_keys = Object.keys(j2).sort();
    // Look for any URL, link, hash, or encoded ID fields
    results.url_candidates = {};
    for (const [k,v] of Object.entries(j2)) {
      if (typeof v === 'string' && (v.includes('http') || v.includes('servicefusion'))) {
        results.url_candidates[k] = v;
      }
    }
    // Check printable_work_order - might have a URL
    if (j2.printable_work_order) results.printable_work_order = j2.printable_work_order;
    // Check agents
    if (j2.agents) results.agents = j2.agents;
    // Check signatures
    if (j2.signatures) results.signatures = j2.signatures;
    // Check invoices for URLs
    if (j2.invoices?.length > 0) {
      results.invoice_urls = j2.invoices.map((inv:any) => ({
        id: inv.id, number: inv.number, pay_online_url: inv.pay_online_url, qbo_id: inv.qbo_id
      }));
    }
  }catch(e:any){results.error=e.message;}
  return new Response(JSON.stringify(results,null,2),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
});

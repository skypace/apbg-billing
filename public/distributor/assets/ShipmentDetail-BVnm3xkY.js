import{c as C,f as ee,a as te,u as se,b as ie,d as ae,r as u,j as e,S as re,E as ne,g as le,h as de,i as ce,A as oe,L as me,s as y}from"./index-w63b9ff3.js";import{e as a,a as q,f,t as Q}from"./format-CeJzaYwU.js";import{TRANSFER_COLS as pe}from"./Shipments-CieGDD7R.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const H=C("ArrowLeft",[["path",{d:"m12 19-7-7 7-7",key:"1l729n"}],["path",{d:"M19 12H5",key:"x3x0zl"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const V=C("CircleCheck",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"m9 12 2 2 4-4",key:"dzmm74"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const he=C("Printer",[["path",{d:"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2",key:"143wyd"}],["path",{d:"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6",key:"1itne7"}],["rect",{x:"6",y:"14",width:"12",height:"8",rx:"1",key:"1ue0tg"}]]);function G(r,t){if(!t)return`<div class="loc"><div class="loc-title">${a(r)}</div><div class="muted">—</div></div>`;const d=[t.name,t.address_line1,t.address_line2,[t.city,t.state,t.postal_code].filter(Boolean).join(", "),t.contact_name?`Attn: ${t.contact_name}`:null,t.contact_phone].filter(c=>!!(c&&String(c).trim()));return`<div class="loc">
    <div class="loc-title">${a(r)}</div>
    ${d.map(c=>`<div>${a(c)}</div>`).join("")}
  </div>`}function v(r,t){const d=t==null||t===""?"—":String(t);return`<div class="meta"><div class="meta-l">${a(r)}</div><div class="meta-v">${a(d)}</div></div>`}function ue(r){switch(r){case"in_transit":return"IN TRANSIT";case"received":return"RECEIVED";case"draft":return"DRAFT";case"void":return"VOID";default:return r.toUpperCase()}}function ve(r){const{transfer:t,lines:d,fromLoc:c,toLoc:m,itemName:L}=r,j=d.reduce((l,p)=>l+Number(p.qty||0),0),R=d.some(l=>l.qty_received!==null&&l.qty_received!==void 0),g=`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>BOL ${a(t.bol_number??t.id.slice(0,8))}</title>
<style>
  @page { size: letter; margin: 0.6in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #111; margin: 0; font-size: 12px; line-height: 1.45; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1F4E79; padding-bottom: 10px; margin-bottom: 14px; }
  .head h1 { margin: 0; font-size: 22px; letter-spacing: 0.04em; color: #1F4E79; }
  .head .co { font-size: 12px; font-weight: 700; }
  .head .bol-no { text-align: right; }
  .head .bol-no .n { font-size: 18px; font-weight: 800; }
  .head .bol-no .s { font-size: 11px; font-weight: 700; color: #555; letter-spacing: 0.08em; }
  .locs { display: flex; gap: 16px; margin-bottom: 14px; }
  .loc { flex: 1; border: 1px solid #bbb; border-radius: 6px; padding: 10px 12px; }
  .loc-title { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #1F4E79; margin-bottom: 5px; }
  .metas { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 14px; border: 1px solid #bbb; border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; }
  .meta-l { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; color: #666; }
  .meta-v { font-size: 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; background: #eef2f7; color: #1F4E79; padding: 6px 8px; border: 1px solid #bbb; }
  td { padding: 6px 8px; border: 1px solid #ccc; }
  th.r, td.r { text-align: right; }
  tfoot td { font-weight: 800; background: #f6f7f9; }
  .muted { color: #777; }
  .notes { border: 1px solid #bbb; border-radius: 6px; padding: 8px 12px; margin-bottom: 14px; }
  .notes .t { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; color: #666; margin-bottom: 3px; }
  .sigs { display: flex; gap: 20px; margin-top: 22px; }
  .sig { flex: 1; }
  .sig .line { border-bottom: 1px solid #333; height: 34px; display: flex; align-items: flex-end; font-size: 13px; font-weight: 700; padding-bottom: 2px; }
  .sig .cap { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.07em; color: #666; margin-top: 3px; }
  .foot { margin-top: 18px; font-size: 9.5px; color: #888; text-align: center; }
</style>
</head>
<body>
  <div class="head">
    <div>
      <h1>BILL OF LADING</h1>
      <div class="co">Brix Beverage &middot; Alameda Point Beverage Group</div>
    </div>
    <div class="bol-no">
      <div class="s">BOL NUMBER</div>
      <div class="n">${a(t.bol_number??"—")}</div>
      <div class="s" style="margin-top:4px;">${a(ue(t.status))}</div>
    </div>
  </div>

  <div class="locs">
    ${G("Ship From",c)}
    ${G("Ship To",m)}
  </div>

  <div class="metas">
    ${v("Ship date",t.ship_date?q(t.ship_date):null)}
    ${v("Received date",t.received_date?q(t.received_date):null)}
    ${v("Carrier",t.carrier)}
    ${v("Freight terms",t.freight_terms)}
    ${v("Tracking #",t.tracking_number)}
    ${v("PRO #",t.pro_number)}
    ${v("Total weight (lbs)",t.total_weight_lbs)}
    ${v("Pallets",t.total_pallets)}
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:46%">Item</th>
        <th class="r">Qty shipped</th>
        <th class="r">Qty received</th>
        <th>Line notes</th>
      </tr>
    </thead>
    <tbody>
      ${d.map(l=>`<tr>
        <td>${a(L(l.qbo_item_id))}</td>
        <td class="r">${a(f(l.qty))}</td>
        <td class="r">${l.qty_received===null||l.qty_received===void 0?'<span class="muted">—</span>':a(f(l.qty_received))}</td>
        <td>${a(l.notes??"")}</td>
      </tr>`).join("")}
    </tbody>
    <tfoot>
      <tr>
        <td>Total</td>
        <td class="r">${a(f(j))}</td>
        <td class="r">${R?a(f(d.reduce((l,p)=>l+Number(p.qty_received??0),0))):"—"}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>

  ${t.special_instructions?`<div class="notes"><div class="t">Special instructions</div>${a(t.special_instructions)}</div>`:""}
  ${t.receiver_notes?`<div class="notes"><div class="t">Receiver notes</div>${a(t.receiver_notes)}</div>`:""}

  <div class="sigs">
    <div class="sig">
      <div class="line">${a(t.shipper_signature_name??"")}</div>
      <div class="cap">Shipper signature ${t.shipper_signature_name?"(recorded)":""}</div>
    </div>
    <div class="sig">
      <div class="line">${a(t.receiver_signature_name??"")}</div>
      <div class="cap">Receiver signature ${t.receiver_signature_name?"(recorded)":""}</div>
    </div>
  </div>

  <div class="foot">Generated by the Brix Distributor Portal &middot; ${a(new Date().toLocaleString())}</div>
  <script>window.addEventListener('load', function () { window.print(); });<\/script>
</body>
</html>`,x=window.open("","_blank");x&&(x.document.write(g),x.document.close())}const xe="id, code, name, kind, address_line1, address_line2, city, state, postal_code, contact_name, contact_phone";function _e(){const{id:r}=ee(),t=te(),{distributor:d}=se(),c=d?.inventory_location_id??null,{data:m,loading:L,error:j,reload:R}=ie(async()=>{if(!r)return null;const s=await y.from("inventory_transfers").select(pe).eq("id",r).maybeSingle();if(s.error)throw new Error(s.error.message);if(!s.data)return null;const n=s.data,o=await y.from("inventory_transfer_lines").select("id, transfer_id, qbo_item_id, qty, qty_received, notes").eq("transfer_id",r).order("created_at",{ascending:!0});let _;if(o.error){const h=await y.from("inventory_transfer_lines").select("id, transfer_id, qbo_item_id, qty, qty_received, notes").eq("transfer_id",r);if(h.error)throw new Error(h.error.message);_=h.data??[]}else _=o.data??[];const $=[n.from_location_id,n.to_location_id].filter(h=>!!h);let D=null,P=null;if($.length){const h=await y.from("inventory_locations").select(xe).in("id",$);if(!h.error){const M=h.data??[];D=M.find(z=>z.id===n.from_location_id)??null,P=M.find(z=>z.id===n.to_location_id)??null}}return{transfer:n,lines:_,fromLoc:D,toLoc:P}},[r]),g=ae((m?.lines??[]).map(s=>s.qbo_item_id)),[x,l]=u.useState({}),[p,U]=u.useState(""),[k,W]=u.useState(""),[B,J]=u.useState(Q()),[E,I]=u.useState(!1),[T,N]=u.useState(null),[Y,K]=u.useState(!1),w=u.useMemo(()=>m?.transfer?m.transfer.status==="in_transit"&&!!c&&m.transfer.to_location_id===c:!1,[m,c]);if(L)return e.jsx(re,{});if(j)return e.jsx(ne,{message:j});if(!m)return e.jsxs("div",{className:"glass-card",children:[e.jsx("p",{className:"empty-note",children:"Shipment not found (or not visible to your account)."}),e.jsxs("button",{type:"button",className:"btn btn-outline",onClick:()=>t("/shipments"),children:[e.jsx(H,{size:16})," Back to shipments"]})]});const{transfer:i,lines:b,fromLoc:A,toLoc:F}=m;function S(s){const n=x[s.id];if(n===void 0||n==="")return Number(s.qty);const o=Number(n);return Number.isNaN(o)?Number(s.qty):o}const X=b.some(s=>S(s)!==Number(s.qty)),O=b.some(s=>{const n=S(s);return n<0||n>Number(s.qty)});async function Z(){if(!r)return;if(!p.trim()){N("Type your full name as the receiving signature first.");return}if(O){N("Received quantities must be between 0 and the shipped quantity.");return}I(!0),N(null);const s=b.map(o=>({line_id:o.id,qty_received:S(o)})),{error:n}=await y.rpc("fn_distributor_receive_transfer",{p_transfer_id:r,p_received_date:B||Q(),p_receiver_signature_name:p.trim(),p_lines:s,p_receiver_notes:k.trim()||null});if(I(!1),n){N(n.message);return}K(!0),R()}return e.jsxs("div",{className:"stack",children:[e.jsxs("div",{className:"page-head",children:[e.jsxs("div",{children:[e.jsxs("button",{type:"button",className:"btn btn-ghost btn-sm",onClick:()=>t("/shipments"),style:{marginBottom:10,paddingLeft:0},children:[e.jsx(H,{size:15})," All shipments"]}),e.jsxs("h1",{style:{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"},children:["BOL ",i.bol_number??i.id.slice(0,8),e.jsx(le,{status:i.status}),i.has_discrepancy&&e.jsxs(de,{tone:"warning",children:[e.jsx(ce,{size:12})," Discrepancy"]})]})]}),e.jsxs("button",{type:"button",className:"btn btn-outline",onClick:()=>ve({transfer:i,lines:b,fromLoc:A,toLoc:F,itemName:g}),children:[e.jsx(he,{size:16})," Print BOL"]})]}),Y&&e.jsxs("div",{className:"callout callout-info",style:{margin:0},children:[e.jsx(V,{size:18}),e.jsxs("div",{children:[e.jsx("strong",{children:"Shipment received."})," Your on-hand inventory has been updated."]})]}),e.jsxs("div",{className:"glass-card",children:[e.jsx("h3",{style:{marginBottom:14},children:"Bill of lading"}),e.jsxs("div",{className:"def-grid",children:[e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Ship date"}),e.jsx("span",{className:"def-value",children:q(i.ship_date)})]}),e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Received date"}),e.jsx("span",{className:"def-value",children:q(i.received_date)})]}),e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Carrier"}),e.jsx("span",{className:"def-value",children:i.carrier??"—"})]}),e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Tracking #"}),e.jsx("span",{className:"def-value",children:i.tracking_number??"—"})]}),e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"PRO #"}),e.jsx("span",{className:"def-value",children:i.pro_number??"—"})]}),e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Freight terms"}),e.jsx("span",{className:"def-value",children:i.freight_terms??"—"})]}),e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Weight (lbs)"}),e.jsx("span",{className:"def-value",children:i.total_weight_lbs??"—"})]}),e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Pallets"}),e.jsx("span",{className:"def-value",children:i.total_pallets??"—"})]}),e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Ship from"}),e.jsx("span",{className:"def-value",children:A?.name??"—"})]}),e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Ship to"}),e.jsx("span",{className:"def-value",children:F?.name??"—"})]}),i.shipper_signature_name&&e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Shipper signature"}),e.jsx("span",{className:"def-value",children:i.shipper_signature_name})]}),i.receiver_signature_name&&e.jsxs("div",{children:[e.jsx("span",{className:"def-label",children:"Receiver signature"}),e.jsx("span",{className:"def-value",children:i.receiver_signature_name})]})]}),i.special_instructions&&e.jsx("div",{className:"callout callout-info",children:e.jsxs("div",{children:[e.jsx("strong",{children:"Special instructions:"})," ",i.special_instructions]})}),i.receiver_notes&&e.jsx("div",{className:"callout callout-info",children:e.jsxs("div",{children:[e.jsx("strong",{children:"Receiver notes:"})," ",i.receiver_notes]})})]}),e.jsxs("div",{className:"glass-card",children:[e.jsx("h3",{style:{marginBottom:12},children:"Items"}),e.jsx("div",{className:"tbl-wrap",children:e.jsxs("table",{className:"tbl",children:[e.jsx("thead",{children:e.jsxs("tr",{children:[e.jsx("th",{children:"Item"}),e.jsx("th",{className:"r",children:"Qty shipped"}),e.jsx("th",{className:"r",children:"Qty received"}),w&&e.jsx("th",{className:"r",children:"Receiving now"})]})}),e.jsx("tbody",{children:b.map(s=>{const n=S(s),o=w&&n!==Number(s.qty);return e.jsxs("tr",{children:[e.jsxs("td",{children:[g(s.qbo_item_id),s.notes&&e.jsx("div",{style:{fontSize:12,color:"var(--mt)"},children:s.notes})]}),e.jsx("td",{className:"r",children:f(s.qty)}),e.jsx("td",{className:"r",children:s.qty_received===null||s.qty_received===void 0?"—":f(s.qty_received)}),w&&e.jsx("td",{className:"r",children:e.jsx("input",{type:"number",className:"compact",min:0,max:Number(s.qty),step:"any",value:x[s.id]??String(s.qty),onChange:_=>l($=>({...$,[s.id]:_.target.value})),style:{width:96,textAlign:"right",borderColor:o?"var(--warning)":void 0},"aria-label":`Received quantity for ${g(s.qbo_item_id)}`})})]},s.id)})})]})})]}),w&&e.jsxs("div",{className:"glass-card",children:[e.jsx("h3",{style:{marginBottom:6},children:"Receive this shipment"}),e.jsx("p",{style:{margin:"0 0 12px",fontSize:14,color:"var(--tx2)"},children:"Count what actually arrived, adjust any line that differs, and sign with your typed name to confirm receipt."}),X&&e.jsxs(oe,{children:[e.jsx("strong",{children:"One or more lines differ from the BOL."})," That’s fine — record what you actually counted. Shortages are flagged to Brix Beverage automatically and resolved on our side."]}),e.jsxs("div",{className:"form-grid",style:{marginTop:12},children:[e.jsxs("div",{className:"field-col",children:[e.jsx("label",{className:"fld",htmlFor:"recv-date",children:"Received date"}),e.jsx("input",{id:"recv-date",type:"date",value:B,onChange:s=>J(s.target.value)})]}),e.jsxs("div",{className:"field-col",children:[e.jsx("label",{className:"fld",htmlFor:"recv-name",children:"Receiver signature (type your full name) *"}),e.jsx("input",{id:"recv-name",type:"text",placeholder:"Full name",value:p,onChange:s=>U(s.target.value)})]}),e.jsxs("div",{className:"field-col full",children:[e.jsx("label",{className:"fld",htmlFor:"recv-notes",children:"Notes (optional)"}),e.jsx("textarea",{id:"recv-notes",rows:2,placeholder:"Damage, shortages, anything worth noting…",value:k,onChange:s=>W(s.target.value)})]})]}),T&&e.jsx("div",{className:"err-note",children:T}),e.jsx("div",{style:{marginTop:14},children:e.jsxs("button",{type:"button",className:"btn btn-green",disabled:E||!p.trim()||O,onClick:Z,children:[E?e.jsx(me,{size:16,className:"spin"}):e.jsx(V,{size:16}),"Confirm receipt"]})})]})]})}export{_e as default};

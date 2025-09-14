// scripts/build.js
import fs from "fs/promises";
import { chromium } from "playwright";
import mapping from "../mapping.json" assert { type: "json" };

const NOW = () => new Date().toISOString();
const TOP_N = 5;
function toFloat(text){return parseFloat(String(text).replace(/\s+/g,"").replace(",",".").replace(/[^\d.]/g,""))||0}
function median(v){if(!v.length)return 0;const a=[...v].sort((x,y)=>x-y);const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function vwap(rows){const q=rows.reduce((s,r)=>s+(r.amount||0),0);const t=rows.reduce((s,r)=>s+r.unit_price_RUB*(r.amount||0),0);return q?t/q:0}

async function fetchTopOffers(page,url,minQty=0){
  await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
  await page.waitForTimeout(2500);
  const data=await page.evaluate(()=>{
    const table=document.querySelector("table");
    if(!table)return {headers:[],rows:[]};
    const headers=[...table.querySelectorAll("thead th")].map(th=>th.textContent.trim().toLowerCase());
    const priceIdx=headers.findIndex(h=>h.includes("цена"));
    const qtyIdx=headers.findIndex(h=>h.includes("налич")||h.includes("кол"));
    const rows=[...table.querySelectorAll("tbody tr")].map(tr=>{
      const tds=[...tr.querySelectorAll("td")].map(td=>td.textContent.trim());
      const linkEl=tr.querySelector("a[href]");
      return {priceText:tds[priceIdx]||"",qtyText:qtyIdx>=0?tds[qtyIdx]:"",link:linkEl?linkEl.href:null};
    });
    return {rows};
  });
  const offers=data.rows.map(r=>({
    amount: toFloat(r.qtyText),
    unit_price_RUB: toFloat(r.priceText),
    source:"funpay",
    link:r.link,
    ts: NOW()
  }))
  .filter(o=>o.unit_price_RUB>0 && o.amount>0 && o.amount>=minQty)
  .sort((a,b)=>a.unit_price_RUB-b.unit_price_RUB)
  .slice(0,TOP_N);
  const med=median(offers.map(o=>o.unit_price_RUB))||1;
  const filtered=offers.filter(o=>Math.abs(o.unit_price_RUB-med)/med<=0.25);
  return filtered.length?filtered:offers;
}

async function main(){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({locale:"ru-RU"});
  const page=await context.newPage();

  const out={updated_at:NOW(),source:"funpay",pairs:{}};

  for(const p of mapping.pairs){
    if(!p.funpay_url) continue;
    try{
      const top=await fetchTopOffers(page,p.funpay_url,p.min_qty||0);
      const price=vwap(top);
      out.pairs[p.key]={
        game:p.game,currency:p.currency,
        price_RUB:Number(price.toFixed(4)),
        change_24h:null,change_7d:null,
        updated_at:NOW(),
        trades_top5:top
      };
      console.log("OK:",p.key,top.length,price);
    }catch(e){ console.error("FAIL:",p.key,e.message); }
  }

  await fs.mkdir("dist",{recursive:true});
  await fs.writeFile("dist/rates.json",JSON.stringify(out,null,2),"utf-8");
  await browser.close();
}
main().catch(e=>{console.error(e);process.exit(1);});

// Creates a real funded job that is deliberately never delivered, so the refund path -- and the
// UI button that offers it -- can be exercised against genuine on-chain state rather than a mock.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createClient, BNB_TESTNET, createHeadlessPasskey } from "@altananetwork/sdk";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, formatUnits } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const COMMERCE_ABI = JSON.parse(readFileSync(resolve(__dirname, "agenticCommerce.abi.json"), "utf-8"));
const ROUTER_ABI = JSON.parse(readFileSync(resolve(__dirname, "evaluatorRouter.abi.json"), "utf-8"));
const COMMERCE="0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de", ROUTER="0xd7d36d66d2f1b608a0f943f722d27e3744f66f25";
const POLICY="0xd6a4217588f6b1f5657a92a3e94e6422ad771cea", U="0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const FAUCET="0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3", VEYRA="0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const EXPIRY = 660;
const ERC20=[{type:"function",name:"approve",stateMutability:"nonpayable",inputs:[{name:"s",type:"address"},{name:"v",type:"uint256"}],outputs:[{type:"bool"}]},
             {type:"function",name:"balanceOf",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]}];
const FAUCET_ABI=[{type:"function",name:"requestTokens",stateMutability:"nonpayable",inputs:[],outputs:[]}];
const pub=createPublicClient({transport:http(RPC,{timeout:60000,retryCount:5})});
const client=createClient({chains:[BNB_TESTNET]});
const call=(to,abi,fn,args)=>({to,data:encodeFunctionData({abi,functionName:fn,args})});
async function exec(o,label){for(let a=1;;a++){try{const r=await client.execute(o);await new Promise(x=>setTimeout(x,6000));return r;}catch(e){const t=`${e.message??""}${JSON.stringify(e?.cause??"")}`;if(!t.includes("InvalidNonce")||a>=4)throw e;console.log(`  [${label}] InvalidNonce retry ${a}`);await new Promise(x=>setTimeout(x,8000*a));}}}

const signer=createHeadlessPasskey();
const wallet=await client.createWallet({signer});
console.log("wallet:", wallet.address);
execFileSync(process.execPath,[resolve(__dirname,"fundTestWallet.mjs"),wallet.address,"0.006","--from=operator"],{stdio:"inherit"});
await exec({wallet,signer,calls:[call(FAUCET,FAUCET_ABI,"requestTokens",[])]},"faucet");
const bal=await pub.readContract({address:U,abi:ERC20,functionName:"balanceOf",args:[wallet.address]});
const BUDGET=bal/10n;
console.log(`\n$U: ${formatUnits(bal,18)}, budget ${formatUnits(BUDGET,18)}`);

const expiredAt=BigInt(Math.floor(Date.now()/1000)+EXPIRY);
const c=await exec({wallet,signer,calls:[
  call(COMMERCE,COMMERCE_ABI,"createJob",[VEYRA,ROUTER,expiredAt,"VEYRA · Rebalancing (refund test)",ROUTER]),
  call(U,ERC20,"approve",[COMMERCE,BUDGET])]},"create");
const rc=await pub.getTransactionReceipt({hash:c.transactionHash});
let jobId;
for(const l of rc.logs){if(l.address.toLowerCase()!==COMMERCE.toLowerCase())continue;
  try{const d=decodeEventLog({abi:COMMERCE_ABI,eventName:"JobCreated",data:l.data,topics:l.topics});if(d.args?.jobId!==undefined){jobId=d.args.jobId;break;}}catch{}}
await exec({wallet,signer,calls:[
  call(ROUTER,ROUTER_ABI,"registerJob",[jobId,POLICY]),
  call(COMMERCE,COMMERCE_ABI,"setBudget",[jobId,BUDGET,"0x"]),
  call(COMMERCE,COMMERCE_ABI,"fund",[jobId,BUDGET,"0x"])]},"fund");

console.log(`\nREFUNDABLE JOB CREATED: #${jobId}`);
console.log(`  expires at ${new Date(Number(expiredAt)*1000).toISOString()} (${EXPIRY}s)`);
console.log(`  client ${wallet.address}`);
console.log(`  it will NEVER be delivered -- that is the point.`);

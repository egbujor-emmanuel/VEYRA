// Exercises the dispute branch of ERC-8183 settlement as far as this project legitimately can.
//
// The honest boundary, established on-chain before writing this: OptimisticPolicy.voteReject()
// is restricted to operator-granted voters. The policy has 2 active voters, a quorum of 1, and an
// admin of 0x1001b2C085345f388778A975648aA50bcfd0D134 -- BNB's own operator, not us. isVoter()
// returns false for VEYRA and addVoter() is admin-only. So a dispute can be RAISED by us but
// cannot be RESOLVED by us. This script proves the half we control and stops honestly at the
// half we do not, rather than simulating a rejection we cannot actually cause.
//
// Sequence:
//   1. a client hires VEYRA and funds the job
//   2. VEYRA submits a deliverable            -> Submitted, dispute window opens
//   3. the CLIENT disputes within that window -> disputed(jobId) == true
//   4. stop: resolution needs a voter we are not

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createClient, BNB_TESTNET, createHeadlessPasskey } from "@altananetwork/sdk";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, keccak256, toHex, formatUnits } from "viem";
import { createSigner } from "@veyra/chain/txSigner";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const COMMERCE="0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de", ROUTER="0xd7d36d66d2f1b608a0f943f722d27e3744f66f25";
const POLICY="0xd6a4217588f6b1f5657a92a3e94e6422ad771cea", U="0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const FAUCET="0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3", VEYRA="0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const CA=JSON.parse(readFileSync(resolve(__dirname,"agenticCommerce.abi.json"),"utf-8"));
const RA=JSON.parse(readFileSync(resolve(__dirname,"evaluatorRouter.abi.json"),"utf-8"));
const PA=JSON.parse(readFileSync(resolve(__dirname,"optimisticPolicy.abi.json"),"utf-8"));
const ERC20=[{type:"function",name:"approve",stateMutability:"nonpayable",inputs:[{name:"s",type:"address"},{name:"v",type:"uint256"}],outputs:[{type:"bool"}]},
             {type:"function",name:"balanceOf",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]}];
const FAUCET_ABI=[{type:"function",name:"requestTokens",stateMutability:"nonpayable",inputs:[],outputs:[]}];
const STATUS=["Open","Funded","Submitted","Completed","Rejected","Expired"];

const pub=createPublicClient({chain:{id:CHAIN_ID,name:"bsc-testnet",nativeCurrency:{name:"tBNB",symbol:"tBNB",decimals:18},rpcUrls:{default:{http:[RPC]}}},transport:http(RPC,{timeout:60000,retryCount:5})});
const client=createClient({chains:[BNB_TESTNET]});
const call=(to,abi,fn,args)=>({to,data:encodeFunctionData({abi,functionName:fn,args})});
const results=[]; const rec=(n,p,d)=>{results.push({n,p});console.log(`${p?"PASS":"FAIL"}  ${n}${d?` :: ${d}`:""}`);};
async function exec(o,label){for(let a=1;;a++){try{const r=await client.execute(o);await new Promise(x=>setTimeout(x,6000));return r;}catch(e){const t=`${e.message??""}${JSON.stringify(e?.cause??"")}`;if(!t.includes("InvalidNonce")||a>=4)throw e;console.log(`  [${label}] InvalidNonce retry ${a}`);await new Promise(x=>setTimeout(x,8000*a));}}}
function pwd(){for(const l of readFileSync(resolve(REPO,"smoketest/.studio/.env.local"),"utf-8").split(/\r?\n/)){const t=l.trim();if(t.startsWith("WALLET_PASSWORD="))return t.slice(16);}throw new Error("no password");}

console.log("=== 0. a client hires VEYRA ===");
const signer=createHeadlessPasskey();
const wallet=await client.createWallet({signer});
console.log(`client wallet: ${wallet.address}`);
execFileSync(process.execPath,[resolve(__dirname,"fundTestWallet.mjs"),wallet.address,"0.006","--from=operator"],{stdio:"inherit"});
await exec({wallet,signer,calls:[call(FAUCET,FAUCET_ABI,"requestTokens",[])]},"faucet");
const BUDGET=(await pub.readContract({address:U,abi:ERC20,functionName:"balanceOf",args:[wallet.address]}))/10n;

const expiredAt=BigInt(Math.floor(Date.now()/1000)+3600);
const c=await exec({wallet,signer,calls:[
  call(COMMERCE,CA,"createJob",[VEYRA,ROUTER,expiredAt,"VEYRA · Rebalancing (dispute test)",ROUTER]),
  call(U,ERC20,"approve",[COMMERCE,BUDGET])]},"create");
let jobId;
for(const l of (await pub.getTransactionReceipt({hash:c.transactionHash})).logs){
  if(l.address.toLowerCase()!==COMMERCE.toLowerCase())continue;
  try{const d=decodeEventLog({abi:CA,eventName:"JobCreated",data:l.data,topics:l.topics});if(d.args?.jobId!==undefined){jobId=d.args.jobId;break;}}catch{}}
await exec({wallet,signer,calls:[
  call(ROUTER,RA,"registerJob",[jobId,POLICY]),
  call(COMMERCE,CA,"setBudget",[jobId,BUDGET,"0x"]),
  call(COMMERCE,CA,"fund",[jobId,BUDGET,"0x"])]},"fund");
rec("job created and funded", true, `#${jobId}, ${formatUnits(BUDGET,18)} $U`);

console.log("\n=== 1. VEYRA submits a deliverable ===");
const { EVMWalletProvider } = await import("@bnbagent/sdk");
const veyraSigner=createSigner(pub,new EVMWalletProvider({password:pwd(),address:VEYRA,walletsDir:resolve(REPO,"smoketest/.studio/wallets"),persist:true}),CHAIN_ID);
const deliverable=keccak256(toHex(`veyra-dispute-test-${jobId}`));
await veyraSigner.sendAndWait("submit",COMMERCE,encodeFunctionData({abi:CA,functionName:"submit",args:[jobId,deliverable,"0x"]}));
let job=await pub.readContract({address:COMMERCE,abi:CA,functionName:"jobs",args:[jobId]});
rec("job reaches Submitted", Number(job[7])===2, `status ${job[7]} (${STATUS[Number(job[7])]})`);

console.log("\n=== 2. the CLIENT disputes it, inside the window ===");
const before=await pub.readContract({address:POLICY,abi:PA,functionName:"disputed",args:[jobId]});
try {
  await exec({wallet,signer,calls:[call(POLICY,PA,"dispute",[jobId])]},"dispute");
} catch (e) {
  console.log("  dispute threw:", (e.shortMessage ?? e.message).slice(0,160));
}
const after=await pub.readContract({address:POLICY,abi:PA,functionName:"disputed",args:[jobId]});
rec("client can raise a dispute", before===false && after===true, `disputed: ${before} -> ${after}`);
console.log(`  quorum snapshot: ${await pub.readContract({address:POLICY,abi:PA,functionName:"disputeQuorumSnapshot",args:[jobId]})}`);
console.log(`  reject votes so far: ${await pub.readContract({address:POLICY,abi:PA,functionName:"rejectVotes",args:[jobId]})}`);

console.log("\n=== 3. resolution is NOT ours to perform ===");
const isVoter=await pub.readContract({address:POLICY,abi:PA,functionName:"isVoter",args:[VEYRA]});
const admin=await pub.readContract({address:POLICY,abi:PA,functionName:"admin"});
console.log(`  isVoter(VEYRA)=${isVoter}, policy admin=${admin}`);
console.log("  voteReject() is restricted to operator-granted voters. We are not one, and cannot");
console.log("  become one -- addVoter() is admin-only and the admin is BNB's operator.");
console.log("  Stopping here rather than claiming a rejection outcome we cannot produce.");

job=await pub.readContract({address:COMMERCE,abi:CA,functionName:"jobs",args:[jobId]});
console.log(`\nfinal job #${jobId} status: ${job[7]} (${STATUS[Number(job[7])]}), disputed=${after}`);
console.log("\n================ SUMMARY ================");
for(const r of results) console.log(`${r.p?"PASS":"FAIL"}  ${r.n}`);
process.exit(results.some(r=>!r.p)?1:0);

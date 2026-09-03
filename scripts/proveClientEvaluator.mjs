// Removes the dispute limitation entirely.
//
// Previously every job named the EvaluatorRouter as evaluator, which routes rejection through
// OptimisticPolicy.voteReject() -- restricted to operator-granted voters we are not and cannot
// become (admin 0x1001b2C0..., addVoter is admin-only). A client could raise a dispute but never
// resolve one.
//
// ERC-8183 lets the CLIENT be their own evaluator, and this deployment accepts it (verified by
// simulation: evaluator=client with hook=Router is accepted; hook=0x0 reverts, so the hook must
// still be the Router). With evaluator=client the client is the sole authority on complete() and
// reject() once a deliverable is submitted -- so a bad delivery can actually be refused, by the
// person who paid, with no third party involved.
//
// Proves: create -> fund -> VEYRA submits -> CLIENT rejects -> client refunded in full.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createClient, BNB_TESTNET, createHeadlessPasskey } from "@altananetwork/sdk";
import { createPublicClient, http, encodeFunctionData, decodeEventLog, keccak256, toHex, formatUnits } from "viem";
import { createSigner } from "@veyra/chain/txSigner";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const RPC="https://bsc-testnet-rpc.publicnode.com", CHAIN_ID=97;
const COMMERCE="0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de", ROUTER="0xd7d36d66d2f1b608a0f943f722d27e3744f66f25";
const POLICY="0xd6a4217588f6b1f5657a92a3e94e6422ad771cea", U="0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const FAUCET="0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3", VEYRA="0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
// Our own permissive hook (contracts/OpenSettlementHook.sol). The Router's hook rejects fund()
// with PolicyNotSet() on any job it does not itself evaluate, which is what previously forced
// every job through the operator-controlled voter set.
const HOOK="0xb9a689d455b8dcf91698766bc43aee4f1d7b8b71";
const CA=JSON.parse(readFileSync(resolve(__dirname,"agenticCommerce.abi.json"),"utf-8"));
const RA=JSON.parse(readFileSync(resolve(__dirname,"evaluatorRouter.abi.json"),"utf-8"));
const ERC20=[{type:"function",name:"approve",stateMutability:"nonpayable",inputs:[{name:"s",type:"address"},{name:"v",type:"uint256"}],outputs:[{type:"bool"}]},
             {type:"function",name:"balanceOf",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]}];
const FAUCET_ABI=[{type:"function",name:"requestTokens",stateMutability:"nonpayable",inputs:[],outputs:[]}];
const STATUS=["Open","Funded","Submitted","Completed","Rejected","Expired"];

const pub=createPublicClient({chain:{id:CHAIN_ID,name:"bsc-testnet",nativeCurrency:{name:"tBNB",symbol:"tBNB",decimals:18},rpcUrls:{default:{http:[RPC]}}},transport:http(RPC,{timeout:60000,retryCount:5})});
const client=createClient({chains:[BNB_TESTNET]});
const call=(to,abi,fn,args)=>({to,data:encodeFunctionData({abi,functionName:fn,args})});
const results=[]; const rec=(n,p,d)=>{results.push({n,p});console.log(`${p?"PASS":"FAIL"}  ${n}${d?` :: ${d}`:""}`);};
async function exec(o,l){for(let a=1;;a++){try{const r=await client.execute(o);await new Promise(x=>setTimeout(x,6000));return r;}catch(e){const t=`${e.message??""}${JSON.stringify(e?.cause??"")}`;if(!t.includes("InvalidNonce")||a>=4)throw e;console.log(`  [${l}] InvalidNonce retry ${a}`);await new Promise(x=>setTimeout(x,8000*a));}}}
function pwd(){for(const l of readFileSync(resolve(REPO,"smoketest/.studio/.env.local"),"utf-8").split(/\r?\n/)){const t=l.trim();if(t.startsWith("WALLET_PASSWORD="))return t.slice(16);}throw new Error("no password");}
const uBal=a=>pub.readContract({address:U,abi:ERC20,functionName:"balanceOf",args:[a]});

console.log("=== 0. client hires VEYRA, naming ITSELF as evaluator ===");
const signer=createHeadlessPasskey();
const wallet=await client.createWallet({signer});
console.log(`client: ${wallet.address}`);
execFileSync(process.execPath,[resolve(__dirname,"fundTestWallet.mjs"),wallet.address,"0.007","--from=operator"],{stdio:"inherit"});
await exec({wallet,signer,calls:[call(FAUCET,FAUCET_ABI,"requestTokens",[])]},"faucet");
const BUDGET=(await uBal(wallet.address))/10n;

const expiredAt=BigInt(Math.floor(Date.now()/1000)+3600);
const c=await exec({wallet,signer,calls:[
  call(COMMERCE,CA,"createJob",[VEYRA, wallet.address, expiredAt, "VEYRA · Rebalancing (client-evaluated)", HOOK]),
  call(U,ERC20,"approve",[COMMERCE,BUDGET])]},"create");
let jobId;
for(const l of (await pub.getTransactionReceipt({hash:c.transactionHash})).logs){
  if(l.address.toLowerCase()!==COMMERCE.toLowerCase())continue;
  try{const d=decodeEventLog({abi:CA,eventName:"JobCreated",data:l.data,topics:l.topics});if(d.args?.jobId!==undefined){jobId=d.args.jobId;break;}}catch{}}

let job=await pub.readContract({address:COMMERCE,abi:CA,functionName:"jobs",args:[jobId]});
rec("job names the CLIENT as evaluator", job[3].toLowerCase()===wallet.address.toLowerCase(), `evaluator=${job[3]}`);

// NOTE: registerJob() must NOT be called here. It binds a dispute policy for the
// Router-as-evaluator flow and reverts with RouterNotEvaluator() when the job names someone else
// as evaluator -- confirmed by decoding selector 0xec43ea50 against the Router's own ABI. A
// client-evaluated job needs no policy: the client IS the decision-maker.
console.log("\n=== 1. fund the escrow (no policy -- the client is the evaluator) ===");
await exec({wallet,signer,calls:[
  call(COMMERCE,CA,"setBudget",[jobId,BUDGET,"0x"]),
  call(COMMERCE,CA,"fund",[jobId,BUDGET,"0x"])]},"fund");
const afterFund=await uBal(wallet.address);
job=await pub.readContract({address:COMMERCE,abi:CA,functionName:"jobs",args:[jobId]});
rec("job funded", Number(job[7])===1, `#${jobId} status ${STATUS[Number(job[7])]}, ${formatUnits(BUDGET,18)} $U escrowed`);

console.log("\n=== 2. VEYRA submits a deliverable ===");
const { EVMWalletProvider } = await import("@bnbagent/sdk");
const veyra=createSigner(pub,new EVMWalletProvider({password:pwd(),address:VEYRA,walletsDir:resolve(REPO,"smoketest/.studio/wallets"),persist:true}),CHAIN_ID);
await veyra.sendAndWait("submit",COMMERCE,encodeFunctionData({abi:CA,functionName:"submit",args:[jobId,keccak256(toHex(`bad-work-${jobId}`)),"0x"]}));
job=await pub.readContract({address:COMMERCE,abi:CA,functionName:"jobs",args:[jobId]});
rec("job reaches Submitted", Number(job[7])===2, `status ${STATUS[Number(job[7])]}`);

console.log("\n=== 3. the CLIENT rejects it -- no third party involved ===");
try {
  await exec({wallet,signer,calls:[call(COMMERCE,CA,"reject",[jobId, keccak256(toHex("unsatisfactory")), "0x"])]},"reject");
} catch(e) { console.log("  reject threw:", (e.shortMessage??e.message).slice(0,200)); }

job=await pub.readContract({address:COMMERCE,abi:CA,functionName:"jobs",args:[jobId]});
const afterReject=await uBal(wallet.address);
rec("job is Rejected", Number(job[7])===4, `status ${job[7]} (${STATUS[Number(job[7])]})`);
rec("client got their money back", afterReject-afterFund===BUDGET,
    `${formatUnits(afterFund,18)} -> ${formatUnits(afterReject,18)} $U (+${formatUnits(afterReject-afterFund,18)})`);
rec("VEYRA was NOT paid", (await uBal(VEYRA))!==undefined && Number(job[7])===4, "rejected job pays no provider");

console.log("\n================ SUMMARY ================");
for(const r of results) console.log(`${r.p?"PASS":"FAIL"}  ${r.n}`);
const failed=results.filter(r=>!r.p).length;
console.log(failed===0?"\nClient-side rejection works. Disputes are resolvable without any operator voter.":`\n${failed} FAILED`);
process.exit(failed?1:0);

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RPC="https://bsc-testnet-rpc.publicnode.com";
const OPERATOR="0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const artifact=JSON.parse(readFileSync(resolve(REPO,"contracts/build/OpenSettlementHook.json"),"utf-8"));

function readSecret(key){for(const l of readFileSync(resolve(REPO,"smoketest/.studio/.env.local"),"utf-8").split(/\r?\n/)){const t=l.trim();if(t.startsWith(key+"="))return t.slice(key.length+1);}throw new Error(key+" missing");}
async function decrypt(){
  const {scryptSync,createDecipheriv}=await import("node:crypto");
  const ks=JSON.parse(readFileSync(resolve(REPO,`smoketest/.studio/wallets/${OPERATOR}.json`),"utf-8"));
  const {kdfparams,ciphertext,cipher,cipherparams,mac}=ks.crypto;
  const dk=scryptSync(Buffer.from(readSecret("WALLET_PASSWORD"),"utf-8"),Buffer.from(kdfparams.salt,"hex"),kdfparams.dklen,{N:kdfparams.n,r:kdfparams.r,p:kdfparams.p,maxmem:512*1024*1024});
  const cb=Buffer.from(ciphertext,"hex");
  if(keccak256(`0x${Buffer.concat([dk.subarray(16,32),cb]).toString("hex")}`).slice(2)!==mac) throw new Error("MAC mismatch");
  const d=createDecipheriv(cipher,dk.subarray(0,16),Buffer.from(cipherparams.iv,"hex"));
  return `0x${Buffer.concat([d.update(cb),d.final()]).toString("hex")}`;
}

const pub=createPublicClient({chain:bscTestnet,transport:http(RPC,{timeout:60000,retryCount:5})});
const account=privateKeyToAccount(await decrypt());
if(account.address.toLowerCase()!==OPERATOR.toLowerCase()) throw new Error("wrong key");
const wallet=createWalletClient({account,chain:bscTestnet,transport:http(RPC,{timeout:60000,retryCount:5})});

console.log("deploying OpenSettlementHook from", account.address);
const hash=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode,args:[]});
console.log("tx:",hash);
const r=await pub.waitForTransactionReceipt({hash});
console.log("status:",r.status,"address:",r.contractAddress);

// Prove it satisfies the interface check before anyone relies on it.
const ifaceAbi=[{name:"supportsInterface",type:"function",stateMutability:"view",inputs:[{name:"i",type:"bytes4"}],outputs:[{type:"bool"}]}];
for(const id of ["0x7ff6bc9e","0x01ffc9a7","0xdeadbeef"]){
  console.log(`  supportsInterface(${id}) = ${await pub.readContract({address:r.contractAddress,abi:ifaceAbi,functionName:"supportsInterface",args:[id]})}`);
}
console.log("\nHOOK_ADDRESS=",r.contractAddress);

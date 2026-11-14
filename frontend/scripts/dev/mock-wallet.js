// Injected mock EIP-1193 wallet for browser checks (no real wallet): cat it before another eval (e.g. overlay-audit.js). window.__setChain("0x1") simulates a wrong network.
{
const sleep=(m)=>new Promise(r=>setTimeout(r,m)); const acct='0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; let chain='0x66eee'; const L={};
window.ethereum={isMock:true,request:async({method,params})=>{switch(method){case'eth_requestAccounts':case'eth_accounts':return[acct];case'eth_chainId':return chain;case'wallet_switchEthereumChain':chain=params[0].chainId;(L.chainChanged||[]).forEach(f=>f(chain));return null;case'wallet_addEthereumChain':return null;default:throw new Error('unsupported '+method)}},on:(e,f)=>{(L[e]=L[e]||[]).push(f)},removeListener:(e,f)=>{L[e]=(L[e]||[]).filter(x=>x!==f)}};
window.__setChain=(c)=>{chain=c;(L.chainChanged||[]).forEach(f=>f(c))};
document.getElementById('connect-btn')?.click(); await sleep(400);
[...document.querySelectorAll('[role=menuitem],button')].find(b=>/Browser wallet/.test(b.textContent))?.click(); await sleep(2500);
}

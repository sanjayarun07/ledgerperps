const out=[];const vw=innerWidth;
if(document.documentElement.scrollWidth>vw+1&&!document.querySelector('.tview[hidden]'))out.push('page h-scroll '+document.documentElement.scrollWidth);
for(const e of document.querySelectorAll('button,.btn,.seg,.stat,.kv,.chipbtn,.tab,.navtab')){const r=e.getBoundingClientRect();if(!r.width)continue;if(r.right>vw+1||r.left<-1)out.push('offscreen '+(e.className||e.tagName)+' '+Math.round(r.left)+'-'+Math.round(r.right));if(e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflow!=='visible'&&!e.closest('.mbar,.chart-tools,.docktabs'))out.push('clipped '+(e.className||e.tagName)+' "'+e.textContent.trim().slice(0,30)+'"');}
const a=document.querySelector('.acct-card');if(a){const r=a.getBoundingClientRect();out.push('account overview '+(r.top>=0&&r.bottom<=innerHeight?'FULLY VISIBLE':'NOT visible')+' top '+Math.round(r.top)+' bottom '+Math.round(r.bottom)+' vh '+innerHeight);}
return out.join('\n')||'clean';

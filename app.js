const $=s=>document.querySelector(s);
const dbKey='shuangfa_vendor_payments_v2';
let payments=JSON.parse(localStorage.getItem(dbKey)||'[]');
let signatureData='',invoicePhotos=[],checkPhotoData='',hasInk=false;

function money(n){return new Intl.NumberFormat('zh-TW',{style:'currency',currency:'TWD',maximumFractionDigits:0}).format(Number(n||0))}
function saveDB(){localStorage.setItem(dbKey,JSON.stringify(payments));render()}
function render(){
 const now=new Date(),ym=now.toISOString().slice(0,7);
 $('#monthTotal').textContent=money(payments.filter(p=>p.createdAt.slice(0,7)===ym).reduce((s,p)=>s+p.net,0));
 $('#pendingSign').textContent=payments.filter(p=>!p.signature).length;
 $('#completed').textContent=payments.filter(p=>p.status==='已簽收').length;
 const soon=payments.filter(p=>{if(!p.dueDate||p.status==='已完成')return false;const d=(new Date(p.dueDate+'T23:59:59')-now)/86400000;return d>=0&&d<=7});
 $('#dueSoon').textContent=soon.length;
 $('#dueList').className='list'+(soon.length?'':' empty');
 $('#dueList').innerHTML=soon.length?soon.map(p=>`<div class="payment-item"><div class="payment-top"><div><h3>${p.vendor}</h3><div class="meta">票號：${p.checkNo||'未填'}<br>到期日：${p.dueDate}</div></div><div class="amount">${money(p.net)}</div></div></div>`).join(''):'目前沒有即將到期的支票';
 const q=$('#searchInput').value.trim().toLowerCase();
 const list=payments.filter(p=>[p.vendor,p.checkNo,p.month,p.collector].join(' ').toLowerCase().includes(q));
 $('#paymentList').className='list'+(list.length?'':' empty');
 $('#paymentList').innerHTML=list.length?list.slice().reverse().map(p=>`<div class="payment-item"><div class="payment-top"><div><h3>${p.vendor}</h3><div class="meta">收款月份：${p.month}<br>票號：${p.checkNo||'—'}｜到期：${p.dueDate||'—'}<br>扣款：${money(p.deductionTotal)}</div><span class="badge signed">已手寫簽收</span></div><div class="amount">${money(p.net)}</div></div></div>`).join(''):'尚無資料';
}
function addDeduction(){const node=$('#deductionTemplate').content.cloneNode(true),row=node.querySelector('.deduction-row');row.querySelectorAll('input').forEach(i=>i.addEventListener('input',calc));row.querySelector('.remove-row').onclick=()=>{row.remove();calc()};$('#deductionRows').appendChild(node)}
function calc(){const g=Number($('#grossAmount').value||0),a=Number($('#adjustmentAmount').value||0),d=[...document.querySelectorAll('.deduction-amount')].reduce((s,i)=>s+Number(i.value||0),0);$('#grossDisplay').textContent=money(g);$('#deductionDisplay').textContent=money(d);$('#netDisplay').textContent=money(g+a-d)}
function resetForm(){$('#paymentForm').reset();$('#paymentMonth').value=new Date().toISOString().slice(0,7);$('#deductionRows').innerHTML='';addDeduction();signatureData='';checkPhotoData='';invoicePhotos=[];hasInk=false;$('#checkPreview').src='';$('#invoicePreview').innerHTML='';$('#signStatus').textContent='尚未簽名';$('#ocrText').value='';$('#ocrStatus').textContent='尚未辨識';calc()}
$('#newPaymentBtn').onclick=()=>{resetForm();$('#paymentDialog').showModal()}
$('#closeDialog').onclick=()=>$('#paymentDialog').close()
$('#addDeductionBtn').onclick=addDeduction
$('#grossAmount').addEventListener('input',calc);$('#adjustmentAmount').addEventListener('input',calc);$('#searchInput').addEventListener('input',render)
function fileToData(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file)})}
$('#checkPhoto').onchange=async e=>{if(e.target.files[0]){checkPhotoData=await fileToData(e.target.files[0]);$('#checkPreview').src=checkPhotoData;$('#ocrStatus').textContent='照片已選擇，可按「辨識支票文字」'}}
$('#invoicePhoto').onchange=async e=>{invoicePhotos=await Promise.all([...e.target.files].map(fileToData));$('#invoicePreview').innerHTML=invoicePhotos.map(x=>`<img src="${x}">`).join('')}

$('#ocrBtn').onclick=async()=>{
 if(!checkPhotoData){alert('請先拍攝或選擇支票照片');return}
 if(!window.Tesseract){alert('辨識元件尚未載入，請確認網路後重新整理');return}
 $('#ocrBtn').disabled=true;$('#ocrStatus').textContent='正在辨識，請稍候…';
 try{
   const result=await Tesseract.recognize(checkPhotoData,'eng+chi_tra',{logger:m=>{if(m.progress)$('#ocrStatus').textContent=`辨識中 ${Math.round(m.progress*100)}%`}});
   const text=result.data.text||'';$('#ocrText').value=text;$('#ocrStatus').textContent='辨識完成，請人工核對';
   const nums=(text.match(/\b\d{6,14}\b/g)||[]);
   if(nums.length&&!$('#checkNo').value)$('#checkNo').value=nums[0];
   const dateMatch=text.match(/(20\d{2})[\/\-.年]\s*(\d{1,2})[\/\-.月]\s*(\d{1,2})/);
   if(dateMatch&&!$('#dueDate').value)$('#dueDate').value=`${dateMatch[1]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[3]).padStart(2,'0')}`;
   const moneyMatches=[...(text.matchAll(/(?:NT\$|\$)?\s*([\d,]{4,})/g))].map(m=>Number(m[1].replace(/,/g,''))).filter(n=>n>0&&n<100000000);
   if(moneyMatches.length&&Number($('#grossAmount').value||0)===0){$('#grossAmount').value=Math.max(...moneyMatches);calc()}
 }catch(err){console.error(err);$('#ocrStatus').textContent='辨識失敗，請換較清楚的照片再試';alert('支票辨識失敗，請確認照片清楚、光線充足並保持網路連線')}
 finally{$('#ocrBtn').disabled=false}
}

const screen=$('#signatureScreen'),canvas=$('#signatureCanvas'),ctx=canvas.getContext('2d');
let drawing=false,last=null;
function sizeCanvas(){
 const rect=canvas.getBoundingClientRect(),ratio=Math.max(1,window.devicePixelRatio||1);
 canvas.width=Math.round(rect.width*ratio);canvas.height=Math.round(rect.height*ratio);
 ctx.setTransform(ratio,0,0,ratio,0,0);ctx.lineWidth=3;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#111';hasInk=false;
}
function getPoint(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
canvas.addEventListener('pointerdown',e=>{drawing=true;hasInk=true;last=getPoint(e);canvas.setPointerCapture(e.pointerId);ctx.beginPath();ctx.moveTo(last.x,last.y);e.preventDefault()})
canvas.addEventListener('pointermove',e=>{if(!drawing)return;const p=getPoint(e);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;e.preventDefault()})
function finish(e){if(!drawing)return;drawing=false;try{canvas.releasePointerCapture(e.pointerId)}catch{}}
canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',finish);canvas.addEventListener('pointerleave',finish)
$('#openSignatureBtn').onclick=()=>{screen.classList.remove('hidden');requestAnimationFrame(()=>requestAnimationFrame(sizeCanvas))}
$('#exitSignature').onclick=()=>screen.classList.add('hidden')
$('#clearSignature').onclick=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);hasInk=false;signatureData=''}
$('#confirmSignature').onclick=()=>{if(!hasInk){alert('簽名區目前是空白，請先簽名');return}signatureData=canvas.toDataURL('image/png');$('#signStatus').textContent='已完成廠商手寫簽名';screen.classList.add('hidden')}

$('#paymentForm').addEventListener('submit',e=>{
 e.preventDefault();
 const rows=[...document.querySelectorAll('.deduction-row')].map(r=>({name:r.querySelector('.deduction-name').value.trim(),note:r.querySelector('.deduction-note').value.trim(),amount:Number(r.querySelector('.deduction-amount').value||0)})).filter(x=>x.name||x.note||x.amount);
 const gross=Number($('#grossAmount').value||0),adj=Number($('#adjustmentAmount').value||0),deductionTotal=rows.reduce((s,x)=>s+x.amount,0),net=gross+adj-deductionTotal;
 if(!signatureData){alert('請先讓廠商完成手寫簽名');return}
 payments.push({id:(crypto.randomUUID?crypto.randomUUID():Date.now().toString()),createdAt:new Date().toISOString(),vendor:$('#vendorName').value.trim(),month:$('#paymentMonth').value,collector:$('#collectorName').value.trim(),method:$('#paymentMethod').value,checkNo:$('#checkNo').value.trim(),dueDate:$('#dueDate').value,gross,adjustment:adj,deductions:rows,deductionTotal,net,checkPhoto:checkPhotoData,invoicePhotos,ocrText:$('#ocrText').value,notes:$('#notes').value.trim(),signature:signatureData,status:'已簽收'});
 saveDB();$('#paymentDialog').close();alert('付款簽收單已儲存');
});
$('#exportBtn').onclick=()=>{const blob=new Blob([JSON.stringify({version:2,exportedAt:new Date().toISOString(),payments},null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`雙發付款簽收備份_${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
$('#importInput').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const data=JSON.parse(await file.text());if(!Array.isArray(data.payments))throw new Error();payments=data.payments;saveDB();alert('備份匯入完成')}catch{alert('備份檔格式不正確')}}
render();